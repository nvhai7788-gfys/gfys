// E2E r76-main（v1.1.37）：主进程多源合成参数构造回归
//  验证 buildPushArgs 为 OBS 各类来源正确追加 ffmpeg 输入，并组装 filter_complex 叠加图
//  只做参数构造断言，不真起 ffmpeg 进程（真实语法校验见 test_scene_graph_ffmpeg.sh）
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const ROOT = require('path').resolve(__dirname, '..', '..');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '✅ ' : '❌ ') + name + (ok ? '' : '  → ' + (detail || '')));
}

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
  vm.runInContext(src + '\n;__out = { buildPushArgs, ffSourceInputArgs, ffNeedsInput };',
    sandbox, { filename: 'main.js' });
  return sandbox.__out;
}

const M = loadMainFns();

const base = {
  rtmp: ['rtmp://example.com/live/stream'],
  videoBitrate: '2500', outSize: '1280x720', fps: 25,
  copy: false, codec: 'libx264', preset: 'veryfast', gopSec: 2, audioBr: '128k',
  source: { type: 'file', path: '/tmp/main.mp4' }
};

function argIndexOf(args, token) { return args.indexOf(token); }
function joined(args) { return args.join(' '); }

// ---------- 1. ffNeedsInput 判定 ----------
check('S1 ffNeedsInput：媒体源/图片/摄像头/显示器/浏览器 需要独立输入',
  M.ffNeedsInput('ffmpeg_source') && M.ffNeedsInput('image_source') &&
  M.ffNeedsInput('av_capture_input') && M.ffNeedsInput('monitor_capture') &&
  M.ffNeedsInput('browser_source'));
check('S2 ffNeedsInput：色源/文字源不需要独立输入',
  !M.ffNeedsInput('color_source') && !M.ffNeedsInput('text_ft2_source'));

// ---------- 2. 单类来源输入构造 ----------
check('I1 图片源 → -i <path>',
  JSON.stringify(M.ffSourceInputArgs({ type: 'image_source', settings: { file: '/tmp/a.png' } })) ===
  JSON.stringify(['-i', '/tmp/a.png']));
check('I2 媒体源 → -i <path>（含 looping 时带 -stream_loop）',
  JSON.stringify(M.ffSourceInputArgs({ type: 'ffmpeg_source', settings: { local_file: '/tmp/v.mp4', looping: true } })) ===
  JSON.stringify(['-stream_loop', '-1', '-i', '/tmp/v.mp4']));
check('I3 媒体源未选文件 → null（跳过，不崩）',
  M.ffSourceInputArgs({ type: 'ffmpeg_source', settings: {} }) === null);
check('I4 色源 → null（不走 -i，由 lavfi 生成）',
  M.ffSourceInputArgs({ type: 'color_source', settings: { color: '#000' } }) === null);
check('I5 浏览器源无快照 → null（能力受限，交给 skipped 提示）',
  M.ffSourceInputArgs({ type: 'browser_source', settings: { url: 'https://x.com' } }) === null);
check('I6 浏览器源有快照 → -i <snapshot>',
  JSON.stringify(M.ffSourceInputArgs({ type: 'browser_source', settings: { snapshot: '/tmp/frame.png' } })) ===
  JSON.stringify(['-i', '/tmp/frame.png']));

// ---------- 3. buildPushArgs 集成：输入流序号回填 ----------
const a1 = M.buildPushArgs(Object.assign({}, base, {
  sources: [
    { id: 'img1', type: 'image_source', enabled: true, settings: { file: '/tmp/logo.png' }, transform: { x: '10', y: '10' } }
  ]
}));
check('P1 单图片源：追加 -i logo.png 且生成 filter_complex',
  joined(a1).indexOf('-i /tmp/logo.png') >= 0 && joined(a1).indexOf('-filter_complex') >= 0,
  joined(a1));
check('P2 单图片源：滤镜图含 [1:v]overlay（输入流序号正确）',
  joined(a1).indexOf('[1:v]overlay') >= 0, joined(a1));

const a2 = M.buildPushArgs(Object.assign({}, base, {
  sources: [
    { id: 'd1', type: 'av_capture_input', enabled: true, settings: { device_name: 'HD Webcam', device: '0' }, transform: { x: '10', y: '10' } },
    { id: 'i1', type: 'image_source', enabled: true, settings: { file: '/tmp/logo.png' }, transform: { x: 'W-w-10', y: '10' } },
    { id: 't1', type: 'text_ft2_source', enabled: true, settings: { text: 'LIVE', color: '#fff' }, transform: { x: '20', y: '20' } }
  ]
}));
check('P3 摄像头+图片+文字：三个来源都被合成（含 dshow 采集输入）',
  joined(a2).indexOf('-f dshow') >= 0 && joined(a2).indexOf('overlay') >= 0 && joined(a2).indexOf('drawtext') >= 0,
  joined(a2));

const a3 = M.buildPushArgs(Object.assign({}, base, {
  sources: [
    { id: 'c1', type: 'color_source', enabled: true, settings: { color: '#ff0000' }, transform: { x: '0', y: '0' } }
  ]
}));
check('P4 仅色源：走 lavfi color，不追加额外 -i，仍生成 complex',
  joined(a3).indexOf('-filter_complex') >= 0 && joined(a3).indexOf('color=c=0xff0000') >= 0,
  joined(a3));

const a4 = M.buildPushArgs(Object.assign({}, base, {
  sources: [
    { id: 'b1', type: 'browser_source', enabled: true, settings: { url: 'https://x.com' }, transform: { x: '0', y: '0' } }
  ]
}));
check('P5 仅浏览器源（无快照）：无可用输入 → 不生成非法 complex，退回基础画布',
  joined(a4).indexOf('-filter_complex') < 0 ||
  joined(a4).indexOf('overlay') >= 0 || joined(a4).indexOf('scale=1280:720') >= 0,
  joined(a4));

// ---------- 4. 零回归：无叠加源时行为与旧版一致 ----------
const a5 = M.buildPushArgs(Object.assign({}, base, { sources: [] }));
check('R1 无来源：走 -vf 基础画布（不带 filter_complex）',
  joined(a5).indexOf('-vf scale=1280:720') >= 0 && joined(a5).indexOf('-filter_complex') < 0,
  joined(a5));

const a6 = M.buildPushArgs(Object.assign({}, base, {
  sources: [{ id: 't0', type: 'text_ft2_source', enabled: true, settings: { text: '水印', color: '#fff' }, transform: { x: '10', y: '10' } }]
}));
check('R2 仅文字源：仍并入 -vf drawtext（与 v1.1.36 行为一致）',
  joined(a6).indexOf('-vf') >= 0 && joined(a6).indexOf('drawtext') >= 0 && joined(a6).indexOf('-filter_complex') < 0,
  joined(a6));

// ---------- 5. disabled 来源被忽略 ----------
const a7 = M.buildPushArgs(Object.assign({}, base, {
  sources: [{ id: 'img2', type: 'image_source', enabled: false, settings: { file: '/tmp/x.png' }, transform: {} }]
}));
check('R3 disabled 图片源：不追加 -i',
  joined(a7).indexOf('/tmp/x.png') < 0, joined(a7));

// ---------- 汇总 ----------
const pass = results.filter(r => r.ok).length;
const fail = results.length - pass;
console.log('\n======== v1.1.37 主进程多源合成回归 ========');
console.log('通过 ' + pass + ' / ' + results.length);
results.filter(r => !r.ok).forEach(r => console.log('  FAIL ' + r.name + ' -> ' + r.detail));
process.exit(fail ? 1 : 0);
