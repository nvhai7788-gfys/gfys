/*
 * scene-engine.js — OBS 场景/来源 引擎抽象层（v1.1.36 起）
 *
 * 引用来源：场景 / 来源 / 属性 / 变换的数据模型对齐 OBS Studio 的来源系统（GPL-2.0，
 * https://github.com/obsproject/obs-studio），仅学习其抽象与命名，非代码复制。见 THIRD_PARTY_NOTICES.md。
 *
 * 设计目标：
 *  1) 引擎无关：本文件定义与 libobs / ffmpeg 都无关的「场景-来源-属性-变换」数据模型与 API。
 *  2) 1:1 还原 OBS 的来源属性系统：来源类型注册表（SOURCE_TYPES）+ 强类型属性描述符，
 *     其中 type:'path' 即为 OBS 属性系统里的「文件路径」类属性（isPathProperty），
 *     渲染为文件选择框（带扩展名过滤）——这正是「场景内文件管理」的底层机制。
 *  3) 可替换：当前渲染层用 FfmpegEngine 适配器（复用现有 composeVideoFilter / compileSceneGraph），
 *     7 类来源均已由 ffmpeg 管线真正合成；日后在有 Xcode+网络的 Mac/Win CI 上补一个
 *     LibobsEngine 实现同一接口即可，UI 零改动换真引擎。
 *
 * 该模块同时支持浏览器（挂到 window.SceneEngine）与 Node（module.exports，供单测/端到端 e2e 使用）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SceneEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------- OBS 来源类型注册表（属性描述符对齐 OBS） ----------------
  // 属性 type 对齐 OBS obs_property 类型：path(文件浏览) / bool / int / float / text / list / color / font
  var SOURCE_TYPES = {
    'ffmpeg_source': {
      id: 'ffmpeg_source', label: '媒体源（视频/音频文件）', category: 'input',
      props: [
        { key: 'is_local_file', name: '本地文件', type: 'bool', default: true },
        { key: 'local_file', name: '本地文件', type: 'path',
          filter: 'Video Files (*.mp4 *.mov *.mkv *.avi *.flv *.ts *.m2ts *.m3u8);;Audio/Video (*.*);;All Files (*.*)',
          default: '' },
        { key: 'input', name: '输入（网络流 URL）', type: 'text', default: '' },
        { key: 'looping', name: '循环', type: 'bool', default: false },
        { key: 'close_when_inactive', name: '不活动时关闭文件', type: 'bool', default: true }
      ]
    },
    'image_source': {
      id: 'image_source', label: '图片源', category: 'input',
      props: [
        { key: 'file', name: '图片文件', type: 'path',
          filter: 'Images (*.png *.jpg *.jpeg *.bmp *.gif *.tiff *.webp *.svg);;All Files (*.*)',
          default: '' },
        { key: 'unload', name: '不活动时卸载', type: 'bool', default: false }
      ]
    },
    'text_ft2_source': {
      id: 'text_ft2_source', label: '文本（FreeType）', category: 'input',
      props: [
        { key: 'text', name: '文本', type: 'text', default: '港丰影视' },
        { key: 'font', name: '字体', type: 'font', default: '' },
        { key: 'color', name: '颜色', type: 'color', default: '#ffffff' },
        { key: 'font_size', name: '字号', type: 'int', min: 1, max: 800, default: 92 },
        { key: 'read_from_file', name: '从文件读取文本', type: 'bool', default: false },
        { key: 'file', name: '文本文件', type: 'path',
          filter: 'Text Files (*.txt);;All Files (*.*)', default: '' }
      ]
    },
    'av_capture_input': {
      id: 'av_capture_input', label: '视频采集设备（摄像头）', category: 'device',
      props: [ { key: 'device', name: '设备', type: 'list', options: [], dynamic: true, default: '' } ]
    },
    'browser_source': {
      id: 'browser_source', label: '浏览器源', category: 'input',
      props: [
        { key: 'url', name: 'URL', type: 'text', default: 'https://www.example.com' },
        { key: 'width', name: '宽度', type: 'int', min: 1, max: 8192, default: 1280 },
        { key: 'height', name: '高度', type: 'int', min: 1, max: 8192, default: 720 },
        { key: 'snapshot', name: '预渲染快照（PNG，无浏览器内核时降级使用）', type: 'path',
          filter: 'Images (*.png *.jpg *.jpeg *.webp);;All Files (*.*)', default: '' }
      ]
    },
    'color_source': {
      id: 'color_source', label: '色源', category: 'input',
      props: [
        { key: 'color', name: '颜色', type: 'color', default: '#000000' },
        { key: 'width', name: '宽度', type: 'int', min: 1, max: 8192, default: 1920 },
        { key: 'height', name: '高度', type: 'int', min: 1, max: 8192, default: 1080 }
      ]
    },
    'monitor_capture': {
      id: 'monitor_capture', label: '显示器捕获', category: 'device',
      props: [ { key: 'monitor', name: '显示器', type: 'list', options: [], dynamic: true, default: '0' } ]
    }
  };

  var SOURCE_ORDER = ['ffmpeg_source', 'image_source', 'text_ft2_source', 'av_capture_input', 'browser_source', 'color_source', 'monitor_capture'];

  // ---------------- OBS 源滤镜类型注册表（对齐 obs-filters 插件） ----------------
  // v1.1.42：每类滤镜的属性描述符（key / 名称 / 类型 / 范围 / 默认值），
  // key 与默认值精确对齐 OBS Studio 30.2.3 的 plugins/obs-filters/*.c（详见各源文件）。
  // 属性 type 复用来源属性的渲染语义：int/float/bool/color/list。
  var FILTER_TYPES = {
    'chroma_key_filter': {
      id: 'chroma_key_filter', label: '色度键（绿幕抠像）',
      props: [
        { key: 'key_color', name: '键色', type: 'color', default: '#00ff00' },
        { key: 'key_color_type', name: '键色类型', type: 'list', options: ['green', 'blue', 'magenta', 'custom'], default: 'green' },
        { key: 'similarity', name: '相似度', type: 'int', min: 1, max: 1000, default: 400 },
        { key: 'smoothness', name: '平滑度', type: 'int', min: 1, max: 1000, default: 80 },
        { key: 'spill', name: '溢色抑制', type: 'int', min: 1, max: 1000, default: 100 },
        { key: 'opacity', name: '不透明度', type: 'int', min: 0, max: 100, default: 100 },
        { key: 'contrast', name: '对比度', type: 'float', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },
        { key: 'brightness', name: '亮度', type: 'float', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },
        { key: 'gamma', name: '伽马', type: 'float', min: -1.0, max: 1.0, step: 0.01, default: 0.0 }
      ]
    },
    'color_key_filter': {
      id: 'color_key_filter', label: '色键（纯色抠像）',
      props: [
        { key: 'key_color', name: '键色', type: 'color', default: '#ffffff' },
        { key: 'key_color_type', name: '键色类型', type: 'list', options: ['green', 'blue', 'magenta', 'custom'], default: 'custom' },
        { key: 'similarity', name: '相似度', type: 'int', min: 1, max: 1000, default: 400 },
        { key: 'smoothness', name: '平滑度', type: 'int', min: 1, max: 1000, default: 80 },
        { key: 'opacity', name: '不透明度', type: 'int', min: 0, max: 100, default: 100 },
        { key: 'contrast', name: '对比度', type: 'float', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },
        { key: 'brightness', name: '亮度', type: 'float', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },
        { key: 'gamma', name: '伽马', type: 'float', min: -1.0, max: 1.0, step: 0.01, default: 0.0 }
      ]
    },
    'color_filter': {
      id: 'color_filter', label: '颜色校正',
      props: [
        { key: 'gamma', name: '伽马', type: 'float', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },
        { key: 'contrast', name: '对比度', type: 'float', min: -2.0, max: 2.0, step: 0.01, default: 0.0 },
        { key: 'brightness', name: '亮度', type: 'float', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },
        { key: 'saturation', name: '饱和度', type: 'float', min: -1.0, max: 5.0, step: 0.01, default: 0.0 },
        { key: 'hue_shift', name: '色相偏移', type: 'float', min: -180.0, max: 180.0, step: 1.0, default: 0.0 },
        { key: 'opacity', name: '不透明度', type: 'int', min: 0, max: 100, default: 100 }
      ]
    },
    'scale_filter': {
      id: 'scale_filter', label: '缩放/宽高比',
      props: [
        { key: 'resolution', name: '分辨率', type: 'text', default: '' },
        { key: 'sampling', name: '采样', type: 'list', options: ['bilinear', 'area', 'bicubic', 'lanczos'], default: 'bilinear' },
        { key: 'undistort', name: '去畸变', type: 'bool', default: false }
      ]
    },
    'sharpness_filter': {
      id: 'sharpness_filter', label: '锐化',
      props: [
        { key: 'sharpness', name: '锐化强度', type: 'float', min: 0.0, max: 1.0, step: 0.01, default: 0.08 }
      ]
    },
    'scroll_filter': {
      id: 'scroll_filter', label: '滚动',
      props: [
        { key: 'speed_x', name: '水平速度', type: 'float', min: -500.0, max: 500.0, step: 1.0, default: 0.0 },
        { key: 'speed_y', name: '垂直速度', type: 'float', min: -500.0, max: 500.0, step: 1.0, default: 0.0 },
        { key: 'limit_cx', name: '限制宽度', type: 'bool', default: false },
        { key: 'cx', name: '裁剪宽度', type: 'int', min: 1, max: 16384, default: 1920 },
        { key: 'limit_cy', name: '限制高度', type: 'bool', default: false },
        { key: 'cy', name: '裁剪高度', type: 'int', min: 1, max: 16384, default: 1080 },
        { key: 'loop', name: '循环', type: 'bool', default: false }
      ]
    },
    'luma_key_filter': {
      id: 'luma_key_filter', label: '亮度键',
      props: [
        { key: 'luma_max', name: '亮度上限', type: 'float', min: 0.0, max: 1.0, step: 0.01, default: 1.0 },
        { key: 'luma_min', name: '亮度下限', type: 'float', min: 0.0, max: 1.0, step: 0.01, default: 0.0 },
        { key: 'luma_max_smooth', name: '上限平滑', type: 'float', min: 0.0, max: 1.0, step: 0.01, default: 0.0 },
        { key: 'luma_min_smooth', name: '下限平滑', type: 'float', min: 0.0, max: 1.0, step: 0.01, default: 0.0 }
      ]
    }
  };

  var FILTER_ORDER = ['chroma_key_filter', 'color_key_filter', 'color_filter', 'scale_filter', 'sharpness_filter', 'scroll_filter', 'luma_key_filter'];

  // 滤镜默认设置（按 FILTER_TYPES 的 props default 生成）
  function defaultFilterSettings(filterId) {
    var t = FILTER_TYPES[filterId]; if (!t) return {};
    var s = {};
    t.props.forEach(function (p) { if (p.default !== undefined) s[p.key] = p.default; });
    return s;
  }
  function getFilterProperties(filterId) { var t = FILTER_TYPES[filterId]; return t ? t.props.slice() : []; }

  function defaultSettings(typeId) {
    var t = SOURCE_TYPES[typeId]; if (!t) return {};
    var s = {};
    t.props.forEach(function (p) { if (p.default !== undefined) s[p.key] = p.default; });
    return s;
  }
  function getProperties(typeId) { var t = SOURCE_TYPES[typeId]; return t ? t.props.slice() : []; }
  function isPathProperty(p) { return p && p.type === 'path'; }

  // ---------------- 来源对象规范化（向 OBS 形态迁移） ----------------
  function uid(prefix) { return (prefix || 's') + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }

  function defaultTransform() {
    return {
      pos: 'tl', x: '10', y: '10', scale: { x: 1, y: 1 }, rotation: 0,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
      bounds: { x: 0, y: 0 }, boundsType: 'OBS_BOUNDS_NONE', boundsAlignment: 0, alignment: 0,
      visible: true
    };
  }

  // 把旧的 {type:'image'|'text', path/text/...} 或任意来源，规范成 OBS 形态：
  // { id, type(obs id), name, enabled, settings:{}, transform:{} }
  function normalizeSource(src) {
    if (!src || typeof src !== 'object') src = {};
    var out = {
      id: src.id || uid('src'),
      type: src.type,
      name: src.name || '',
      enabled: src.enabled !== false,
      settings: src.settings || {},
      transform: Object.assign(defaultTransform(), src.transform || {}),
      // v1.1.40：音频控制 + 源滤镜（对齐 OBS 来源扩展）
      volume: (src.volume !== undefined) ? src.volume : 1,
      muted: !!src.muted,
      filters: Array.isArray(src.filters) ? src.filters.slice() : []
    };
    // 旧形态迁移
    if (src.type === 'image') {
      out.type = 'image_source';
      out.settings = Object.assign({ file: src.path || '' }, out.settings);
    } else if (src.type === 'text') {
      out.type = 'text_ft2_source';
      out.settings = Object.assign({
        text: src.text || '文字', font_size: src.fontsize || 32, color: src.color || 'white'
      }, out.settings);
    }
    // 未知/缺省 → 兜底为图片源
    if (!SOURCE_TYPES[out.type]) out.type = 'image_source';
    if (!out.name) out.name = (SOURCE_TYPES[out.type] ? SOURCE_TYPES[out.type].label : out.type) + ' ' + (uid('').slice(-3));
    // 旧的位置预设字段迁移到 transform
    if (src.pos && !src.transform) { out.transform.pos = src.pos; out.transform.x = src.x || '10'; out.transform.y = src.y || '10'; }
    else if (src.x !== undefined || src.y !== undefined) { out.transform.x = String(src.x != null ? src.x : '10'); out.transform.y = String(src.y != null ? src.y : '10'); }
    if (src.rotate !== undefined) out.transform.rotation = Number(src.rotate) || 0;
    return out;
  }

  function normalizeScene(scene) {
    if (!scene || typeof scene !== 'object') scene = {};
    return {
      id: scene.id || uid('s'),
      name: scene.name || '场景',
      orient: scene.orient === 'port' ? 'port' : 'land',
      rotate: Number(scene.rotate) || 0,
      size: scene.size || (scene.orient === 'port' ? '1080x1920' : '1920x1080'),
      sources: Array.isArray(scene.sources) ? scene.sources.map(normalizeSource) : [],
      // v1.1.40：场景过渡配置（OBS 转场：类型 + 时长）
      transition: scene.transition || { type: 'fade_transition', durationMs: 300 }
    };
  }

  // ---------------- 引擎控制器（挂到渲染层 state） ----------------
  // opts: { state, getActiveSceneId, setActiveSceneId, getSelSrc, setSelSrc, save, tcapi, getLastProbe, getProgramScene }
  function createEngine(opts) {
    opts = opts || {};
    var state = opts.state || { cfg: { lpScenes: [] } };
    if (!state.cfg) state.cfg = {};
    if (!Array.isArray(state.cfg.lpScenes) || !state.cfg.lpScenes.length) {
      state.cfg.lpScenes = [normalizeScene({ name: '主场景', orient: 'land' })];
    }
    state.cfg.lpScenes = state.cfg.lpScenes.map(normalizeScene);
    var save = opts.save || function () {};
    var getActive = opts.getActiveSceneId || function () { return state.cfg.lpScenes[0].id; };
    var setActive = opts.setActiveSceneId || function () {};
    var getSel = opts.getSelSrc || function () { return -1; };
    var setSel = opts.setSelSrc || function () {};
    var tcapi = opts.tcapi || (typeof window !== 'undefined' ? window.tcapi : null);

    function activeScene() {
      var id = getActive();
      return state.cfg.lpScenes.filter(function (s) { return s.id === id; })[0] || state.cfg.lpScenes[0];
    }
    function programScene() {
      if (opts.getProgramScene) return opts.getProgramScene();
      return activeScene();
    }

    function listSourceTypes() {
      return SOURCE_ORDER.map(function (id) { return Object.assign({ id: id }, SOURCE_TYPES[id]); });
    }

    function addSource(typeId, extra) {
      if (!SOURCE_TYPES[typeId]) return null;
      var s = normalizeSource({ type: typeId, name: (SOURCE_TYPES[typeId].label) + ' ' + (activeScene().sources.length + 1), settings: defaultSettings(typeId) });
      if (extra) Object.assign(s, extra);
      activeScene().sources.push(s);
      setSel(activeScene().sources.length - 1);
      save();
      return s;
    }

    function getSource(index) { var a = activeScene(); return a.sources[index] || null; }

    function updateSource(index, patch) {
      var s = getSource(index); if (!s) return null;
      if (patch.name !== undefined) s.name = patch.name;
      if (patch.enabled !== undefined) { s.enabled = !!patch.enabled; s.transform.visible = !!patch.enabled; }
      if (patch.settings) s.settings = Object.assign({}, s.settings, patch.settings);
      save();
      return s;
    }

    function removeSource(index) {
      var a = activeScene(); if (!a.sources[index]) return;
      a.sources.splice(index, 1);
      var sel = getSel(); if (sel === index) setSel(-1); else if (sel > index) setSel(sel - 1);
      save();
    }

    function duplicateSource(index) {
      var a = activeScene(); var s = a.sources[index]; if (!s) return null;
      var cp = JSON.parse(JSON.stringify(s)); cp.id = uid('src');
      a.sources.splice(index + 1, 0, cp); setSel(index + 1); save(); return cp;
    }

    function reorderSource(from, to) {
      var a = activeScene(); if (!a.sources[from]) return;
      if (to < 0) to = 0; if (to >= a.sources.length) to = a.sources.length - 1;
      var item = a.sources.splice(from, 1)[0];
      a.sources.splice(to, 0, item);
      if (getSel() === from) setSel(to);
      save();
    }

    function setTransform(index, tf) {
      var s = getSource(index); if (!s) return null;
      s.transform = Object.assign({}, s.transform, tf);
      if (tf.pos) s.transform.pos = tf.pos;
      if (tf.x !== undefined) s.transform.x = String(tf.x);
      if (tf.y !== undefined) s.transform.y = String(tf.y);
      if (tf.scale) s.transform.scale = Object.assign({}, s.transform.scale, tf.scale);
      if (tf.crop) s.transform.crop = Object.assign({}, s.transform.crop, tf.crop);
      if (tf.bounds) s.transform.bounds = Object.assign({}, s.transform.bounds, tf.bounds);
      if (tf.rotation !== undefined) s.transform.rotation = Number(tf.rotation) || 0;
      save();
      return s;
    }

    // ---- v1.1.40：音频控制 ----
    function setSourceVolume(index, volume) {
      var s = getSource(index); if (!s) return null;
      var v = Number(volume); if (isNaN(v)) v = 1; if (v < 0) v = 0; if (v > 1) v = 1;
      s.volume = v;
      save();
      return s;
    }
    function setSourceMuted(index, muted) {
      var s = getSource(index); if (!s) return null;
      s.muted = !!muted;
      save();
      return s;
    }
    // ---- v1.1.40：源滤镜 ----
    function addFilter(index, filter) {
      var s = getSource(index); if (!s) return null;
      if (!s.filters) s.filters = [];
      var filterId = filter.filterId;
      // v1.1.42：按滤镜类型填入默认设置（对齐 OBS 默认值），用户可后续在属性面板编辑
      var settings = Object.assign(defaultFilterSettings(filterId), filter.settings || {});
      s.filters.push({ id: uid('flt'), filterId: filterId, name: filter.name || filterId, settings: settings });
      save();
      return s;
    }
    function removeFilter(index, filterName) {
      var s = getSource(index); if (!s || !s.filters) return null;
      var before = s.filters.length;
      s.filters = s.filters.filter(function (f) { return f.name !== filterName; });
      if (s.filters.length !== before) save();
      return s;
    }
    // v1.1.42：编辑滤镜属性（按 filterName 定位，合并 settings）
    function updateFilter(index, filterName, settings) {
      var s = getSource(index); if (!s || !s.filters) return null;
      var f = s.filters.filter(function (x) { return x.name === filterName; })[0];
      if (!f) return null;
      f.settings = Object.assign({}, f.settings, settings || {});
      save();
      return f;
    }
    // ---- v1.1.40：场景过渡 ----
    function setTransition(sceneId, transition) {
      var sc = state.cfg.lpScenes.filter(function (s) { return s.id === sceneId; })[0];
      if (!sc) return null;
      sc.transition = Object.assign({ type: 'fade_transition', durationMs: 300 }, transition);
      save();
      return sc;
    }
    function getTransition(sceneId) {
      var sc = state.cfg.lpScenes.filter(function (s) { return s.id === sceneId; })[0];
      return sc ? (sc.transition || { type: 'fade_transition', durationMs: 300 }) : { type: 'fade_transition', durationMs: 300 };
    }

    // 文件浏览：优先用 tcapi.ffPickFile（原生对话框），否则降级的 DOM <input type=file>
    // 返回 Promise<{ok, path}>
    function openFile(prop) {
      return new Promise(function (resolve) {
        var filter = prop && prop.filter ? prop.filter : 'All Files (*.*)';
        if (tcapi && typeof tcapi.ffPickFile === 'function') {
          tcapi.ffPickFile(filter).then(function (r) {
            if (r && r.ok && r.path) resolve({ ok: true, path: r.path });
            else resolve({ ok: false, path: '' });
          }).catch(function () { resolve({ ok: false, path: '' }); });
          return;
        }
        if (typeof document === 'undefined') { resolve({ ok: false, path: '' }); return; }
        var inp = document.createElement('input');
        inp.type = 'file';
        inp.style.display = 'none';
        inp.addEventListener('change', function () {
          var f = inp.files && inp.files[0];
          resolve({ ok: !!f, path: f ? (f.path || f.name) : '' });
          if (inp.parentNode) inp.parentNode.removeChild(inp);
        });
        document.body.appendChild(inp); inp.click();
      });
    }

    // ---------------- 适配到现有 ffmpeg 推流管线（legacy 形态） ----------------
    // v1.1.37：全部 7 类 OBS 来源均已能被主进程 compileSceneGraph 真正合成：
    //   image/text/ffmpeg_source/av_capture_input/monitor_capture/color_source/browser_source
    // 保留 id（主进程据此回填「来源 id → 输入流序号」）、type（OBS 原生 id）与 transform，
    // 供主进程按类型追加 -i 输入并组装 filter_complex 叠加图。
    // 注意：browser_source 在无预渲染快照时能力受限，主进程会记入 skipped 并向用户提示。
    var SRC_LABEL = { image_source: '图片', text_ft2_source: '文本' };

    function toLegacy(sources) {
      return (sources || []).map(function (s) {
        var st = s.settings || {};
        var common = {
          id: s.id, namesource: s.name, enabled: s.enabled !== false,
          pos: s.transform.pos, x: s.transform.x, y: s.transform.y,
          transform: s.transform,
          // v1.1.43：音频控制透传（多源混音用）
          volume: (s.volume !== undefined) ? s.volume : 1,
          muted: !!s.muted
        };
        if (s.type === 'image_source') {
          return Object.assign({}, common, { type: 'image', path: st.file || '', w: '' });
        }
        if (s.type === 'text_ft2_source') {
          return Object.assign({}, common, {
            type: 'text', text: st.text || '', fontsize: st.font_size || 32, color: st.color || 'white'
          });
        }
        // 其余 5 类：保留 OBS 原生 type + settings，主进程按 type 决定输入来源与合成方式
        return Object.assign({}, common, {
          type: s.type, kind: s.type, settings: st, supported: true,
          label: (SOURCE_TYPES[s.type] ? SOURCE_TYPES[s.type].label : s.type)
        });
      });
    }

    function toLegacyProgram() { return toLegacy((programScene().sources || [])); }

    // 场景集合序列化（OBS Scene Collection 同语义）
    function exportCollection() {
      return { app: 'gongfeng-workbench', kind: 'scene-collection', version: 1, exportedAt: new Date().toISOString(), scenes: state.cfg.lpScenes };
    }
    function importCollection(data) {
      var arr = Array.isArray(data) ? data : (data && Array.isArray(data.scenes) ? data.scenes : null);
      if (!arr) throw new Error('需要 { scenes: [...] } 或场景数组');
      var added = 0;
      arr.forEach(function (sc) {
        if (!sc || typeof sc !== 'object') return;
        state.cfg.lpScenes.push(normalizeScene(sc)); added++;
      });
      if (added) save();
      return added;
    }

    return {
      SOURCE_TYPES: SOURCE_TYPES,
      FILTER_TYPES: FILTER_TYPES,
      listSourceTypes: listSourceTypes,
      getProperties: getProperties,
      isPathProperty: isPathProperty,
      defaultSettings: defaultSettings,
      defaultFilterSettings: defaultFilterSettings,
      getFilterProperties: getFilterProperties,
      normalizeSource: normalizeSource,
      normalizeScene: normalizeScene,
      activeScene: activeScene,
      programScene: programScene,
      addSource: addSource,
      getSource: getSource,
      updateSource: updateSource,
      removeSource: removeSource,
      duplicateSource: duplicateSource,
      reorderSource: reorderSource,
      setTransform: setTransform,
      setSourceVolume: setSourceVolume,
      setSourceMuted: setSourceMuted,
      addFilter: addFilter,
      removeFilter: removeFilter,
      updateFilter: updateFilter,
      setTransition: setTransition,
      getTransition: getTransition,
      openFile: openFile,
      toLegacy: toLegacy,
      toLegacyProgram: toLegacyProgram,
      exportCollection: exportCollection,
      importCollection: importCollection
    };
  }

  return {
    SOURCE_TYPES: SOURCE_TYPES,
    FILTER_TYPES: FILTER_TYPES,
    createEngine: createEngine,
    normalizeSource: normalizeSource,
    normalizeScene: normalizeScene,
    defaultTransform: defaultTransform,
    defaultFilterSettings: defaultFilterSettings,
    getFilterProperties: getFilterProperties
  };
});
