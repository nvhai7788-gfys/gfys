// jsdom 端到端（v1.1.37）：验证 OBS 全 7 类来源真正进入 ffmpeg 推流滤镜图
//   ① 回归：v1.1.36 的场景/来源能力、工作室排版、文件浏览不破坏
//   ② 新增：媒体源 / 摄像头 / 显示器捕获 / 色源 / 浏览器源 均能经 toLegacy 携带 id+type+settings
//   ③ 新增：main.js buildPushArgs 为各类来源追加正确 -i 输入并组装 filter_complex
//   ④ 新增：色源走 lavfi（无需 -i）；浏览器源无快照时不再静默丢失而是记入 skipped
//   ⑤ 新增：来源属性对话框为设备类 list 属性渲染「扫描设备」按钮（动态枚举入口）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { JSDOM, VirtualConsole } = require('jsdom');
const { compileSceneGraph } = require('../../ffmpeg-args');

const ROOT = require('path').resolve(__dirname, '..', '..');
let html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const seSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'scene-engine.js'), 'utf8');
html = html.replace('<script src="scene-engine.js"></script>', '<script>\n' + seSrc + '\n</script>');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + (detail || '')));
}

let pickPath = '/tmp/watermark.png';
const tcHandlers = {
  appVersion: '1.1.37',
  ff: () => Promise.resolve({ ok: true, id: 'ff_test_1' }),
  ffStop: () => Promise.resolve({ ok: true }),
  ffPickFile: () => Promise.resolve({ ok: true, path: pickPath }),
  ffDevices: () => Promise.resolve({ ok: true, devices: [
    { type: 'video', index: 0, name: 'HD Webcam C920' },
    { type: 'video', index: 1, name: 'USB Capture Card' }
  ] }),
  ffProbe: () => Promise.resolve({ ok: true, width: 1920, height: 1080, codec: 'h264', audio: 'aac' }),
  ffList: () => Promise.resolve({ ok: true, list: [] }),
  ffRelay: () => Promise.resolve({ ok: true, url: 'http://127.0.0.1:8123/live.flv' }),
  ffRelayStop: () => Promise.resolve({ ok: true }),
  ffListEncoders: () => Promise.resolve({ ok: true, list: [] }),
  call: () => Promise.resolve({ ok: true, data: {} }),
  acall: () => Promise.resolve({ ok: true, data: {} }),
};

const vc = new VirtualConsole();
let jsdomErr = null;
vc.on('jsdomError', (e) => { jsdomErr = e; console.log('  [jsdomError]', e.message); });

const dom = new JSDOM(html, {
  runScripts: 'dangerously', url: 'https://localhost/', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(window) {
    window.tcapi = new Proxy({}, { get(t, p) { return (p in tcHandlers) ? tcHandlers[p] : (() => Promise.resolve({ ok: true, data: {} })); } });
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  }
});
const { window } = dom;
const doc = window.document;
const ex = (js) => window.eval(js);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const watchdog = setTimeout(() => {
  console.log('\n[WATCHDOG] 超时');
  console.log('已通过 ' + results.filter(r => r.ok).length + ' / ' + results.length);
  process.exit(3);
}, 35000);

// ---- 独立加载 main.js 的纯函数（复刻 e2e_r68_main 的 stub 方式）----
function loadMainFns() {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const stubElectron = {
    app: { whenReady: () => Promise.resolve(), on: () => {}, commandLine: { appendSwitch: () => {} },
           quit: () => {}, getPath: () => os.tmpdir(), getName: () => 'test', getVersion: () => '0.0.0',
           isPackaged: false, requestSingleInstanceLock: () => true },
    BrowserWindow: function () { return { loadFile: () => {}, on: () => {}, once: () => {},
      webContents: { send: () => {}, on: () => {}, executeJavaScript: () => {} },
      isDestroyed: () => true, show: () => {}, close: () => {}, setTitle: () => {} }; },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
    shell: { openExternal: () => {}, openPath: () => {}, showItemInFolder: () => {} },
    dialog: { showOpenDialog: () => Promise.resolve({ canceled: true }), showMessageBox: () => {}, showSaveDialog: () => {} },
    Notification: function () { return { show: () => {} }; },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
    Menu: { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} },
    nativeImage: { createFromPath: () => ({}) },
    Tray: function () { return { on: () => {}, setToolTip: () => {}, setContextMenu: () => {} }; }
  };
  const sandbox = {
    console, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error,
    __dirname: ROOT, __filename: path.join(ROOT, 'main.js'), module: { exports: {} },
    exports: {}, require: (m) => (m === 'electron' ? stubElectron
      : require(m.startsWith('.') ? path.resolve(ROOT, m) : m))
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;__out = { buildPushArgs, ffSourceInputArgs, ffNeedsInput };', sandbox, { filename: 'main.js' });
  return sandbox.__out;
}
const M = loadMainFns();

let ran = false;
async function run() {
  if (ran) return; ran = true;
  await wait(1800);

  // ===== ① 回归：加载与基础结构 =====
  check('A1 无 jsdomError（SceneEngine 已定义）', !jsdomErr, jsdomErr && jsdomErr.message);
  check('A2 SceneEngine 已加载', typeof ex('typeof SceneEngine') === 'string' && ex('typeof SceneEngine') === 'object');
  check('A3 工作室模式排版存在', !!doc.querySelector('#lpStudio') || !!doc.querySelector('.studio'));

  // ===== ② 来源类型注册表覆盖 7 类，新增属性齐备 =====
  const types = ex('SE.listSourceTypes().map(function(t){return t.id;})');
  check('B1 来源注册表 7 类', Array.isArray(types) && types.length === 7, JSON.stringify(types));
  const colorProps = ex('SE.getProperties("color_source").map(function(p){return p.key;})');
  check('B2 色源含 color/width/height 属性', colorProps.indexOf('color') >= 0 && colorProps.indexOf('width') >= 0, JSON.stringify(colorProps));
  const browserProps = ex('SE.getProperties("browser_source").map(function(p){return p.key;})');
  check('B3 浏览器源含 snapshot 降级属性', browserProps.indexOf('snapshot') >= 0, JSON.stringify(browserProps));
  const mediaProps = ex('SE.getProperties("ffmpeg_source").map(function(p){return p.key;})');
  check('B4 媒体源含网络流 input 属性', mediaProps.indexOf('input') >= 0, JSON.stringify(mediaProps));
  const devDynamic = ex('SE.getProperties("av_capture_input")[0].dynamic');
  check('B5 摄像头设备属性标记为 dynamic（动态枚举）', devDynamic === true, String(devDynamic));

  // ===== ③ toLegacy：5 类来源携带 id/type/settings，supported 为 true =====
  const legacy = ex('(function(){' +
    'var s=SE.activeScene(); s.sources=[];' +
    'SE.addSource("ffmpeg_source"); SE.addSource("av_capture_input"); SE.addSource("monitor_capture");' +
    'SE.addSource("color_source"); SE.addSource("browser_source");' +
    'return SE.toLegacyProgram();})()');
  check('C1 toLegacy 输出 5 条', Array.isArray(legacy) && legacy.length === 5, JSON.stringify(legacy && legacy.length));
  check('C2 全部携带 id（主进程回填输入序号所需）',
    legacy.every(s => !!s.id), JSON.stringify(legacy.map(s => s.id)));
  check('C3 全部 supported=true（不再标 false）',
    legacy.every(s => s.supported === true), JSON.stringify(legacy.map(s => s.supported)));
  check('C4 保留 OBS 原生 type',
    legacy.map(s => s.type).join(',') === 'ffmpeg_source,av_capture_input,monitor_capture,color_source,browser_source',
    JSON.stringify(legacy.map(s => s.type)));
  check('C5 媒体源/摄像头保留 settings 对象',
    typeof legacy[0].settings === 'object' && typeof legacy[1].settings === 'object');
  check('C6 全部携带 transform（叠加层变换所需）',
    legacy.every(s => s.transform && s.transform.scale), JSON.stringify(legacy.map(s => !!s.transform)));

  // ===== ④ main.js：各类来源的输入构造 =====
  check('D1 色源不需要独立 -i', M.ffNeedsInput('color_source') === false);
  check('D2 文字源不需要独立 -i', M.ffNeedsInput('text_ft2_source') === false);
  check('D3 其余 5 类需要独立 -i',
    ['ffmpeg_source','image_source','av_capture_input','monitor_capture','browser_source']
      .every(t => M.ffNeedsInput(t) === true));

  // ===== ⑤ buildPushArgs 集成：多源同时进入滤镜 =====
  const base = {
    rtmp: ['rtmp://example.com/live/x'], videoBitrate: '2500', outSize: '1920x1080', fps: 25,
    copy: false, codec: 'libx264', preset: 'veryfast', gopSec: 2, audioBr: '128k',
    source: { type: 'file', path: '/tmp/main.mp4' }
  };
  const args1 = M.buildPushArgs(Object.assign({}, base, {
    sources: [
      { id: 'm1', type: 'ffmpeg_source', enabled: true, settings: { local_file: '/tmp/pip.mp4' }, transform: { x: '40', y: '40', scale: { x: 0.5, y: 0.5 } } },
      { id: 'c1', type: 'color_source', enabled: true, settings: { color: '#1e90ff' }, transform: { x: '0', y: '0' } },
      { id: 't1', type: 'text_ft2_source', enabled: true, settings: { text: '港丰直播', color: '#ffffff' }, transform: { x: '20', y: '20' } }
    ]
  }));
  const j1 = args1.join(' ');
  check('E1 媒体源追加 -i /tmp/pip.mp4', j1.indexOf('-i /tmp/pip.mp4') >= 0, j1);
  check('E2 色源走 lavfi color（0x1e90ff）', j1.indexOf('color=c=0x1e90ff') >= 0, j1);
  check('E3 生成 filter_complex 且含 overlay', j1.indexOf('-filter_complex') >= 0 && j1.indexOf('overlay') >= 0, j1);
  check('E4 文字源渲染为 drawtext 且中文正确', j1.indexOf("drawtext=text='港丰直播'") >= 0, j1);
  check('E5 媒体源缩放进入叠加链', j1.indexOf('scale=iw*0.5:ih*0.5') >= 0, j1);

  // ===== ⑥ compileSceneGraph 与 main.js 口径一致 =====
  const g = compileSceneGraph({ outSize: '1920x1080' }, [
    { id: 'i1', type: 'image_source', enabled: true, settings: { file: '/tmp/logo.png' }, transform: { x: '10', y: '10' } },
    { id: 'c1', type: 'color_source', enabled: true, settings: { color: '#ff0000' }, transform: { x: '0', y: '0' } }
  ], { i1: 1 });
  check('F1 compileSceneGraph：图片来源消耗输入序号 1', g.consumed.indexOf('i1') >= 0);
  check('F2 compileSceneGraph：色源无需输入序号也能合成', g.consumed.indexOf('c1') >= 0);
  check('F3 compileSceneGraph：两端均以 [vout] 收尾', /\[vout\]$/.test(g.complex), g.complex);

  // ===== ⑦ 浏览器源无快照 → 记入 skipped（不再静默丢失） =====
  const g2 = compileSceneGraph({ outSize: '1280x720' }, [
    { id: 'b1', type: 'browser_source', enabled: true, settings: { url: 'https://x.com' }, transform: { x: '0', y: '0' } }
  ], {});
  check('G1 浏览器源无快照 → skipped 有记录', g2.skipped.some(s => s.id === 'b1'), JSON.stringify(g2.skipped));

  // ===== ⑧ 来源属性对话框：设备类属性渲染「扫描设备」入口 =====
  ex('(function(){var s=SE.activeScene(); s.sources=[]; SE.addSource("av_capture_input");})()');
  ex('lpOpenSourceProps(0)');
  await wait(120);
  const modal = doc.querySelector('#lpSrcPropsModal');
  check('H1 摄像头来源属性对话框可打开', !!modal && modal.style.display === 'flex', modal && modal.style.display);
  const scanBtn = doc.querySelector('#lpSrcPropsBody [data-scan]');
  check('H2 设备属性渲染「扫描设备」按钮', !!scanBtn, scanBtn ? scanBtn.textContent : 'none');
  // 点击扫描 → 设备下拉被填充
  if (scanBtn) {
    scanBtn.click();
    await wait(220);
    const sel = doc.querySelector('#lpSrcPropsBody select[data-pk="device"]');
    const optCount = sel ? sel.querySelectorAll('option').length : 0;
    check('H3 扫描后设备下拉填充枚举结果', optCount >= 2, 'options=' + optCount);
  } else {
    check('H3 扫描后设备下拉填充枚举结果', false, '无扫描按钮');
  }
  ex('lpCloseSourceProps()');

  // ===== ⑨ 回归：竖屏 transpose 仍生效 =====
  const g3 = compileSceneGraph({ outSize: '1080x1920', inW: 1920, inH: 1080 }, [
    { id: 'd1', type: 'av_capture_input', enabled: true, settings: { device: 'HD Webcam' }, transform: { x: '0', y: '0' } }
  ], { d1: 1 });
  check('J1 竖屏画布 + 横向源 → transpose=1 进入基础画布链', g3.complex.indexOf('transpose=1') >= 0, g3.complex);
  check('J2 竖屏画布 → scale=1080:1920', g3.complex.indexOf('scale=1080:1920') >= 0, g3.complex);

  clearTimeout(watchdog);
  const pass = results.filter(r => r.ok).length;
  console.log('\n======== v1.1.37 端到端汇总 ========');
  console.log('通过 ' + pass + ' / ' + results.length);
  results.filter(r => !r.ok).forEach(r => console.log('  FAIL ' + r.name + ' -> ' + (r.detail || '')));
  process.exit(pass === results.length ? 0 : 1);
}

dom.window.addEventListener('load', () => { setTimeout(run, 200); });
setTimeout(run, 2500);
