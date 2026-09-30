// jsdom 端到端（v1.1.36）：真加载 renderer/index.html + 内联 scene-engine.js，验证 OBS 1:1 场景/来源能力
//   ① 加载无 jsdomError（SceneEngine 已定义）；工作室模式排版/核心元素存在
//   ② 来源 dock：添加来源下拉（覆盖全部 7 类 OBS 来源）；添加图片源后直接弹属性 + 文件浏览 = 场景内文件管理
//   ③ 来源属性强类型 + 文件浏览（mock tcapi.ffPickFile 回填路径）；变换（Transform）对话框写入 transform
//   ④ SceneEngine.toLegacyProgram() 把 OBS 形态映射回现有 ffmpeg 推流管线（image/text 走 legacy，其余带 kind 标记透传）
//   ⑤ PVM/PGM/实时监看 三处叠加层芯片随 OBS 来源渲染（验证 lpChipsFor 已适配新形态）
//   ⑥ 回归 v1.1.35：竖屏预览 transpose=1 + scale=1080:1920 + hflip + rotate(90deg) scale cover
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { composeVideoFilter } = require('../../ffmpeg-args');

const ROOT = require('path').resolve(__dirname, '..', '..');
let html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const seSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'scene-engine.js'), 'utf8');
// 把外部 <script src="scene-engine.js"> 内联，确保 jsdom 必然加载（避免相对资源拉取失败）
html = html.replace('<script src="scene-engine.js"></script>', '<script>\n' + seSrc + '\n</script>');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + (detail || '')));
}

// 语义化版本比较：a >= b 返回 >=0
function cmpVer(a, b) {
  var pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
    var d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

let pickPath = '/tmp/watermark.png';
const tcHandlers = {
  appVersion: '1.1.36',
  ff: () => Promise.resolve({ ok: true, id: 'ff_test_1' }),
  ffStop: () => Promise.resolve({ ok: true }),
  ffPickFile: () => Promise.resolve({ ok: true, path: pickPath }),
  ffProbe: () => Promise.resolve({ ok: true, width: 1080, height: 1920, codec: 'h264', audio: 'aac' }),
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
  runScripts: 'dangerously',
  url: 'https://localhost/',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.tcapi = new Proxy({}, { get(t, p) { return (p in tcHandlers) ? tcHandlers[p] : (() => Promise.resolve({ ok: true, data: {} })); } });
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  }
});

const { window } = dom;
const doc = window.document;
const ex = (js) => window.eval(js);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// composeVideoFilter 含图片来源时返回 {complex}，纯文字/无来源时返回 {vf}；统一取滤镜串
const vfOf = (f) => (f && (f.vf || f.complex)) || '';

const watchdog = setTimeout(() => {
  console.log('\n[WATCHDOG] 超时强制退出');
  const pass = results.filter((r) => r.ok).length;
  console.log('已通过 ' + pass + ' / ' + results.length);
  process.exit(3);
}, 30000);

let ran = false;
window.addEventListener('load', run);
setTimeout(() => { if (!ran) run(); }, 600);

async function run() {
  if (ran) return; ran = true;
  try {
    await wait(400);
    check('E0 加载过程无 jsdomError', !jsdomErr, jsdomErr && jsdomErr.message);
    check('E1 SceneEngine 已定义（场景引擎已加载）', ex('typeof SceneEngine !== "undefined" && !!SceneEngine.createEngine'));
    check('E2 SE 实例已挂（var SE = SceneEngine.createEngine）', ex('typeof SE !== "undefined" && !!SE.listSourceTypes'));

    // ===== ① 工作室模式排版 + 核心元素 =====
    check('P1 工作室卡片 lpStudioCard 存在', !!doc.getElementById('lpStudioCard'));
    check('P2 PVM 内嵌本地输入预览 lpPreview', !!doc.querySelector('#lpStudioCard #lpPreview'));
    check('P3 预览叠加层 lpPrevOverlay 存在', !!doc.getElementById('lpPrevOverlay'));
    ['lpStudioMode', 'lpStudio', 'lpTransCol', 'lpProgPane', 'lpTransBtn', 'lpProgPreviewBtn', 'lpTransType']
      .forEach((id) => check('S1 工作室模式元素 ' + id, !!doc.getElementById(id)));
    check('S2 默认开启工作室模式（lpStudioMode.checked）', doc.getElementById('lpStudioMode').checked === true);
    ['lpSceneSel','lpSceneAdd','lpSceneRename','lpSceneDup','lpSceneDel','lpSceneExport','lpSceneImport']
      .forEach((id) => check('M1 场景工具条在 studio 卡内 ' + id, !!doc.querySelector('#lpStudioCard #' + id)));
    ['lpOrientLand','lpOrientPort','lpRotate','lpStageSize']
      .forEach((id) => check('M2 横竖屏控制在 studio 卡内 ' + id, !!doc.querySelector('#lpStudioCard #' + id)));

    // ===== ② 来源 dock：添加来源下拉（7 类 OBS 来源） =====
    check('D1 添加来源按钮 lpSrcAddMenu 存在', !!doc.getElementById('lpSrcAddMenu'));
    check('D2 下拉容器 lpSrcAddDropdown 存在', !!doc.getElementById('lpSrcAddDropdown'));
    check('D3 来源列表容器 lpSources 存在', !!doc.getElementById('lpSources'));
    const srcCnt0 = ex('lpActiveScene().sources.length');
    doc.getElementById('lpSrcAddMenu').click();
    await wait(20);
    const ddItems = doc.querySelectorAll('#lpSrcAddDropdown .lp-dropdown-item');
    check('D4 下拉列出全部 7 类 OBS 来源', ddItems.length === 7, 'items=' + ddItems.length);
    const ids = Array.prototype.map.call(ddItems, (el) => el.getAttribute('data-tid'));
    check('D5 含 image_source / ffmpeg_source / text_ft2_source',
      ids.indexOf('image_source') >= 0 && ids.indexOf('ffmpeg_source') >= 0 && ids.indexOf('text_ft2_source') >= 0,
      ids.join(','));

    // 点击 image_source → 添加 + 自动弹「来源属性」（含文件浏览）
    const imgItem = doc.querySelector('#lpSrcAddDropdown .lp-dropdown-item[data-tid="image_source"]');
    imgItem.click();
    await wait(40);
    check('D6 添加图片源 +1', ex('lpActiveScene().sources.length') === srcCnt0 + 1);
    check('D7 新增来源为 OBS image_source 形态', ex('lpActiveScene().sources[' + srcCnt0 + '].type') === 'image_source');
    check('D8 含 path 属性的来源添加后自动弹「来源属性」对话框', doc.getElementById('lpSrcPropsModal').style.display === 'flex');
    check('D9 属性对话框含文件浏览按钮 data-prop=file', !!doc.querySelector('#lpSrcPropsModal [data-prop="file"]'));
    check('D10 属性对话框含路径输入框 .lpPropPath[data-pk=file]', !!doc.querySelector('#lpSrcPropsModal .lpPropPath[data-pk="file"]'));

    // ===== ③ 来源属性文件浏览（场景内文件管理核心） =====
    const browseBtn = doc.querySelector('#lpSrcPropsModal [data-prop="file"]');
    browseBtn.click();
    await wait(60);
    check('F1 文件浏览回填 settings.file = pickPath', ex('lpActiveScene().sources[' + srcCnt0 + '].settings.file') === pickPath,
      ex('lpActiveScene().sources[' + srcCnt0 + '].settings.file'));
    const pathInput = doc.querySelector('#lpSrcPropsModal .lpPropPath[data-pk="file"]');
    check('F2 路径输入框同步显示 pickPath', pathInput && pathInput.value === pickPath, pathInput && pathInput.value);

    // ===== ④ 变换（Transform）对话框 =====
    doc.getElementById('lpSrcPropsClose').click();
    await wait(10);
    check('T0 关闭属性对话框', doc.getElementById('lpSrcPropsModal').style.display === 'none');
    ex('lpOpenTransform(' + srcCnt0 + ')');
    await wait(20);
    check('T1 变换对话框打开', doc.getElementById('lpTransformModal').style.display === 'flex');
    const sx = doc.getElementById('lpTfSx');
    sx.value = '200'; sx.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(20);
    check('T2 缩放 X=200% → transform.scale.x=2', Math.abs(ex('lpActiveScene().sources[' + srcCnt0 + '].transform.scale.x') - 2) < 1e-6,
      ex('lpActiveScene().sources[' + srcCnt0 + '].transform.scale.x'));
    const rot = doc.getElementById('lpTfRot');
    rot.value = '45'; rot.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(20);
    check('T3 旋转 45° → transform.rotation=45', ex('lpActiveScene().sources[' + srcCnt0 + '].transform.rotation') === 45);
    doc.getElementById('lpTransformClose').click();
    await wait(10);

    // 再添加一个文本来源（验证 text_ft2_source 也走属性+文件浏览分支）
    const srcCnt1 = ex('lpActiveScene().sources.length');
    doc.getElementById('lpSrcAddMenu').click();
    await wait(20);
    doc.querySelector('#lpSrcAddDropdown .lp-dropdown-item[data-tid="text_ft2_source"]').click();
    await wait(40);
    check('G1 添加文本源 +1 且为 text_ft2_source', ex('lpActiveScene().sources.length') === srcCnt1 + 1 && ex('lpActiveScene().sources[' + srcCnt1 + '].type') === 'text_ft2_source');
    doc.getElementById('lpSrcPropsClose').click();
    await wait(10);

    // ===== ⑤ PVM/PGM/实时监看 三处芯片随 OBS 来源渲染（lpChipsFor 适配验证） =====
    check('C1 PVM 叠加层渲染 2 个芯片', doc.querySelectorAll('#lpPrevOverlay .lp-stage-chip').length === 2,
      'prevChips=' + doc.querySelectorAll('#lpPrevOverlay .lp-stage-chip').length);
    check('C2 PGM 叠加层渲染 2 个芯片', doc.querySelectorAll('#lpProgOverlay .lp-stage-chip').length === 2,
      'progChips=' + doc.querySelectorAll('#lpProgOverlay .lp-stage-chip').length);
    check('C3 实时监看叠加层渲染 2 个芯片', doc.querySelectorAll('#lpLiveOverlay .lp-stage-chip').length === 2,
      'liveChips=' + doc.querySelectorAll('#lpLiveOverlay .lp-stage-chip').length);

    // ===== ④ SceneEngine.toLegacyProgram 映射回 ffmpeg 管线 =====
    const payload = ex('lpLanePayload(0)');
    check('L1 payload.sources 经 SE.toLegacyProgram 生成', Array.isArray(payload.sources) && payload.sources.length === 2);
    const imgLegacy = ex('lpLanePayload(0).sources[' + srcCnt0 + ']');
    check('L2 image_source → legacy {type:"image", path}', imgLegacy.type === 'image' && imgLegacy.path === pickPath, JSON.stringify(imgLegacy));
    const txtLegacy = ex('lpLanePayload(0).sources[' + srcCnt1 + ']');
    check('L3 text_ft2_source → legacy {type:"text", text}', txtLegacy.type === 'text' && typeof txtLegacy.text === 'string', JSON.stringify(txtLegacy));

    // 用真实 composeVideoFilter 验证 image/text 真进入滤镜（不崩溃）
    const f = composeVideoFilter(payload, []);
    check('L4 composeVideoFilter 含图片叠加（overlay/drawtext）', /overlay|drawtext/.test(vfOf(f)), vfOf(f));

    // ===== ⑥ 回归 v1.1.35：竖屏预览 transpose + 横竖屏跟随 =====
    var sm = doc.getElementById('lpStudioMode');
    if (sm.checked) { sm.checked = false; sm.dispatchEvent(new window.Event('change', { bubbles: true })); await wait(20); }
    ex('lpApplyOrient("port")');
    ex('lpLastProbe = { w: 1920, h: 1080 }');
    await wait(20);
    check('P-P1 竖屏时 PVM 预览窗 aspect-ratio=9/16', doc.getElementById('lpPrevPane').style.aspectRatio === '9 / 16',
      doc.getElementById('lpPrevPane').style.aspectRatio);
    check('P-P2 payload 携带 inW/inH（横向源）', (function () { var p = ex('lpLanePayload(0)'); return p.inW === 1920 && p.inH === 1080; })());
    var pPort = ex('lpLanePayload(0)');
    var fPort = composeVideoFilter(pPort, []);
    check('P-P3 竖屏+横向源 → 滤镜含 transpose=1', /transpose=1/.test(vfOf(fPort)), vfOf(fPort));
    check('P-P4 竖屏+横向源 → 滤镜含 scale=1080:1920', /scale=1080:1920/.test(vfOf(fPort)), vfOf(fPort));
    doc.getElementById('lpFlip').value = 'hflip'; ex('lpSyncPreviewTransform()'); await wait(10);
    var fFlip = composeVideoFilter(ex('lpLanePayload(0)'), []);
    check('P-P5 水平镜像 hflip 进入滤镜', /hflip/.test(vfOf(fFlip)), vfOf(fFlip));
    doc.getElementById('lpFlip').value = '';
    ex('lpLastProbe = { w: 1080, h: 1920 }'); await wait(10);
    var fPortSrc = composeVideoFilter(ex('lpLanePayload(0)'), []);
    check('P-P7 竖屏源不再二次转置（无 transpose）', !/transpose/.test(vfOf(fPortSrc)), vfOf(fPortSrc));
    ex('lpApplyOrient("port")'); await wait(10);
    ex('lpLastProbe = { w: 1920, h: 1080 }'); await wait(10);
    doc.getElementById('lpRotate').value = '90'; doc.getElementById('lpRotate').dispatchEvent(new window.Event('change', { bubbles: true })); await wait(10);
    ex('lpSyncPreviewTransform()'); await wait(10);
    var pvEl = doc.getElementById('lpPreview');
    check('P-P9 竖屏预览 transform 含 rotate(90deg) scale（填满 9:16）', /rotate\(90deg\)\s*scale\(1\.77778/.test(pvEl.style.transform || ''), pvEl.style.transform);
    check('P-P10 竖屏预览 object-fit=cover（填满画布不再黑屏）', (pvEl.style.objectFit || '') === 'cover', pvEl.style.objectFit);
    doc.getElementById('lpFlip').value = ''; await wait(5);
    doc.getElementById('lpRotate').value = '0'; doc.getElementById('lpRotate').dispatchEvent(new window.Event('change', { bubbles: true })); await wait(5);
    ex('lpApplyOrient("land")');

    // 版本一致性
    check('V1 侧栏版本芯片存在', !!doc.getElementById('sideVerText'));
    // 版本断言随迭代推进（r77 已升到 1.1.37）：只校验 package.json 版本 >= 1.1.36 且格式合法
    var pkgVer = (fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').match(/"version":\s*"([\d.]+)"/) || [])[1];
    check('V2 package.json 版本 >= 1.1.36（当前 ' + pkgVer + '）', pkgVer != null && cmpVer(pkgVer, '1.1.36') >= 0);
  } catch (e) {
    check('Ex 测试执行异常', false, (e && e.stack) || String(e));
  }

  clearTimeout(watchdog);
  const pass = results.filter((r) => r.ok).length;
  console.log('\n======== v1.1.36 端到端汇总 ========');
  console.log('通过 ' + pass + ' / ' + results.length);
  if (pass !== results.length) {
    results.filter((r) => !r.ok).forEach((r) => console.log('  FAIL ' + r.name + '  -> ' + r.detail));
  }
  process.exit(pass === results.length ? 0 : 1);
}
