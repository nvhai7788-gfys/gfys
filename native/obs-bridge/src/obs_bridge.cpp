/*
 * obs_bridge.cpp —— libobs 真引擎原生桥接（N-API）
 *
 * 把港丰影视直播工作台的 OBS 场景/来源/变换数据模型，镜像进 libobs（OBS Studio 引擎），
 * 并提供：引擎生命周期、场景图镜像、设备枚举、RTMP 推流输出。
 *
 * 设计要点：
 *  - 纯 C 风格 N-API（napi_*），不用异常、不依赖 Napi:: 包装，最大化跨编译器兼容。
 *  - 设置参数以 JSON 字符串传入，调用 libobs 自带 obs_data_create_from_json 反序列化，
 *    避免手写 JSON 解析器（要求 libobs >= 27，本 addon 在 CI 用 obs-studio 30.x 编译）。
 *  - 布局数学（像素坐标/缩放/旋转/裁剪）由 JS 层（libobs-engine.js）算好，addon 只做搬运，
 *    保持原生层薄且可测。
 *  - 预览帧回读（GPU 纹理 → RGBA 缓冲）属 Phase 2，本桥接先提供稳定接口与明确占位，
 *    见 renderPreview()。
 *
 * 构建：见 binding.gyp / CMakeLists.txt；本文件由 CI（scripts/build-native.*）编译。
 */
#include <node_api.h>
#include <string>
#include <map>
#include <vector>

#include <obs.h>
#include <obs-data.h>
#include <obs-module.h>
#include <util/base.h>
#include <graphics/vec2.h>

#ifdef _WIN32
#define DEFAULT_GFX_MODULE "libobs-d3d11"
#else
#define DEFAULT_GFX_MODULE "libobs-opengl"
#endif

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
static bool                       g_started        = false;
static std::string                g_program_scene;                 // 当前 program 场景名
static std::map<std::string, obs_scene_t*> g_scenes;               // 场景名 → 场景

static obs_output_t*  g_output = nullptr;                          // rtmp 输出
static obs_service_t* g_service = nullptr;                         // 服务
static obs_encoder_t* g_venc   = nullptr;                          // 视频编码器
static obs_encoder_t* g_aenc   = nullptr;                          // 音频编码器

// 前向声明（定义在「推流输出」节，供 Shutdown 复用）
static void stop_stream_internal();

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
static napi_value bool_value(napi_env env, bool v) {
  napi_value out; napi_get_boolean(env, v, &out); return out;
}

static napi_value fail(napi_env env, const char* msg) {
  napi_throw_error(env, nullptr, msg);
  return nullptr;
}

// 从回调参数取字符串（argc/argv 约定：argv[0..]）
static bool str_arg(napi_env env, napi_value v, std::string& out) {
  napi_valuetype t; napi_typeof(env, v, &t);
  if (t != napi_string) return false;
  size_t len = 0;
  napi_get_value_string_utf8(env, v, nullptr, 0, &len);
  out.resize(len);
  napi_get_value_string_utf8(env, v, &out[0], len + 1, &len);
  return true;
}

static bool num_arg(napi_env env, napi_value v, double& out) {
  napi_valuetype t; napi_typeof(env, v, &t);
  if (t != napi_number) return false;
  napi_get_value_double(env, v, &out);
  return true;
}

static bool bool_arg(napi_env env, napi_value v, bool& out) {
  napi_valuetype t; napi_typeof(env, v, &t);
  if (t != napi_boolean) return false;
  napi_get_value_bool(env, v, &out);
  return true;
}

static obs_scene_t* find_scene(const std::string& name) {
  auto it = g_scenes.find(name);
  return it == g_scenes.end() ? nullptr : it->second;
}

static obs_sceneitem_t* find_item(obs_scene_t* sc, const std::string& name) {
  return sc ? obs_scene_find_source(sc, name.c_str()) : nullptr;
}

// ---------------------------------------------------------------------------
// 引擎生命周期
// ---------------------------------------------------------------------------

// startup(config): config = { locale, baseWidth, baseHeight, outputWidth, outputHeight,
//                             fps, graphicsModule, modulePath }
static napi_value Startup(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (g_started) return bool_value(env, true);

  std::string locale = "en-US";
  std::string graphicsModule = DEFAULT_GFX_MODULE;
  std::string modulePath;
  int baseW = 1920, baseH = 1080, outW = 1920, outH = 1080, fps = 30;

  if (argc >= 1 && argv[0] != nullptr) {
    napi_valuetype t; napi_typeof(env, argv[0], &t);
    if (t == napi_object) {
      napi_value v; std::string s; double d;
      if (napi_get_named_property(env, argv[0], "locale", &v) == napi_ok && str_arg(env, v, s)) locale = s;
      if (napi_get_named_property(env, argv[0], "graphicsModule", &v) == napi_ok && str_arg(env, v, s) && !s.empty()) graphicsModule = s;
      if (napi_get_named_property(env, argv[0], "modulePath", &v) == napi_ok && str_arg(env, v, s)) modulePath = s;
      if (napi_get_named_property(env, argv[0], "baseWidth", &v) == napi_ok && num_arg(env, v, d)) baseW = (int)d;
      if (napi_get_named_property(env, argv[0], "baseHeight", &v) == napi_ok && num_arg(env, v, d)) baseH = (int)d;
      if (napi_get_named_property(env, argv[0], "outputWidth", &v) == napi_ok && num_arg(env, v, d)) outW = (int)d;
      if (napi_get_named_property(env, argv[0], "outputHeight", &v) == napi_ok && num_arg(env, v, d)) outH = (int)d;
      if (napi_get_named_property(env, argv[0], "fps", &v) == napi_ok && num_arg(env, v, d)) fps = (int)d;
    }
  }

  if (!obs_startup(locale.c_str(), nullptr, nullptr)) {
    blog(LOG_ERROR, "[obs-bridge] obs_startup 失败");
    return bool_value(env, false);
  }
  if (!modulePath.empty()) {
    // OBS 插件模块目录：bin/64bit 放模块 DLL/dylib，data 放数据文件
    obs_add_module_path((modulePath + "/bin/64bit").c_str(), (modulePath + "/data").c_str());
  }
  obs_load_all_modules();

  obs_video_info ovi = {};
  ovi.fps_num = fps > 0 ? fps : 30;
  ovi.fps_den = 1;
  ovi.graphics_module = graphicsModule.c_str();
  ovi.base_width   = baseW > 0 ? (uint32_t)baseW : 1920;
  ovi.base_height  = baseH > 0 ? (uint32_t)baseH : 1080;
  ovi.output_width  = outW > 0 ? (uint32_t)outW : 1920;
  ovi.output_height = outH > 0 ? (uint32_t)outH : 1080;
  ovi.output_format = VIDEO_FORMAT_NV12;
  ovi.colorspace    = VIDEO_CS_709;
  ovi.range         = VIDEO_RANGE_PARTIAL;
  ovi.gpu_conversion = true;
  ovi.scale_type     = OBS_SCALE_BICUBIC;
  if (obs_reset_video(&ovi) != OBS_VIDEO_SUCCESS) {
    blog(LOG_ERROR, "[obs-bridge] obs_reset_video 失败（%s）", graphicsModule.c_str());
    obs_shutdown();
    return bool_value(env, false);
  }

  obs_audio_info oai = {};
  oai.samples_per_sec = 48000;
  oai.speakers = SPEAKERS_STEREO;
  obs_reset_audio(&oai);

  g_started = true;
  blog(LOG_INFO, "[obs-bridge] libobs 已启动 %dx%d@%d", baseW, baseH, fps);
  return bool_value(env, true);
}

static napi_value Shutdown(napi_env env, napi_callback_info info) {
  (void)info;
  // 先停推流，再清场景，最后关引擎
  stop_stream_internal();

  obs_set_output_source(0, nullptr);
  for (auto& kv : g_scenes) { if (kv.second) obs_scene_release(kv.second); }
  g_scenes.clear();
  g_program_scene.clear();

  if (g_started) { obs_shutdown(); g_started = false; }
  return nullptr;
}

static napi_value Available(napi_env env, napi_callback_info info) {
  (void)info;
  return bool_value(env, g_started);
}

static napi_value GetVersion(napi_env env, napi_callback_info info) {
  (void)info;
  std::string v = g_started ? std::string(obs_get_version_string()) : "not-started";
  napi_value out; napi_create_string_utf8(env, v.c_str(), v.size(), &out);
  return out;
}

// ---------------------------------------------------------------------------
// 场景图镜像
// ---------------------------------------------------------------------------

// createScene(name)
static napi_value CreateScene(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (!g_started) return fail(env, "libobs 未启动");
  std::string name;
  if (argc < 1 || !str_arg(env, argv[0], name) || name.empty()) return fail(env, "缺少场景名");
  if (find_scene(name)) return bool_value(env, true);
  obs_scene_t* sc = obs_scene_create(name.c_str());
  if (!sc) return bool_value(env, false);
  g_scenes[name] = sc;
  return bool_value(env, true);
}

// setProgramScene(name)
static napi_value SetProgramScene(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (!g_started) return fail(env, "libobs 未启动");
  std::string name;
  if (argc < 1 || !str_arg(env, argv[0], name)) return fail(env, "缺少场景名");
  obs_scene_t* sc = find_scene(name);
  if (!sc) return fail(env, "场景不存在");
  obs_set_output_source(0, obs_scene_get_source(sc));
  g_program_scene = name;
  return bool_value(env, true);
}

// destroyScene(name)
static napi_value DestroyScene(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string name;
  if (argc >= 1 && str_arg(env, argv[0], name)) {
    auto it = g_scenes.find(name);
    if (it != g_scenes.end()) {
      if (it->second) obs_scene_release(it->second);
      g_scenes.erase(it);
    }
  }
  return nullptr;
}

// addSource(scene, typeId, name, settingsJson)
static napi_value AddSource(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (!g_started) return fail(env, "libobs 未启动");
  std::string scene, typeId, name, settingsJson;
  if (argc < 3 || !str_arg(env, argv[0], scene) || !str_arg(env, argv[1], typeId) || !str_arg(env, argv[2], name))
    return fail(env, "addSource 参数不足");
  if (argc >= 4) str_arg(env, argv[3], settingsJson);

  obs_scene_t* sc = find_scene(scene);
  if (!sc) return fail(env, "场景不存在");

  obs_data_t* settings = nullptr;
  if (!settingsJson.empty()) settings = obs_data_create_from_json(settingsJson.c_str());
  if (!settings) settings = obs_data_create();

  obs_source_t* src = obs_source_create(typeId.c_str(), name.c_str(), settings, nullptr);
  obs_data_release(settings);
  if (!src) {
    blog(LOG_ERROR, "[obs-bridge] 创建来源失败：type=%s name=%s", typeId.c_str(), name.c_str());
    return bool_value(env, false);
  }
  obs_scene_add(sc, src);
  obs_source_release(src);   // 场景已持有引用
  return bool_value(env, true);
}

// updateSource(scene, name, settingsJson)
static napi_value UpdateSource(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string scene, name, settingsJson;
  if (argc < 2 || !str_arg(env, argv[0], scene) || !str_arg(env, argv[1], name)) return fail(env, "参数不足");
  if (argc >= 3) str_arg(env, argv[2], settingsJson);

  obs_sceneitem_t* item = find_item(find_scene(scene), name);
  if (!item) return bool_value(env, false);
  obs_source_t* src = obs_sceneitem_get_source(item);
  if (!src) return bool_value(env, false);

  if (!settingsJson.empty()) {
    obs_data_t* settings = obs_data_create_from_json(settingsJson.c_str());
    if (settings) { obs_source_update(src, settings); obs_data_release(settings); }
  }
  return bool_value(env, true);
}

// setTransform(scene, name, x, y, scaleX, scaleY, rotation, visible, cropL, cropT, cropR, cropB)
static napi_value SetTransform(napi_env env, napi_callback_info info) {
  size_t argc = 12; napi_value argv[12];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string scene, name;
  if (argc < 2 || !str_arg(env, argv[0], scene) || !str_arg(env, argv[1], name)) return fail(env, "参数不足");

  obs_sceneitem_t* item = find_item(find_scene(scene), name);
  if (!item) return bool_value(env, false);

  double x = 0, y = 0, sx = 1, sy = 1, rot = 0;
  bool visible = true;
  double cL = 0, cT = 0, cR = 0, cB = 0;
  if (argc >= 4)  num_arg(env, argv[2], x);
  if (argc >= 5)  num_arg(env, argv[3], y);
  if (argc >= 6)  num_arg(env, argv[4], sx);
  if (argc >= 7)  num_arg(env, argv[5], sy);
  if (argc >= 8)  num_arg(env, argv[6], rot);
  if (argc >= 9)  bool_arg(env, argv[7], visible);
  if (argc >= 13) { num_arg(env, argv[8], cL); num_arg(env, argv[9], cT); num_arg(env, argv[10], cR); num_arg(env, argv[11], cB); }

  struct vec2 pos;   pos.x = (float)x;  pos.y = (float)y;
  struct vec2 scale; scale.x = (float)sx; scale.y = (float)sy;
  obs_sceneitem_set_pos(item, &pos);
  obs_sceneitem_set_scale(item, &scale);
  obs_sceneitem_set_rot(item, (float)rot);
  obs_sceneitem_set_visible(item, visible);

  struct obs_sceneitem_crop crop = {};
  crop.left = (int)cL; crop.top = (int)cT; crop.right = (int)cR; crop.bottom = (int)cB;
  obs_sceneitem_set_crop(item, &crop);
  return bool_value(env, true);
}

// setEnabled(scene, name, enabled)
static napi_value SetEnabled(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string scene, name; bool enabled = true;
  if (argc < 3 || !str_arg(env, argv[0], scene) || !str_arg(env, argv[1], name) || !bool_arg(env, argv[2], enabled))
    return fail(env, "参数不足");
  obs_sceneitem_t* item = find_item(find_scene(scene), name);
  if (!item) return bool_value(env, false);
  obs_sceneitem_set_visible(item, enabled);
  return bool_value(env, true);
}

// removeSource(scene, name)
static napi_value RemoveSource(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string scene, name;
  if (argc < 2 || !str_arg(env, argv[0], scene) || !str_arg(env, argv[1], name)) return fail(env, "参数不足");
  obs_sceneitem_t* item = find_item(find_scene(scene), name);
  if (!item) return bool_value(env, false);
  obs_sceneitem_remove(item);
  return bool_value(env, true);
}

// reorderSource(scene, name, toPosition)
static napi_value ReorderSource(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string scene, name; double to = 0;
  if (argc < 3 || !str_arg(env, argv[0], scene) || !str_arg(env, argv[1], name) || !num_arg(env, argv[2], to))
    return fail(env, "参数不足");
  obs_sceneitem_t* item = find_item(find_scene(scene), name);
  if (!item) return bool_value(env, false);
  obs_sceneitem_set_order_position(item, (int)to);
  return bool_value(env, true);
}

// ---------------------------------------------------------------------------
// 设备枚举
// ---------------------------------------------------------------------------

// enumDevices(category): category = "video"(摄像头) | "monitor"(显示器)
// 返回 [{ value, label }]
static napi_value EnumDevices(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string cat;
  if (argc >= 1) str_arg(env, argv[0], cat);

  napi_value arr; napi_create_array(env, &arr);

  const char* srcId;
  const char* propKey;
#ifdef _WIN32
  if (cat == "monitor") { srcId = "monitor_capture"; propKey = "monitor"; }
  else { srcId = "dshow_input"; propKey = "video_device_id"; }
#else
  if (cat == "monitor") { srcId = "monitor_capture"; propKey = "monitor"; }
  else { srcId = "av_capture_input"; propKey = "device_id"; }
#endif

  obs_properties_t* props = obs_get_source_properties(srcId);
  if (!props) return arr;
  obs_property_t* prop = obs_properties_get(props, propKey);
  if (prop) {
    size_t n = obs_property_list_item_count(prop);
    for (size_t i = 0; i < n; i++) {
      const char* val = nullptr; const char* label = nullptr;
      obs_property_list_item_string(prop, i, &val, &label);
      napi_value obj; napi_create_object(env, &obj);
      napi_value v, l;
      napi_create_string_utf8(env, val ? val : "", NAPI_AUTO_LENGTH, &v);
      napi_create_string_utf8(env, label ? label : "", NAPI_AUTO_LENGTH, &l);
      napi_set_named_property(env, obj, "value", v);
      napi_set_named_property(env, obj, "label", l);
      napi_set_element(env, arr, (uint32_t)i, obj);
    }
  }
  obs_properties_destroy(props);
  return arr;
}

// ---------------------------------------------------------------------------
// 推流输出
// ---------------------------------------------------------------------------

// 内部：停掉当前推流并释放输出/服务/编码器
static void stop_stream_internal() {
  if (g_output) { obs_output_stop(g_output); obs_output_release(g_output); g_output = nullptr; }
  if (g_service) { obs_service_release(g_service); g_service = nullptr; }
  if (g_venc) { obs_encoder_release(g_venc); g_venc = nullptr; }
  if (g_aenc) { obs_encoder_release(g_aenc); g_aenc = nullptr; }
}

// startStream(url, key, bitrateKbps, fps)
static napi_value StartStream(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (!g_started) return fail(env, "libobs 未启动");
  std::string url, key; double bitrate = 2500, fps = 30;
  if (argc < 2 || !str_arg(env, argv[0], url) || !str_arg(env, argv[1], key)) return fail(env, "缺少 RTMP 地址");
  if (argc >= 3) num_arg(env, argv[2], bitrate);
  if (argc >= 4) num_arg(env, argv[3], fps);

  stop_stream_internal();

  // 服务：rtmp_common + Generic
  obs_data_t* svc = obs_data_create();
  obs_data_set_string(svc, "service", "Generic");
  obs_data_set_string(svc, "server", url.c_str());
  obs_data_set_string(svc, "key", key.c_str());
  g_service = obs_service_create("rtmp_common", "gf-service", svc, nullptr);
  obs_data_release(svc);
  if (!g_service) return bool_value(env, false);

  g_output = obs_output_create("rtmp_output", "gf-stream", nullptr, nullptr);
  if (!g_output) { obs_service_release(g_service); g_service = nullptr; return bool_value(env, false); }
  obs_output_set_service(g_output, g_service);

  // 视频编码器：obs_x264（OBS 内置，需 CI 编译 obs-x264）
  obs_data_t* vset = obs_data_create();
  obs_data_set_int(vset, "bitrate", (int)bitrate);
  obs_data_set_string(vset, "rate_control", "CBR");
  obs_data_set_int(vset, "keyint_sec", 2);
  g_venc = obs_video_encoder_create("obs_x264", "gf-venc", vset, nullptr);
  obs_data_release(vset);
  if (g_venc) obs_encoder_set_video(g_venc, obs_get_video());

  // 音频编码器：ffmpeg_aac（需 CI 编译 obs-ffmpeg）
  g_aenc = obs_audio_encoder_create("ffmpeg_aac", "gf-aenc", nullptr, 0, nullptr);
  if (g_aenc) obs_encoder_set_audio(g_aenc, obs_get_audio());

  if (g_venc) obs_output_set_video_encoder(g_output, g_venc);
  if (g_aenc) obs_output_set_audio_encoder(g_output, g_aenc, 0);

  bool ok = obs_output_start(g_output);
  blog(LOG_INFO, "[obs-bridge] startStream -> %s (%s)", url.c_str(), ok ? "OK" : "FAIL");
  return bool_value(env, ok);
}

static napi_value StopStream(napi_env env, napi_callback_info info) {
  (void)env; (void)info;
  stop_stream_internal();
  return nullptr;
}

// renderPreview(): Phase 2 —— GPU 纹理回读（需在 Electron 渲染线程建立 GPU 上下文）。
// 当前返回 { ok:false, reason }，接口保持稳定以便后续在不破坏调用方的前提下补齐。
static napi_value RenderPreview(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value obj; napi_create_object(env, &obj);
  napi_value ok; napi_get_boolean(env, false, &ok);
  napi_value reason;
  napi_create_string_utf8(env, "preview readback 未启用（需 GPU 上下文，规划中）", NAPI_AUTO_LENGTH, &reason);
  napi_set_named_property(env, obj, "ok", ok);
  napi_set_named_property(env, obj, "reason", reason);
  return obj;
}

// ---------------------------------------------------------------------------
// 模块注册
// ---------------------------------------------------------------------------
#define DECL(name, fn) { (name), 0, (fn), 0, 0, 0, napi_default, 0 }

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
    DECL("startup",        Startup),
    DECL("shutdown",       Shutdown),
    DECL("available",      Available),
    DECL("getVersion",     GetVersion),
    DECL("createScene",    CreateScene),
    DECL("setProgramScene",SetProgramScene),
    DECL("destroyScene",   DestroyScene),
    DECL("addSource",      AddSource),
    DECL("updateSource",   UpdateSource),
    DECL("setTransform",   SetTransform),
    DECL("setEnabled",     SetEnabled),
    DECL("removeSource",   RemoveSource),
    DECL("reorderSource",  ReorderSource),
    DECL("enumDevices",    EnumDevices),
    DECL("startStream",    StartStream),
    DECL("stopStream",     StopStream),
    DECL("renderPreview",  RenderPreview)
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
