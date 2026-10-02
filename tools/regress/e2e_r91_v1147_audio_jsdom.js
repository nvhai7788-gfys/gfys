// jsdom 端到端（v1.1.47 音频来源与检测）：
//   ① 音频来源 UI 存在（lpAudioMode / lpAudioDev / lpAudioUrl / 电平条）
//   ② 模式切换联动（device/url 显示对应配置项，增益/延迟/混音禁用态）
//   ③ lpAudioPlanPayload 组装四模式 payload
//   ④ lpAudioLevelArg 三类来源入参（device/url/path/source）
//   ⑤ 电平条 -60→0% / 0→100% / 触顶削波变红
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
  appVersion: '1.1.47',
  ff: () => Promise.resolve({ ok: true, id: 'ff_test_1' }),
  ffStop: () => Promise.resolve({ ok: true }),
  ffPickFile: () => Promise.resolve({ ok: true, paths: [] }),
  ffDevices: () => Promise.resolve({ ok: true, devices: [
    { type: 'video', index: '0', name: 'HD Webcam' },
    { type: 'audio', index: '1', name: '外接声卡' },
    { type: 'audio', index: '2', name: '麦克风' }
  ] }),
  ffAudioLevel: () => Promise.resolve({ ok: true, hasAudio: true, rmsDb: -21.1, peakDb: -14.5 }),
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
  check('A2 lpAudioPlanPayload 已定义', ex('typeof lpAudioPlanPayload === "function"'));
  check('A3 lpAudioLevelArg 已定义', ex('typeof lpAudioLevelArg === "function"'));
  check('A4 lpAudioModeApply 已定义', ex('typeof lpAudioModeApply === "function"'));

  // ===== ① UI 元素存在 =====
  check('B1 声音来源下拉 lpAudioMode 存在', !!doc.getElementById('lpAudioMode'));
  check('B2 音频设备下拉 lpAudioDev 存在', !!doc.getElementById('lpAudioDev'));
  check('B3 音频地址输入 lpAudioUrl 存在', !!doc.getElementById('lpAudioUrl'));
  check('B4 增益 lpAudioGain / 延迟 lpAudioDelay 存在', !!doc.getElementById('lpAudioGain') && !!doc.getElementById('lpAudioDelay'));
  check('B5 混音 lpAudioMix 存在', !!doc.getElementById('lpAudioMix'));
  check('B6 电平条 lpRmsFill / lpPeakFill 存在', !!doc.getElementById('lpRmsFill') && !!doc.getElementById('lpPeakFill'));
  check('B7 检测按钮 lpAudioLevelBtn 存在', !!doc.getElementById('lpAudioLevelBtn'));

  // ===== ② 模式切换联动 =====
  ex('document.getElementById("lpAudioMode").value = "device"; lpAudioModeApply();');
  check('C1 device 模式显示设备下拉', doc.getElementById('lpAudioDevBox').style.display !== 'none');
  check('C2 device 模式隐藏地址框', doc.getElementById('lpAudioUrlBox').style.display === 'none');
  check('C3 device 模式增益/延迟/混音可用', !doc.getElementById('lpAudioGain').disabled && !doc.getElementById('lpAudioMix').disabled);
  ex('document.getElementById("lpAudioMode").value = "url"; lpAudioModeApply();');
  check('C4 url 模式显示地址框', doc.getElementById('lpAudioUrlBox').style.display !== 'none');
  check('C5 url 模式隐藏设备下拉', doc.getElementById('lpAudioDevBox').style.display === 'none');
  ex('document.getElementById("lpAudioMode").value = "source"; lpAudioModeApply();');
  check('C6 source 模式两者皆隐藏', doc.getElementById('lpAudioDevBox').style.display === 'none' && doc.getElementById('lpAudioUrlBox').style.display === 'none');
  check('C7 source 模式增益/延迟/混音禁用', doc.getElementById('lpAudioGain').disabled && doc.getElementById('lpAudioMix').disabled);

  // 先给 lpAudioDev 填充可选项（jsdom 下 select.value 需存在对应 option 才生效）
  ex('document.getElementById("lpAudioDev").innerHTML = "<option value=\\"\\">请选择音频设备</option><option value=\\"1\\">外接声卡 [1]</option><option value=\\"2\\">麦克风 [2]</option>";');

  // ===== ③ lpAudioPlanPayload 四模式 =====
  ex('document.getElementById("lpAudioMode").value = "source";');
  const p1 = ex('lpAudioPlanPayload()');
  check('D1 source payload', p1.mode === 'source', JSON.stringify(p1));
  ex('document.getElementById("lpAudioMode").value = "device"; document.getElementById("lpAudioDev").value = "1"; window._lpDevNames = { a1: "外接声卡" };');
  const p2 = ex('lpAudioPlanPayload()');
  check('D2 device payload（deviceIndex + deviceName）', p2.mode === 'device' && p2.deviceIndex === '1' && p2.deviceName === '外接声卡', JSON.stringify(p2));
  ex('document.getElementById("lpAudioMode").value = "url"; document.getElementById("lpAudioUrl").value = "http://x/a.mp3";');
  const p3 = ex('lpAudioPlanPayload()');
  check('D3 url payload', p3.mode === 'url' && p3.url === 'http://x/a.mp3', JSON.stringify(p3));
  ex('document.getElementById("lpAudioMode").value = "off";');
  const p4 = ex('lpAudioPlanPayload()');
  check('D4 off payload', p4.mode === 'off', JSON.stringify(p4));
  // 增益/延迟回填
  ex('document.getElementById("lpAudioMode").value = "device"; document.getElementById("lpAudioGain").value = "6"; document.getElementById("lpAudioDelay").value = "1.5";');
  const p5 = ex('lpAudioPlanPayload()');
  check('D5 增益/延迟进 payload', p5.gain === 6 && p5.delay === 1.5, JSON.stringify(p5));

  // ===== ④ lpAudioLevelArg 三类来源 =====
  ex('document.getElementById("lpAudioMode").value = "device"; document.getElementById("lpAudioDev").value = "1"; window._lpDevNames = { a1: "外接声卡" };');
  const l1 = ex('lpAudioLevelArg()');
  check('E1 device 电平入参', l1 && l1.deviceIndex === '1' && l1.deviceName === '外接声卡', JSON.stringify(l1));
  ex('document.getElementById("lpAudioMode").value = "url"; document.getElementById("lpAudioUrl").value = "http://x/a.mp3";');
  const l2 = ex('lpAudioLevelArg()');
  check('E2 url 电平入参（网络地址）', l2 && l2.url === 'http://x/a.mp3', JSON.stringify(l2));
  ex('document.getElementById("lpAudioUrl").value = "/tmp/x.mp3";');
  const l3 = ex('lpAudioLevelArg()');
  check('E3 本机文件电平入参（path）', l3 && l3.path === '/tmp/x.mp3', JSON.stringify(l3));
  ex('document.getElementById("lpAudioMode").value = "device"; document.getElementById("lpAudioDev").value = ""; window._lpDevNames = {};');
  const l4 = ex('lpAudioLevelArg()');
  check('E4 device 未选设备 → null', l4 === null, JSON.stringify(l4));

  // ===== ⑤ 电平条绘制 =====
  ex('lpAudioMeterPaint(-21.1, -14.5)');
  check('F1 电平条填充宽度（-21.1dB ≈ 65%）', doc.getElementById('lpRmsFill').style.width === '65%', doc.getElementById('lpRmsFill').style.width);
  check('F2 峰值文本含 dB', /-14\.5 dB/.test(doc.getElementById('lpPeakVal').textContent), doc.getElementById('lpPeakVal').textContent);
  ex('lpAudioMeterPaint(-0.5, -0.3)');
  check('F3 触顶削波变红（clip）', doc.getElementById('lpRmsFill').classList.contains('clip'), '');
  ex('lpAudioMeterPaint(null, null)');
  check('F4 无数据时电平条归零 + --', doc.getElementById('lpRmsFill').style.width === '0%' && doc.getElementById('lpRmsVal').textContent === '--', '');

  clearTimeout(watchdog);
  const pass = results.filter(r => r.ok).length;
  console.log('\n======== v1.1.47 音频来源与检测 端到端汇总 ========');
  console.log('通过 ' + pass + ' / ' + results.length);
  process.exit(pass === results.length ? 0 : 1);
}

dom.window.addEventListener('load', () => { run(); });
setTimeout(run, 2500);
