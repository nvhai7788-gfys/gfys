// jsdom 端到端（v1.1.49 直播功能 UI）：
//   ① 音频滤镜 UI 渲染（5 类滤镜、启用开关、参数输入、禁用态）
//   ② lpAudioFiltersPayload 组装（只发启用的滤镜）
//   ③ 预设（人声直播 / 音乐现场 / 全部关闭）
//   ④ 跑马灯滚动字幕 UI（来源属性里的滚动开关 / 速度 / 方向）
//   ⑤ 预览芯片对滚动文字加 marquee 动画类
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
  appVersion: '1.1.49',
  ff: () => Promise.resolve({ ok: true, id: 'ff_test_1' }),
  ffStop: () => Promise.resolve({ ok: true }),
  ffPickFile: () => Promise.resolve({ ok: true, paths: [] }),
  ffDevices: () => Promise.resolve({ ok: true, devices: [] }),
  ffAudioLevel: () => Promise.resolve({ ok: true, hasAudio: true, rmsDb: -21.1, peakDb: -14.5 }),
  ffProbe: () => Promise.resolve({ ok: true, width: 1920, height: 1080, codec: 'h264', audio: 'aac' }),
  ffList: () => Promise.resolve({ ok: true, list: [] }),
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
  console.log('已通过 ' + results.filter((r) => r.ok).length + ' / ' + results.length);
  process.exit(3);
}, 35000);

let ran = false;
async function run() {
  if (ran) return; ran = true;
  await wait(1800);

  // ===== ① 音频滤镜 UI =====
  const box = doc.getElementById('lpAudioFilters');
  check('U1 音频滤镜容器已渲染', !!box && box.children.length === 5,
    box ? '子节点 ' + box.children.length : '无容器');
  const ids = ['noise_suppress_filter', 'gain_filter', 'noise_gate_filter', 'compressor_filter', 'limiter_filter'];
  const allIds = ids.every((id) => box.querySelector('[data-af-on="' + id + '"]'));
  check('U2 五类滤镜（降噪/增益/噪声门/压缩/限幅）齐全', allIds);
  check('U3 每类滤镜都有启用开关（checkbox）',
    ids.every((id) => {
      const el = box.querySelector('[data-af-on="' + id + '"]');
      return el && el.type === 'checkbox';
    }));
  // 未启用时参数输入应为 disabled
  const gainInput = box.querySelector('[data-af="gain_filter"][data-p="db"]');
  check('U4 未启用的滤镜其参数输入为禁用态',
    !!gainInput && gainInput.disabled === true);

  // ===== ② payload 只发启用的滤镜 =====
  const p0 = ex('lpAudioFiltersPayload()');
  check('U5 默认未启用任何滤镜 → payload 为空数组',
    Array.isArray(p0) && p0.length === 0, JSON.stringify(p0));

  // 启用降噪 + 限幅
  ex('(function(){ state.cfg.lpAudioFilters = { noise_suppress_filter:{on:true,amount:-25}, limiter_filter:{on:true,threshold:-3} }; lpRenderAudioFilters(); })()');
  const p1 = ex('lpAudioFiltersPayload()');
  check('U6 启用两项 → payload 只含这两项',
    p1.length === 2 && p1.map((x) => x.id).sort().join(',') === 'limiter_filter,noise_suppress_filter',
    JSON.stringify(p1));
  check('U7 payload 参数值取自界面输入框',
    p1.filter((x) => x.id === 'noise_suppress_filter')[0].settings.amount === -25,
    JSON.stringify(p1));
  const gainAfter = doc.querySelector('[data-af="noise_suppress_filter"][data-p="amount"]');
  check('U8 启用后参数输入解除禁用', !!gainAfter && gainAfter.disabled === false);

  // ===== ③ 预设 =====
  ex('lpAfApplyPreset("voice")');
  const pv = ex('lpAudioFiltersPayload()');
  check('U9 人声直播预设：启用降噪/增益/门/压缩/限幅 五项', pv.length === 5, JSON.stringify(pv.map((x) => x.id)));
  check('U10 人声预设参数正确（增益 3dB、限幅 -3dB）',
    pv.filter((x) => x.id === 'gain_filter')[0].settings.db === 3 &&
    pv.filter((x) => x.id === 'limiter_filter')[0].settings.threshold === -3,
    JSON.stringify(pv));
  ex('lpAfApplyPreset("music")');
  const pm = ex('lpAudioFiltersPayload()');
  check('U11 音乐/现场预设：不启用噪声门（音乐动态不能被门切掉）',
    pm.length === 3 && !pm.some((x) => x.id === 'noise_gate_filter'), JSON.stringify(pm.map((x) => x.id)));
  ex('(function(){ state.cfg.lpAudioFilters = {}; lpRenderAudioFilters(); })()');
  check('U12 全部关闭 → payload 为空', ex('lpAudioFiltersPayload()').length === 0);

  // ===== ④ 跑马灯滚动字幕 UI =====
  // 构造一个文字来源场景
  ex('(function(){' +
    'var sc = lpActiveScene();' +
    'sc.sources = [{ id:"t1", type:"text_ft2_source", enabled:true, settings:{ text:"直播中 · 欢迎观看", font_size:92, color:"#ffffff" } }];' +
    'lpRenderSources();' +
    '})()');
  const scrollCb = doc.querySelector('[data-k="scroll"]');
  const speedIn = doc.querySelector('[data-k="scroll_speed"]');
  const dirSel = doc.querySelector('[data-k="scroll_dir"]');
  check('U13 文字来源出现滚动开关 / 速度 / 方向三个控件',
    !!scrollCb && !!speedIn && !!dirSel);
  check('U14 默认未勾选滚动、速度默认 60、方向默认 left',
    scrollCb && scrollCb.checked === false && speedIn && speedIn.value === '60' &&
    dirSel && dirSel.value === 'left');

  // 勾选滚动 + 改速度方向
  ex('(function(){' +
    'var cb = document.querySelector(\'[data-k="scroll"]\');' +
    'cb.checked = true; cb.dispatchEvent(new window.Event("change", { bubbles: true }));' +
    'var sp = document.querySelector(\'[data-k="scroll_speed"]\'); sp.value = "150"; sp.dispatchEvent(new window.Event("change", { bubbles: true }));' +
    'var dr = document.querySelector(\'[data-k="scroll_dir"]\'); dr.value = "right"; dr.dispatchEvent(new window.Event("change", { bubbles: true }));' +
    '})()');
  const st = ex('JSON.stringify(lpActiveScene().sources[0].settings)');
  check('U15 勾选后 settings 写入 scroll / scroll_speed / scroll_dir',
    st.indexOf('"scroll":true') >= 0 && st.indexOf('"scroll_speed":150') >= 0 && st.indexOf('"scroll_dir":"right"') >= 0,
    st);

  // ===== ⑤ 预览芯片滚动动画 =====
  ex('lpRenderOverlays();');
  const chips = doc.getElementById('lpPrevOverlay');
  const chipHtml = chips ? chips.innerHTML : '';
  check('U16 滚动文字的预览芯片带 marquee 类',
    chipHtml.indexOf('marquee') >= 0, chipHtml.slice(0, 200));
  check('U17 滚动芯片使用 CSS 动画（右滚用 lpMarqueeR）',
    chipHtml.indexOf('lpMarqueeR') >= 0, chipHtml.slice(0, 200));
  check('U18 滚动文字内容仍被正确转义（未引入未转义 HTML）',
    chipHtml.indexOf('<span>') >= 0 && chipHtml.indexOf('直播中') >= 0);

  // 关掉滚动后芯片恢复正常（不带 marquee）
  ex('(function(){' +
    'var cb = document.querySelector(\'[data-k="scroll"]\');' +
    'cb.checked = false; cb.dispatchEvent(new window.Event("change", { bubbles: true }));' +
    'lpRenderOverlays();' +
    '})()');
  check('U19 关闭滚动后预览芯片不再带 marquee',
    (doc.getElementById('lpPrevOverlay').innerHTML || '').indexOf('marquee') < 0);

  // ===== ⑥ payload 字段存在性（防「功能实现了但没接线」） =====
  // v1.1.50 教训：录制续录在主进程已实现，但渲染层 payload 漏传 autoRestart → 功能形同虚设，
  // 而既有 258 项测试全绿也没发现（单测只覆盖「传了会怎样」，没覆盖「到底传没传」）。
  // 故此处补上「payload 必须带上关键字段」的断言。
  ex('(function(){ state.cfg.lpAudioFilters = { gain_filter:{on:true,db:4} }; lpRenderAudioFilters(); })()');
  const lane = ex('JSON.stringify(lpLanePayload(0))');
  check('U20 lpLanePayload 携带 audioFilters（音频滤镜真正下发到主进程）',
    lane.indexOf('"audioFilters"') >= 0 && lane.indexOf('gain_filter') >= 0, lane.slice(0, 300));
  check('U21 lpLanePayload 携带 autoRestart（自动重连真正下发到主进程）',
    lane.indexOf('"autoRestart"') >= 0, lane.slice(0, 300));
  ex('(function(){ state.cfg.lpAudioFilters = {}; lpRenderAudioFilters(); })()');

  check('U22 无 jsdom 致命错误', !jsdomErr, jsdomErr ? jsdomErr.message : '');

  clearTimeout(watchdog);
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log('\nr94 直播功能 UI: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.log('EXCEPTION: ' + e.message); process.exit(2); });
