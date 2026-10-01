/*
 * obs_bridge.cpp —— libobs 真引擎原生桥接（N-API）
 *
 * 引用来源：libobs 与图形 API（gs_texrender / gs_stagesurface）来自 OBS Studio（GPL-2.0，
 * https://github.com/obsproject/obs-studio）；过渡 / 滤镜 API 来自其 obs-transitions / obs-filters 插件。
 * 详见根目录 THIRD_PARTY_NOTICES.md。
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
#include <obs-source.h>
#include <util/base.h>
#include <graphics/vec2.h>
#include <graphics/graphics.h>

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

// ---- P2/P3/P4（v1.1.40）：过渡 / 预览回读 全局状态 ----
static obs_source_t*       g_transition = nullptr;                 // 当前转场（obs-transitions 插件）
static uint32_t            g_transition_ms = 300;                  // 过渡时长（ms，供 obs_transition_start 使用）
static gs_stagesurf_t*     g_stagesurf  = nullptr;                 // 预览 staging 表面
static uint8_t*            g_rgba_buf   = nullptr;                 // RGBA 回读缓冲
static uint32_t            g_rgba_w     = 0, g_rgba_h = 0;         // 回读缓冲尺寸

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

  // P3/P4 资源清理（过渡 / 预览回读）
  if (g_transition) { obs_source_release(g_transition); g_transition = nullptr; }
  g_transition_ms = 300;
  if (g_stagesurf) { gs_stagesurface_destroy(g_stagesurf); g_stagesurf = nullptr; }
  if (g_rgba_buf) { bfree(g_rgba_buf); g_rgba_buf = nullptr; }
  g_rgba_w = g_rgba_h = 0;

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
      // obs-studio 30.2.3 API: 两参返回 const char*（string=value，name=label）
      const char* val = obs_property_list_item_string(prop, i);
      const char* label = obs_property_list_item_name(prop, i);
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

// ---------------------------------------------------------------------------
// P1（v1.1.40）：音频控制。libobs 已自动混音（obs_reset_audio 建立 48k stereo），
// 这里只补「每来源音量 / 静音 / 独立开关」的控制接口。
// ---------------------------------------------------------------------------

// setSourceVolume(scene, name, volume): volume ∈ [0.0, 1.0]（线性，libobs 内部转 dB）
static napi_value SetSourceVolume(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string scene, name; double vol = 1.0;
  if (argc < 3 || !str_arg(env, argv[0], scene) || !str_arg(env, argv[1], name) || !num_arg(env, argv[2], vol))
    return fail(env, "setSourceVolume 参数不足");
  obs_sceneitem_t* item = find_item(find_scene(scene), name);
  if (!item) return bool_value(env, false);
  obs_source_t* src = obs_sceneitem_get_source(item);
  if (!src) return bool_value(env, false);
  if (vol < 0.0) vol = 0.0; if (vol > 1.0) vol = 1.0;
  obs_source_set_volume(src, (float)vol);
  return bool_value(env, true);
}

// setSourceMuted(scene, name, muted)
static napi_value SetSourceMuted(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string scene, name; bool muted = false;
  if (argc < 3 || !str_arg(env, argv[0], scene) || !str_arg(env, argv[1], name) || !bool_arg(env, argv[2], muted))
    return fail(env, "setSourceMuted 参数不足");
  obs_sceneitem_t* item = find_item(find_scene(scene), name);
  if (!item) return bool_value(env, false);
  obs_source_t* src = obs_sceneitem_get_source(item);
  if (!src) return bool_value(env, false);
  obs_source_set_muted(src, muted);
  return bool_value(env, true);
}

// ---------------------------------------------------------------------------
// P2（v1.1.40）：源滤镜。obs-filters 插件已在 CI 编译，这里补加/删滤镜。
// ---------------------------------------------------------------------------

// addSourceFilter(scene, name, filterId, filterName, settingsJson)
static napi_value AddSourceFilter(napi_env env, napi_callback_info info) {
  size_t argc = 5; napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string scene, name, filterId, filterName, settingsJson;
  if (argc < 3 || !str_arg(env, argv[0], scene) || !str_arg(env, argv[1], name) || !str_arg(env, argv[2], filterId))
    return fail(env, "addSourceFilter 参数不足");
  if (argc >= 4) str_arg(env, argv[3], filterName);
  if (argc >= 5) str_arg(env, argv[4], settingsJson);
  if (filterName.empty()) filterName = filterId;

  obs_sceneitem_t* item = find_item(find_scene(scene), name);
  if (!item) return bool_value(env, false);
  obs_source_t* src = obs_sceneitem_get_source(item);
  if (!src) return bool_value(env, false);

  obs_data_t* settings = nullptr;
  if (!settingsJson.empty()) settings = obs_data_create_from_json(settingsJson.c_str());
  if (!settings) settings = obs_data_create();
  obs_source_t* filter = obs_source_create(filterId.c_str(), filterName.c_str(), settings, nullptr);
  obs_data_release(settings);
  if (!filter) {
    blog(LOG_ERROR, "[obs-bridge] 创建滤镜失败：filter=%s", filterId.c_str());
    return bool_value(env, false);
  }
  obs_source_filter_add(src, filter);
  obs_source_release(filter);
  return bool_value(env, true);
}

// removeSourceFilter(scene, name, filterName)
static napi_value RemoveSourceFilter(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string scene, name, filterName;
  if (argc < 3 || !str_arg(env, argv[0], scene) || !str_arg(env, argv[1], name) || !str_arg(env, argv[2], filterName))
    return fail(env, "removeSourceFilter 参数不足");
  obs_sceneitem_t* item = find_item(find_scene(scene), name);
  if (!item) return bool_value(env, false);
  obs_source_t* src = obs_sceneitem_get_source(item);
  if (!src) return bool_value(env, false);
  obs_source_t* filter = obs_source_get_filter_by_name(src, filterName.c_str());
  if (!filter) return bool_value(env, false);
  obs_source_filter_remove(src, filter);
  return bool_value(env, true);
}

// updateSourceFilter(scene, name, filterName, settingsJson)：更新已存在滤镜的设置（obs_source_update）。
// v1.1.42：滤镜属性面板调参后调用，避免用 add 导致同名滤镜累积。
static napi_value UpdateSourceFilter(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string scene, name, filterName, settingsJson;
  if (argc < 3 || !str_arg(env, argv[0], scene) || !str_arg(env, argv[1], name) || !str_arg(env, argv[2], filterName))
    return fail(env, "updateSourceFilter 参数不足");
  if (argc >= 4) str_arg(env, argv[3], settingsJson);

  obs_sceneitem_t* item = find_item(find_scene(scene), name);
  if (!item) return bool_value(env, false);
  obs_source_t* src = obs_sceneitem_get_source(item);
  if (!src) return bool_value(env, false);
  obs_source_t* filter = obs_source_get_filter_by_name(src, filterName.c_str());
  if (!filter) return bool_value(env, false);

  if (!settingsJson.empty()) {
    obs_data_t* settings = obs_data_create_from_json(settingsJson.c_str());
    if (settings) { obs_source_update(filter, settings); obs_data_release(settings); }
  }
  return bool_value(env, true);
}

// ---------------------------------------------------------------------------
// P3（v1.1.40）：场景过渡。obs-transitions 插件已在 CI 编译。
// ---------------------------------------------------------------------------

// createTransition(typeId, name): 常见 typeId = fade_transition / cut_transition / swipe_transition / slide_transition
static napi_value CreateTransition(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string typeId, name;
  if (argc < 1 || !str_arg(env, argv[0], typeId) || typeId.empty()) return fail(env, "缺少过渡类型");
  if (argc >= 2) str_arg(env, argv[1], name);
  if (name.empty()) name = typeId;

  // 旧的过渡释放
  if (g_transition) { obs_source_release(g_transition); g_transition = nullptr; }

  g_transition = obs_source_create_private(typeId.c_str(), name.c_str(), nullptr);
  if (!g_transition) {
    // 兜底：cut_transition 若也未编译则用 fade
    blog(LOG_WARNING, "[obs-bridge] 创建过渡失败：%s，尝试 fade_transition", typeId.c_str());
    g_transition = obs_source_create_private("fade_transition", name.c_str(), nullptr);
  }
  if (!g_transition) return bool_value(env, false);

  // 初始把当前 program 场景挂到过渡
  obs_scene_t* cur = find_scene(g_program_scene);
  if (cur) obs_transition_set(g_transition, obs_scene_get_source(cur));
  return bool_value(env, true);
}

// setTransitionDuration(ms)：仅保存时长，真正生效在 triggerTransition 的 obs_transition_start(duration_ms)。
// 注意：obs_transition_set_size 是设置过渡「尺寸」(cx,cy) 而非时长，勿混淆。
static napi_value SetTransitionDuration(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double ms = 300;
  if (argc >= 1) num_arg(env, argv[0], ms);
  if (ms < 0) ms = 0; if (ms > 10000) ms = 10000;
  g_transition_ms = (uint32_t)ms;
  return bool_value(env, true);
}

// triggerTransition(sceneName): 把 program 切到指定场景（带过渡动画）
static napi_value TriggerTransition(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (!g_started) return fail(env, "libobs 未启动");
  std::string name;
  if (argc < 1 || !str_arg(env, argv[0], name)) return fail(env, "缺少目标场景名");
  obs_scene_t* target = find_scene(name);
  if (!target) return fail(env, "目标场景不存在");

  if (!g_transition) {
    // 未显式创建过渡时，直接硬切
    obs_set_output_source(0, obs_scene_get_source(target));
    g_program_scene = name;
    return bool_value(env, true);
  }

  // OBS 过渡协议：把过渡源设为 program，再 transition_start 指向目标场景
  obs_set_output_source(0, g_transition);
  obs_scene_t* from = find_scene(g_program_scene);
  if (from) obs_transition_set(g_transition, obs_scene_get_source(from));
  bool ok = obs_transition_start(g_transition, OBS_TRANSITION_MODE_AUTO, g_transition_ms, obs_scene_get_source(target));
  g_program_scene = name;
  return bool_value(env, ok);
}

// ---------------------------------------------------------------------------
// P4（v1.1.40）：实时预览回读。把当前 program 合成帧 staging 回读成 RGBA 缓冲。
// 注意：需在 Electron 渲染线程建立 GPU 上下文后调用（libobs 的 video 上下文在主进程）。
// 降采样到 width/height，避免全 1080p 每帧回读压垮 IPC。
// ---------------------------------------------------------------------------

// renderPreview(width, height): 返回 { ok, width, height, data(ArrayBuffer RGBA), stride }
static napi_value RenderPreview(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (!g_started) {
    napi_value obj; napi_create_object(env, &obj);
    napi_set_named_property(env, obj, "ok", bool_value(env, false));
    napi_value r; napi_create_string_utf8(env, "libobs 未启动", NAPI_AUTO_LENGTH, &r);
    napi_set_named_property(env, obj, "reason", r);
    return obj;
  }

  double w = 640, h = 360;
  if (argc >= 2) { num_arg(env, argv[0], w); num_arg(env, argv[1], h); }
  uint32_t tw = (uint32_t)w, th = (uint32_t)h;
  if (tw < 64) tw = 64; if (th < 64) th = 64;
  if (tw > 1920) tw = 1920; if (th > 1080) th = 1080;

  // 惰性创建 staging 表面与回读缓冲（尺寸变化时重建）
  if (!g_stagesurf || g_rgba_w != tw || g_rgba_h != th) {
    if (g_stagesurf) { gs_stagesurface_destroy(g_stagesurf); g_stagesurf = nullptr; }
    if (g_rgba_buf) { bfree(g_rgba_buf); g_rgba_buf = nullptr; }
    g_stagesurf = gs_stagesurface_create(tw, th, GS_RGBA);
    g_rgba_buf = (uint8_t*)bmalloc((size_t)tw * th * 4);
    g_rgba_w = tw; g_rgba_h = th;
    if (!g_stagesurf || !g_rgba_buf) {
      napi_value obj; napi_create_object(env, &obj);
      napi_set_named_property(env, obj, "ok", bool_value(env, false));
      napi_value r; napi_create_string_utf8(env, "staging surface 创建失败（无 GPU 上下文？）", NAPI_AUTO_LENGTH, &r);
      napi_set_named_property(env, obj, "reason", r);
      return obj;
    }
  }

  // 渲染当前 program 输出并 staging 回读
  obs_source_t* prog = obs_get_output_source(0);
  if (!prog) prog = obs_scene_get_source(find_scene(g_program_scene));
  if (!prog) {
    napi_value obj; napi_create_object(env, &obj);
    napi_set_named_property(env, obj, "ok", bool_value(env, false));
    napi_value r; napi_create_string_utf8(env, "无 program 输出源", NAPI_AUTO_LENGTH, &r);
    napi_set_named_property(env, obj, "reason", r);
    return obj;
  }

  obs_video_info ovi;
  obs_get_video_info(&ovi);

  {
    // 渲染一帧到 stagesurface
    gs_texrender_t* tr = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
    if (!tr) {
      napi_value obj; napi_create_object(env, &obj);
      napi_set_named_property(env, obj, "ok", bool_value(env, false));
      napi_value r; napi_create_string_utf8(env, "texrender 创建失败", NAPI_AUTO_LENGTH, &r);
      napi_set_named_property(env, obj, "reason", r);
      return obj;
    }
    gs_texrender_reset(tr);
    uint32_t cx = ovi.base_width, cy = ovi.base_height;
    if (!gs_texrender_begin(tr, cx, cy)) {
      gs_texrender_destroy(tr);
      napi_value obj; napi_create_object(env, &obj);
      napi_set_named_property(env, obj, "ok", bool_value(env, false));
      napi_value r; napi_create_string_utf8(env, "texrender_begin 失败", NAPI_AUTO_LENGTH, &r);
      napi_set_named_property(env, obj, "reason", r);
      return obj;
    }
    struct vec4 bg; vec4_zero(&bg);
    gs_ortho(0.0f, (float)cx, 0.0f, (float)cy, -100.0f, 100.0f);
    gs_clear(GS_CLEAR_COLOR | GS_CLEAR_DEPTH, &bg, 0, 0);
    obs_source_video_render(prog);
    gs_texrender_end(tr);

    // 把 texrender 纹理 staging 到 stagesurface（会缩放到 tw×th）
    gs_texture_t* tex = gs_texrender_get_texture(tr);
    if (tex) {
      gs_stage_texture(g_stagesurf, tex);
    }
    gs_texrender_destroy(tr);
  }

  // 回读 RGBA
  uint32_t stride = 0;
  if (gs_stagesurface_map(g_stagesurf, &g_rgba_buf, &stride)) {
    size_t bytes = (size_t)tw * th * 4;
    void* out = nullptr;
    napi_value buf;
    if (napi_create_buffer_copy(env, bytes, g_rgba_buf, &out, &buf) == napi_ok) {
      gs_stagesurface_unmap(g_stagesurf);
      napi_value obj; napi_create_object(env, &obj);
      napi_set_named_property(env, obj, "ok", bool_value(env, true));
      napi_set_named_property(env, obj, "width", [&](){ napi_value v; napi_create_uint32(env, tw, &v); return v; }());
      napi_set_named_property(env, obj, "height", [&](){ napi_value v; napi_create_uint32(env, th, &v); return v; }());
      napi_set_named_property(env, obj, "stride", [&](){ napi_value v; napi_create_uint32(env, stride, &v); return v; }());
      napi_set_named_property(env, obj, "data", buf);
      return obj;
    }
    gs_stagesurface_unmap(g_stagesurf);
  }

  napi_value obj; napi_create_object(env, &obj);
  napi_set_named_property(env, obj, "ok", bool_value(env, false));
  napi_value r; napi_create_string_utf8(env, "回读失败（无 GPU 上下文或纹理不可读）", NAPI_AUTO_LENGTH, &r);
  napi_set_named_property(env, obj, "reason", r);
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
    DECL("setSourceVolume",  SetSourceVolume),
    DECL("setSourceMuted",   SetSourceMuted),
    DECL("addSourceFilter",  AddSourceFilter),
    DECL("removeSourceFilter", RemoveSourceFilter),
    DECL("updateSourceFilter", UpdateSourceFilter),
    DECL("createTransition", CreateTransition),
    DECL("setTransitionDuration", SetTransitionDuration),
    DECL("triggerTransition", TriggerTransition),
    DECL("renderPreview",  RenderPreview)
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
