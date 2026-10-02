// E2E r90-main（v1.1.47）：主进程独立音频源（声音与画面解耦）参数构造回归
//  验证 buildPushArgs 对 audioPlan（source/device/url/off + 增益/延迟/混音）正确生成 ffmpeg 参数。
//  只做参数构造断言，不真起 ffmpeg 进程。
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..', '..');

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
    screen: { getPrimaryDisplay: () => ({ id: 1, label: 'primary', bounds: { x: 0, y: 0, width: 1440, height: 900 }, workAreaSize: { width: 1440, height: 900 } }), getAllDisplays: () => [{ id: 1, label: 'primary', bounds: { x: 0, y: 0, width: 1440, height: 900 }, workAreaSize: { width: 1440, height: 900 } }], on: () => {} },
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
  vm.runInContext(src + '\n;__out = { buildPushArgs, composeAudioPlan };',
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
function joined(args) { return args.join(' '); }

// ---------- 1. source 模式（默认，无 audioPlan）→ 与 v1.1.46 行为一致 ----------
const a0 = M.buildPushArgs(Object.assign({}, base));
check('A0 source（无 audioPlan）：主画面文件含音频 → 编码 AAC 且 -map 0:a?',
  joined(a0).indexOf('-c:a aac') >= 0 && joined(a0).indexOf('-ar 44100') >= 0,
  joined(a0));

// ---------- 2. off 模式 → -an 禁音轨 ----------
const a1 = M.buildPushArgs(Object.assign({}, base, { audioPlan: { mode: 'off' } }));
check('A1 off：生成 -an 且无 -c:a',
  joined(a1).indexOf('-an') >= 0 && joined(a1).indexOf('-c:a') < 0,
  joined(a1));

// ---------- 3. device 模式（Windows dshow）→ 独立音频输入 ----------
const a2 = M.buildPushArgs(Object.assign({}, base, {
  audioPlan: { mode: 'device', deviceIndex: 2, deviceName: '外接声卡', mix: false }
}));
check('A2 device：追加 -f dshow -i audio=外接声卡',
  joined(a2).indexOf('-f dshow') >= 0 && joined(a2).indexOf('audio=外接声卡') >= 0,
  joined(a2));
check('A3 device 不混音：音频图产 [aout] 且 amix 只在独立音源（无 amix=inputs=2）',
  joined(a2).indexOf('[aout]') >= 0 && joined(a2).indexOf('amix=inputs=2') < 0,
  joined(a2));
check('A4 device：跨设备带 aresample=async=1:first_pts=0',
  joined(a2).indexOf('aresample=async=1:first_pts=0') >= 0,
  joined(a2));

// ---------- 4. device 混音（mix=true + 画面有音频）→ amix=inputs=2 ----------
const a3 = M.buildPushArgs(Object.assign({}, base, {
  audioPlan: { mode: 'device', deviceIndex: 2, deviceName: '外接声卡', mix: true }
}));
check('A5 device 混音：amix=inputs=2 + duration=first + normalize=0',
  joined(a3).indexOf('amix=inputs=2') >= 0 &&
  joined(a3).indexOf('duration=first') >= 0 &&
  joined(a3).indexOf('normalize=0') >= 0,
  joined(a3));

// ---------- 5. url 模式（rtsp）→ -rtsp_transport tcp ----------
const a4 = M.buildPushArgs(Object.assign({}, base, {
  audioPlan: { mode: 'url', url: 'rtsp://audio.example/stream', mix: false }
}));
check('A6 url（rtsp）：-rtsp_transport tcp -i',
  joined(a4).indexOf('-rtsp_transport tcp') >= 0 && joined(a4).indexOf('rtsp://audio.example/stream') >= 0,
  joined(a4));

// ---------- 6. 增益/延迟进链 ----------
const a5 = M.buildPushArgs(Object.assign({}, base, {
  audioPlan: { mode: 'device', deviceIndex: 1, deviceName: '麦克风', mix: false, gain: 6, delay: 1.5 }
}));
check('A7 增益 +6dB → volume=6dB',
  joined(a5).indexOf('volume=6dB') >= 0, joined(a5));
check('A8 延迟 1.5s → adelay=1500|1500',
  joined(a5).indexOf('adelay=1500|1500') >= 0, joined(a5));

// ---------- 7. device 未选设备 → 降级 source（不拼坏命令） ----------
const a6 = M.buildPushArgs(Object.assign({}, base, {
  audioPlan: { mode: 'device', deviceIndex: '', deviceName: '', mix: false }
}));
check('A9 device 未选设备：降级回 source（无 -f dshow）',
  joined(a6).indexOf('-f dshow') < 0 && joined(a6).indexOf('-c:a aac') >= 0,
  joined(a6));

// ---------- 8. 独立音源 + 图片叠加源：inputIndex 排在图片之后 ----------
const a7 = M.buildPushArgs(Object.assign({}, base, {
  sources: [
    { id: 'img1', type: 'image_source', enabled: true, settings: { file: '/tmp/logo.png' }, transform: { x: '10', y: '10' } }
  ],
  audioPlan: { mode: 'device', deviceIndex: 2, deviceName: '外接声卡', mix: false }
}));
check('A10 图片+独立音源：图片 [1:v] 不受影响，独立音频在输入 2',
  joined(a7).indexOf('[1:v]') >= 0 && joined(a7).indexOf('[2:a]') >= 0,
  joined(a7));

// ---------- 汇总 ----------
const pass = results.filter(r => r.ok).length;
const fail = results.length - pass;
console.log('\n======== v1.1.47 主进程独立音频源回归 ========');
console.log('通过 ' + pass + ' / ' + results.length);
results.filter(r => !r.ok).forEach(r => console.log('  FAIL ' + r.name + ' -> ' + r.detail));
process.exit(fail ? 1 : 0);
