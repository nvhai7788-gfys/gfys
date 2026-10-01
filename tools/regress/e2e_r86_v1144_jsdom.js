// jsdom 端到端（v1.1.44）：素材输入融合进工作室 + 素材自动入场景 + 侧边栏彩色图标
//   ① 融合排版：素材输入区（lpMediaList/lpDeviceBox）位于工作室卡片内，推流卡片不再有重复来源选择
//   ② 自动入场景：lpMediaAdd 视频→ffmpeg_source、图片→image_source；同路径幂等；名称=文件名
//   ③ 联动移除：素材删除/清空 → 场景来源同步移除
//   ④ 设备联动：lpDeviceVideo 变化 → 场景自动出现 av_capture_input
//   ⑤ 彩色图标：每个 nav-item 注入 --ni 主题色，激活态白色高亮 CSS 仍在
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
const tcHandlers = {
  appVersion: '1.1.44',
  ff: () => Promise.resolve({ ok: true, id: 'ff_test_1' }),
  ffStop: () => Promise.resolve({ ok: true }),
  ffPickFile: () => Promise.resolve({ ok: true, paths: pickPaths }),
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

let ran = false;
async function run() {
  if (ran) return; ran = true;
  await wait(1800);

  // ===== ① 融合排版结构 =====
  check('A1 无 jsdomError', !jsdomErr, jsdomErr && jsdomErr.message);
  const studioCard = doc.querySelector('#lpStudioCard');
  check('A2 工作室卡片存在', !!studioCard);
  const mediaList = doc.querySelector('#lpMediaList');
  check('A3 素材列表位于工作室卡片内（融合）', !!mediaList && !!mediaList.closest('#lpStudioCard'));
  const deviceBox = doc.querySelector('#lpDeviceBox');
  check('A4 设备选择位于工作室卡片内（融合）', !!deviceBox && !!deviceBox.closest('#lpStudioCard'));
  const srcTypeRadios = doc.querySelectorAll('input[name="lpSrcType"]');
  check('A5 推流来源单选在工作室卡片内', srcTypeRadios.length === 2 && !!srcTypeRadios[0].closest('#lpStudioCard'));
  const playMode = doc.querySelector('#lpPlayMode');
  check('A6 播放模式仍在推流设置卡片（不重复）', !!playMode && !!playMode.closest('.card') && !playMode.closest('#lpStudioCard'));
  check('A7 lpMediaAddBtn/lpMediaClearBtn 唯一（无重复 id）',
    doc.querySelectorAll('#lpMediaAddBtn').length === 1 && doc.querySelectorAll('#lpMediaClearBtn').length === 1);
  const fusionTip = (studioCard && studioCard.textContent.indexOf('自动出现在下方场景来源') >= 0);
  check('A8 工作室含融合说明文案', !!fusionTip);

  // ===== ② 素材自动入场景 =====
  ex('lpSceneSel && lpSceneSel.dispatchEvent(new Event("change"))');
  const srcCount0 = ex('SE.activeScene().sources.length');
  pickPaths = ['D:/media/demo.mp4'];
  ex('lpMediaAdd("D:\\\\media\\\\demo.mp4")');
  let sc = ex('SE.activeScene()');
  const videoSrc = sc.sources.filter(function (s) { return s.type === 'ffmpeg_source' && s.settings && String(s.settings.local_file || '').indexOf('demo.mp4') >= 0; })[0];
  check('B1 添加视频素材 → 自动出现 ffmpeg_source', !!videoSrc, JSON.stringify(sc.sources.map(function (s) { return s.type; })));
  check('B2 来源名 = 文件名（OBS 同款）', !!videoSrc && videoSrc.name === 'demo.mp4', videoSrc && videoSrc.name);
  check('B3 is_local_file 已置 true', !!videoSrc && videoSrc.settings.is_local_file === true);
  // 幂等：同路径再加不重复
  ex('lpMediaAdd("D:\\\\media\\\\demo.mp4")');
  check('B4 同路径重复添加幂等（素材列表 1 项）', ex('lpMedia.length') === 1);
  const cnt1 = ex('SE.activeScene().sources.length');
  ex('window.__dup = 0; SE.activeScene().sources.forEach(function(s){ if(s.type==="ffmpeg_source" && String(s.settings.local_file||"").indexOf("demo.mp4")>=0) window.__dup++; })');
  const dup = ex('window.__dup');
  check('B5 场景中同路径来源仍为 1 个', dup === 1 && cnt1 === srcCount0 + 1, '场景来源数 ' + cnt1);
  // 图片 → image_source
  ex('lpMediaAdd("C:/pic/logo.png")');
  const imgSrc = ex('SE.activeScene().sources.filter(function(s){return s.type==="image_source" && s.settings.file==="C:/pic/logo.png";})[0]');
  check('B6 添加图片素材 → 自动出现 image_source', !!imgSrc);

  // ===== ③ 联动移除 =====
  // 直接走 UI 按钮路径：点击素材行的 ✕（del）
  ex('(function(){ var btns=document.querySelectorAll("#lpMediaList button[data-mact=del]"); btns[btns.length-1].click(); })()');
  const imgGone = ex('SE.activeScene().sources.filter(function(s){return s.type==="image_source" && s.settings && s.settings.file==="C:/pic/logo.png";}).length');
  check('C1 点击素材 ✕ → 场景 image_source 同步移除', imgGone === 0);
  ex('lpMediaClearBtn && lpMediaClearBtn.click()');
  const vidGone = ex('SE.activeScene().sources.filter(function(s){return s.type==="ffmpeg_source" && s.settings && String(s.settings.local_file||"").indexOf("demo.mp4")>=0;}).length');
  check('C2 清空素材列表 → 场景 ffmpeg_source 同步移除', vidGone === 0);
  check('C3 场景来源数恢复', ex('SE.activeScene().sources.length') === srcCount0);

  // ===== ④ 设备联动 =====
  ex('document.querySelector(\'input[name=lpSrcType][value=device]\').click()');
  // 走真实「扫描设备」路径填充下拉（tcapi.ffDevices mock 返回 2 个视频设备）
  ex('document.querySelector("#lpScanDevBtn").click()');
  await wait(400);
  const vOpts = ex('(function(){ var s=document.querySelector("#lpDeviceVideo"); return Array.prototype.map.call(s.options, function(o){ return o.value; }); })()');
  check('D0 扫描设备后下拉已填充', Array.isArray(vOpts) && vOpts.length >= 2, JSON.stringify(vOpts));
  ex('(function(){ var sel=document.querySelector("#lpDeviceVideo"); sel.value="0"; sel.dispatchEvent(new Event("change")); })()');
  await wait(200);
  const camSrc = ex('SE.activeScene().sources.filter(function(s){return s.type==="av_capture_input";})[0]');
  check('D1 选择视频设备 → 场景自动出现 av_capture_input', !!camSrc, JSON.stringify(ex('SE.activeScene().sources.map(function(s){return s.type;})')));
  // Windows dshow：设备名拼接 video=/audio=
  const devVal = camSrc && camSrc.settings && camSrc.settings.device;
  check('D2 device 含 dshow 视频名', !!devVal && String(devVal).indexOf('video=') >= 0, String(devVal));
  // 二次 change 不重复添加（只保留一个摄像头来源）
  ex('(function(){ var sel=document.querySelector("#lpDeviceVideo"); sel.value="1"; sel.dispatchEvent(new Event("change")); })()');
  await wait(200);
  const camCount = ex('SE.activeScene().sources.filter(function(s){return s.type==="av_capture_input";}).length');
  check('D3 设备切换更新而不重复添加（仍 1 个）', camCount === 1, String(camCount));

  // ===== ⑤ 侧边栏彩色图标 =====
  const niOverview = ex('(function(){ var b=document.querySelector(\'.nav-item[data-view=overview]\'); return b ? b.style.getPropertyValue("--ni") : ""; })()');
  check('E1 概览菜单注入彩色 --ni', niOverview === '#34d399', niOverview);
  const niMonitor = ex('(function(){ var b=document.querySelector(\'.nav-item[data-view=monitor]\'); return b ? b.style.getPropertyValue("--ni") : ""; })()');
  check('E2 在线流菜单注入彩色 --ni', niMonitor === '#f87171', niMonitor);
  const cssHasNi = html.indexOf('color: var(--ni, currentColor)') >= 0;
  check('E3 CSS 定义 --ni 变量取色', !!cssHasNi);
  const activeWhite = html.indexOf('.nav-item.active svg { color: #fff; }') >= 0;
  check('E4 激活态白色高亮 CSS 保留', !!activeWhite);
  const nCount = ex('document.querySelectorAll(".nav-item[data-view]").length');
  const nColored = ex('Array.prototype.filter.call(document.querySelectorAll(".nav-item[data-view]"), function(b){ return b.style.getPropertyValue("--ni"); }).length');
  check('E5 全部 ' + nCount + ' 个数据菜单均注入颜色', String(nCount) !== '0' && nColored === nCount, nColored + '/' + nCount);

  clearTimeout(watchdog);
  const pass = results.filter(r => r.ok).length;
  console.log('\n======== v1.1.44 素材融合/自动入场景/彩色图标 端到端汇总 ========');
  console.log('通过 ' + pass + ' / ' + results.length);
  process.exit(pass === results.length ? 0 : 1);
}

dom.window.addEventListener('load', () => { run(); });
setTimeout(run, 2500);
