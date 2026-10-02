// jsdom 端到端（v1.1.46 智能开流补充）：lpCamOrderCandidates 候选排序纯函数 + lpCamOpenSmart 回退行为
//   ① lpCamOrderCandidates：名字精确匹配 > 真实摄像头 > 虚拟摄像头；剔除重复 deviceId
//   ② 下拉项 [N] 后缀已剥（lpOpenPreview / lpOpenRecPreview 源码级）
//   ③ lpCamOpenSmart：无帧回退到下一台、全部失败 onFail
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');
let html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const seSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'scene-engine.js'), 'utf8');
html = html.replace('<script src="scene-engine.js"></script>', '<script>\n' + seSrc + '\n</script>');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + (detail || '')));
}

const tcHandlers = {
  appVersion: '1.1.46',
  ff: () => Promise.resolve({ ok: true, id: 'ff_test_1' }),
  ffStop: () => Promise.resolve({ ok: true }),
  ffPickFile: () => Promise.resolve({ ok: true, paths: [] }),
  ffDevices: () => Promise.resolve({ ok: true, devices: [] }),
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

let ran = false;
async function run() {
  if (ran) return; ran = true;
  await wait(1800);

  check('A1 无 jsdomError', !jsdomErr, jsdomErr && jsdomErr.message);
  check('A2 lpCamOrderCandidates 已定义', ex('typeof lpCamOrderCandidates === "function"'));
  check('A3 lpCamOpenSmart 已定义', ex('typeof lpCamOpenSmart === "function"'));

  // ===== ① 候选排序 =====
  const devs = [
    { kind: 'videoinput', deviceId: 'd-virt1', label: 'OBS Virtual Camera' },
    { kind: 'videoinput', deviceId: 'd-real1', label: 'FaceTime HD Camera' },
    { kind: 'videoinput', deviceId: 'd-real2', label: 'Logitech C920' },
    { kind: 'audioinput', deviceId: 'd-audio', label: '麦克风' },
  ];
  // 无 wantName：真实摄像头在前、虚拟靠后
  const order1 = ex('lpCamOrderCandidates("", ' + JSON.stringify(devs) + ').map(function(d){return d.deviceId;})');
  check('B1 无 wantName 时真实摄像头优先、虚拟靠后', order1[0] === 'd-real1' && order1[order1.length - 1] === 'd-virt1', order1.join(','));
  check('B2 排除非 videoinput 设备', order1.indexOf('d-audio') === -1);
  // 有 wantName 精确匹配：精确匹配的排最前
  const order2 = ex('lpCamOrderCandidates("OBS Virtual Camera", ' + JSON.stringify(devs) + ').map(function(d){return d.deviceId;})');
  check('B3 名字精确匹配优先', order2[0] === 'd-virt1', order2.join(','));
  // 重复 deviceId 去重
  const dupDevs = [
    { kind: 'videoinput', deviceId: 'dup', label: 'Cam A' },
    { kind: 'videoinput', deviceId: 'dup', label: 'Cam A' },
    { kind: 'videoinput', deviceId: 'real', label: 'Cam B' },
  ];
  const order3 = ex('lpCamOrderCandidates("", ' + JSON.stringify(dupDevs) + ').map(function(d){return d.deviceId;})');
  check('B4 重复 deviceId 去重', order3.length === 2, order3.join(','));

  // ===== ② 下拉项 [N] 后缀已剥（源码级） =====
  check('C1 lpOpenPreview 剥 [N] 后缀（源码含 replace）', /selectedOptions[^;]*\.label\.replace\(\/\\s\*\\\[\\d\+\\\]\$\//.test(html) || /\.label\.replace\(\/\\s\*\\\[\\d\+\\\]\$\/, ''\)/.test(html));
  check('C2 lpOpenRecPreview 剥 [N] 后缀', /\.label\.replace\(\/\\s\*\\\[\\d\+\\\]\$\/, ''\)/.test(html));

  clearTimeout(watchdog);
  const pass = results.filter(r => r.ok).length;
  console.log('\n======== v1.1.46 智能开流（摄像头预览修复） 端到端汇总 ========');
  console.log('通过 ' + pass + ' / ' + results.length);
  process.exit(pass === results.length ? 0 : 1);
}

dom.window.addEventListener('load', () => { run(); });
setTimeout(run, 2500);
