// jsdom 端到端（v1.1.45）：素材自动入场景后默认「适合画布」+ 日间主题图标饱和度
//   ① 适合画布：lpSceneAutoAddSource 添加后异步 ffProbe → transform.pos=center、boundsType=SCALE_INNER、scale 等比铺满
//   ② 日间主题：applyNavIconColors(light) 用 NAV_ICON_COLORS_LIGHT（降饱和），夜间用原色；切主题实时重刷
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

let pickPaths = [];
// ffProbe 返回 1920x1080 的横屏视频（画布 1920x1080 → 等比 k=1，居中）
const tcHandlers = {
  appVersion: '1.1.45',
  ff: () => Promise.resolve({ ok: true, id: 'ff_test_1' }),
  ffStop: () => Promise.resolve({ ok: true }),
  ffPickFile: () => Promise.resolve({ ok: true, paths: pickPaths }),
  ffDevices: () => Promise.resolve({ ok: true, devices: [{ type: 'video', index: 0, name: 'HD Webcam C920' }] }),
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

  // ===== ① 素材自动入场景后默认「适合画布」 =====
  check('A1 无 jsdomError', !jsdomErr, jsdomErr && jsdomErr.message);
  ex('lpSceneSel && lpSceneSel.dispatchEvent(new Event("change"))');
  // 添加视频素材（横屏 1920x1080，画布 1920x1080）
  ex('lpMediaAdd("D:\\\\media\\\\demo.mp4")');
  await wait(300); // 等 ffProbe Promise 回填 transform
  let sc = ex('SE.activeScene()');
  const videoSrc = sc.sources.filter(function (s) { return s.type === 'ffmpeg_source' && s.settings && String(s.settings.local_file || '').indexOf('demo.mp4') >= 0; })[0];
  check('B1 添加视频素材 → 自动出现 ffmpeg_source', !!videoSrc, JSON.stringify(sc.sources.map(function (s) { return s.type; })));
  const tf = videoSrc && videoSrc.transform;
  check('B2 默认 pos=center（居中）', !!tf && tf.pos === 'center', tf && tf.pos);
  check('B3 默认 boundsType=SCALE_INNER（适合画布语义）', !!tf && tf.boundsType === 'OBS_BOUNDS_SCALE_INNER', tf && tf.boundsType);
  check('B4 等比缩放 k=1（1920x1080→1920x1080）', !!tf && tf.scale && Math.abs(tf.scale.x - 1) < 1e-6 && Math.abs(tf.scale.y - 1) < 1e-6,
    tf && tf.scale && (tf.scale.x + '/' + tf.scale.y));
  // 图片素材（同样 1920x1080 mock）
  ex('lpMediaAdd("C:/pic/logo.png")');
  await wait(300);
  const imgSrc = ex('SE.activeScene().sources.filter(function(s){return s.type==="image_source" && s.settings && s.settings.file==="C:/pic/logo.png";})[0]');
  check('B5 添加图片素材 → image_source 同样默认适合画布',
    !!imgSrc && imgSrc.transform && imgSrc.transform.pos === 'center' && imgSrc.transform.boundsType === 'OBS_BOUNDS_SCALE_INNER',
    imgSrc && imgSrc.transform && (imgSrc.transform.pos + '/' + imgSrc.transform.boundsType));

  // 幂等：同路径重复添加不会重置已设置的 transform（跳过，直接验证不重复即可）
  const cntBefore = ex('SE.activeScene().sources.length');
  ex('lpMediaAdd("D:\\\\media\\\\demo.mp4")');
  check('B6 同路径幂等（场景来源数不变）', ex('SE.activeScene().sources.length') === cntBefore, String(ex('SE.activeScene().sources.length')));

  // ===== ② 日间主题图标饱和度 =====
  const niDark = ex('(function(){ var b=document.querySelector(\'.nav-item[data-view=overview]\'); return b ? b.style.getPropertyValue("--ni") : ""; })()');
  check('C1 夜间（默认）概览图标用高亮原色', niDark === '#34d399', niDark);
  // 切到日间主题
  ex('state.cfg.theme = "light"; applyTheme();');
  await wait(50);
  const niLight = ex('(function(){ var b=document.querySelector(\'.nav-item[data-view=overview]\'); return b ? b.style.getPropertyValue("--ni") : ""; })()');
  check('C2 日间概览图标降饱和为浅色', niLight === '#0f9d6e', niLight);
  const niLightMonitor = ex('(function(){ var b=document.querySelector(\'.nav-item[data-view=monitor]\'); return b ? b.style.getPropertyValue("--ni") : ""; })()');
  check('C3 日间在线流图标降饱和', niLightMonitor === '#dc3f3f', niLightMonitor);
  // 切回夜间
  ex('state.cfg.theme = "dark"; applyTheme();');
  await wait(50);
  const niDark2 = ex('(function(){ var b=document.querySelector(\'.nav-item[data-view=overview]\'); return b ? b.style.getPropertyValue("--ni") : ""; })()');
  check('C4 切回夜间图标恢复高亮原色', niDark2 === '#34d399', niDark2);
  // 全部 21 个菜单在日间也有降饱和配色
  const nCount = ex('document.querySelectorAll(".nav-item[data-view]").length');
  const nLightColored = ex('state.cfg.theme="light"; applyTheme(); Array.prototype.filter.call(document.querySelectorAll(".nav-item[data-view]"), function(b){ return b.style.getPropertyValue("--ni"); }).length');
  check('C5 日间全部 ' + nCount + ' 个菜单均注入降饱和配色', String(nCount) !== '0' && nLightColored === nCount, nLightColored + '/' + nCount);

  clearTimeout(watchdog);
  const pass = results.filter(r => r.ok).length;
  console.log('\n======== v1.1.45 适合画布/日间图标饱和度 端到端汇总 ========');
  console.log('通过 ' + pass + ' / ' + results.length);
  process.exit(pass === results.length ? 0 : 1);
}

dom.window.addEventListener('load', () => { run(); });
setTimeout(run, 2500);
