/**
 * libobs-engine.js —— libobs 真引擎主进程适配器
 *
 * 把渲染层 SceneEngine 产出的 OBS 形态场景（normalizeScene 结果：{id,name,size,sources:[{type,settings,transform}]}）
 * 镜像进 libobs 原生桥接（native/obs-bridge），实现与 SceneEngine 对齐的「真引擎」输出路径：
 *   场景图镜像 → 来源设置 → 变换（像素坐标/缩放/旋转/裁剪）→ 设备枚举 → RTMP 推流。
 *
 * 职责边界：
 *   - 只做「OBS 数据模型 ↔ libobs」的翻译与搬运；布局数学在此算好，原生层保持薄。
 *   - 引擎不可用（原生 addon 未编译 / 未打包）时返回 null，调用方（main.js）自动回退 ffmpeg 引擎。
 *
 * 平台差异（需在真机验证）：
 *   - 视频采集源 id：Windows=「dshow_input」/ macOS=「av_capture_input」；设备属性键随之不同。
 *   - 颜色：OBS 用 uint32 ABGR（0xAABBGGRR），本模块把 #rrggbb 转换。
 */
'use strict';

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// 颜色 / 来源 id / 设置 的平台化映射
// ---------------------------------------------------------------------------

// '#rrggbb' / '#rgb' → OBS uint32 ABGR（0xAABBGGRR）
function toObsColor(hex) {
  let s = String(hex == null ? '' : hex).trim().replace('#', '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return 0xFFFFFFFF;   // 默认白
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return ((0xFF << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

// 应用来源类型 id → libobs 原生来源 id（含平台差异）
function toObsSourceId(typeId) {
  switch (typeId) {
    case 'image': return 'image_source';
    case 'text': return 'text_ft2_source';
    case 'av_capture_input':
      // Windows 的摄像头采集源在 OBS 里叫 dshow_input，其余平台 av_capture_input
      return process.platform === 'win32' ? 'dshow_input' : 'av_capture_input';
    default:
      return typeId;   // ffmpeg_source / image_source / text_ft2_source / color_source / browser_source / monitor_capture
  }
}

// 应用来源 settings → libobs obs_data 字段（做颜色转换与设备键名平台化）
function toObsSettings(typeId, settings) {
  const st = Object.assign({}, settings || {});
  // 颜色字段统一转 OBS uint32
  if (typeId === 'text_ft2_source' && st.color != null) st.color = toObsColor(st.color);
  if (typeId === 'color_source' && st.color != null) st.color = toObsColor(st.color);

  // 视频采集源：应用统一用 'device'，libobs 平台键名不同
  if (typeId === 'av_capture_input' && st.device != null) {
    if (process.platform === 'win32') { st.video_device_id = st.device; delete st.device; }
    else { st.device_id = st.device; delete st.device; }
  }
  return st;
}

// 布局数学：transform → libobs 的 pos/scale/rot/visible/crop（与 ffmpeg overlay 坐标口径一致）
function computeTransform(transform, enabled) {
  const t = transform || {};
  const x = (t.x != null && t.x !== '') ? Number(t.x) : 10;
  const y = (t.y != null && t.y !== '') ? Number(t.y) : 10;
  const sc = t.scale || {};
  const sx = (sc.x != null) ? Number(sc.x) : 1;
  const sy = (sc.y != null) ? Number(sc.y) : 1;
  const rotation = Number(t.rotation) || 0;
  const visible = (enabled !== false) && (t.visible !== false);
  const c = t.crop || {};
  return {
    x, y, scaleX: sx, scaleY: sy, rotation, visible,
    cropL: Number(c.left) || 0, cropT: Number(c.top) || 0,
    cropR: Number(c.right) || 0, cropB: Number(c.bottom) || 0
  };
}

// ---------------------------------------------------------------------------
// addon 加载（dev / packaged 双路径）
// ---------------------------------------------------------------------------

function findFile(candidates) {
  for (let i = 0; i < candidates.length; i++) {
    try { if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i]; } catch (e) { /* ignore */ }
  }
  return null;
}

function resolveAddonPath() {
  const c = [];
  if (process.resourcesPath) c.push(path.join(process.resourcesPath, 'obs-bridge', 'obs_bridge.node'));
  c.push(path.join(__dirname, 'native', 'obs-bridge', 'build', 'Release', 'obs_bridge.node'));
  c.push(path.join(__dirname, 'native', 'obs-bridge', 'build', 'Debug', 'obs_bridge.node'));
  return findFile(c);
}

function resolveModulePath() {
  const c = [];
  if (process.resourcesPath) c.push(path.join(process.resourcesPath, 'obs'));
  c.push(path.join(__dirname, 'third_party', 'obs-studio', 'build_x64'));
  c.push(path.join(__dirname, 'third_party', 'obs-studio', 'build'));
  return findFile(c);
}

// ---------------------------------------------------------------------------
// 适配器工厂
// ---------------------------------------------------------------------------

// 返回 null（原生引擎不可用）或驱动对象
function createLibobsEngine(opts) {
  opts = opts || {};
  const addonPath = opts.addonPath || resolveAddonPath();
  if (!addonPath) return null;

  let native;
  try { native = require(addonPath); } catch (e) {
    console.error('[libobs-engine] 加载原生桥接失败：', e && e.message);
    return null;
  }
  if (!native || typeof native.startup !== 'function') return null;

  const modulePath = opts.modulePath || resolveModulePath() || '';

  let started = false;
  const meta = { available: false, version: '', engine: 'libobs', nativePath: addonPath };

  function ensureStarted(config) {
    if (started) return true;
    const ok = native.startup({
      locale: (config && config.locale) || 'en-US',
      baseWidth: (config && config.baseWidth) || 1920,
      baseHeight: (config && config.baseHeight) || 1080,
      outputWidth: (config && config.outputWidth) || (config && config.baseWidth) || 1920,
      outputHeight: (config && config.outputHeight) || (config && config.baseHeight) || 1080,
      fps: (config && config.fps) || 30,
      graphicsModule: (config && config.graphicsModule) || '',
      modulePath: modulePath
    });
    started = !!ok;
    if (started) {
      meta.available = true;
      meta.version = String(native.getVersion() || '');
    }
    return started;
  }

  // 把整个 program 场景镜像进 libobs
  function pushScene(scene, config) {
    ensureStarted(config);
    if (!started) throw new Error('libobs 引擎启动失败');
    const name = (scene && scene.name) || '主场景';
    native.createScene(name);
    const sources = (scene && Array.isArray(scene.sources)) ? scene.sources : [];
    sources.forEach(function (s) {
      if (!s || !s.type) return;
      const obsType = toObsSourceId(s.type);
      const obsSettings = toObsSettings(s.type, s.settings);
      const srcName = s.name || (obsType + '-' + (s.id || 'x'));
      let ok = native.addSource(name, obsType, srcName, JSON.stringify(obsSettings));
      if (!ok) return;   // 该来源类型未编译/不支持，跳过
      const tf = computeTransform(s.transform, s.enabled);
      native.setTransform(name, srcName, tf.x, tf.y, tf.scaleX, tf.scaleY,
        tf.rotation, tf.visible, tf.cropL, tf.cropT, tf.cropR, tf.cropB);
      native.setEnabled(name, srcName, s.enabled !== false);
    });
    native.setProgramScene(name);
    return { ok: true, scene: name, sources: sources.length };
  }

  function startStream(url, key, o) {
    ensureStarted(o);
    const u = typeof url === 'string' ? url : (o && o.url);
    const k = typeof key === 'string' ? key : (o && o.key);
    if (!u) throw new Error('缺少 RTMP 地址');
    const bitrate = Number((o && o.videoBitrate) || 2500);
    const fps = Number((o && o.fps) || 30);
    return !!native.startStream(u, k, bitrate, fps);
  }

  function stopStream() { if (started) native.stopStream(); }

  function enumDevices(category) {
    if (!started) return [];
    try { return native.enumDevices(category || 'video') || []; } catch (e) { return []; }
  }

  function shutdown() {
    if (!started) return;
    try { native.stopStream(); native.shutdown(); } catch (e) { /* ignore */ }
    started = false;
    meta.available = false;
  }

  return {
    meta: meta,
    available: function () { return started && meta.available; },
    startup: ensureStarted,
    pushScene: pushScene,
    startStream: startStream,
    stopStream: stopStream,
    enumDevices: enumDevices,
    shutdown: shutdown,
    // 供渲染层展示/测试使用
    toObsSourceId: toObsSourceId,
    toObsColor: toObsColor
  };
}

module.exports = { createLibobsEngine: createLibobsEngine, toObsColor: toObsColor, toObsSourceId: toObsSourceId };
