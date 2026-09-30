// jsdom 端到端：真加载 renderer/index.html，mock 云桥，验证 v1.1.32 能力
//   ① OBS 工作室模式排版（左 PVM 采集/素材预览 · 右 PGM 输出，本地输入预览集合于 PVM；场景工具条/横竖屏/来源 dock 融合进工作室卡片，默认开启；推流质量图表独立成卡置于本地推流菜单下方）
//   ② OBS 工作室模式（预览/转场/输出 三栏，转场切换 Program 场景）
//   ③ 推流实时输出监看卡片（推流按钮下方，跟随场景方向）
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { composeVideoFilter } = require('../../ffmpeg-args');

const ROOT = require('path').resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + (detail || '')));
}

const tcHandlers = {
  appVersion: '1.1.29',
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
let pickPath = '/tmp/watermark.png';

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

const watchdog = setTimeout(() => {
  console.log('\n[WATCHDOG] 超时强制退出');
  const pass = results.filter((r) => r.ok).length;
  console.log('已通过 ' + pass + ' / ' + results.length);
  process.exit(3);
}, 25000);

let ran = false;
window.addEventListener('load', run);
setTimeout(() => { if (!ran) run(); }, 600);

async function run() {
  if (ran) return; ran = true;
  try {
    await wait(400);
    check('E0 加载过程无 jsdomError', !jsdomErr, jsdomErr && jsdomErr.message);

    // ===== ① 工作室模式排版（v1.1.32：PVM 集合本地输入预览；图表移至推流菜单下方） =====
    check('P1 工作室卡片 lpStudioCard 存在', !!doc.getElementById('lpStudioCard'));
    check('P2 PVM 内嵌本地输入预览 lpPreview', !!doc.querySelector('#lpStudioCard #lpPreview'));
    check('P3 预览叠加层 lpPrevOverlay 存在', !!doc.getElementById('lpPrevOverlay'));
    check('P4 推流质量图表独立成卡（lpQCard 含 lpQChart / lpLaneStats）',
      !!doc.querySelector('#lpQCard #lpQChart') && !!doc.querySelector('#lpQCard #lpLaneStats'));
    check('P5 工作室卡片不再包含图表（已移出）', !doc.querySelector('#lpStudioCard #lpQChart'));
    check('P6 排版顺序：工作室卡片置顶、图表卡在推流菜单之后', (function () {
      var cards = Array.prototype.slice.call(doc.querySelectorAll('#view-localpush > .card'));
      var si = cards.findIndex(function (c) { return c.id === 'lpStudioCard'; });
      var qi = cards.findIndex(function (c) { return c.id === 'lpQCard'; });
      var pi = cards.findIndex(function (c) { return !!(c.querySelector && c.querySelector('#lpStartBtn')); });
      return si === 0 && qi > pi && qi > si;
    })());

    // ===== ② OBS 工作室模式 =====
    ['lpStudioMode', 'lpStudio', 'lpTransCol', 'lpProgPane', 'lpTransBtn', 'lpProgPreviewBtn', 'lpTransType']
      .forEach((id) => check('S1 工作室模式元素 ' + id, !!doc.getElementById(id)));
    check('S2 默认开启工作室模式（lpStudioMode.checked）', doc.getElementById('lpStudioMode').checked === true);
    check('S3 默认 lpStudio 含 .studio 且转场/输出栏可见', doc.getElementById('lpStudio').classList.contains('studio') && doc.getElementById('lpTransCol').style.display !== 'none' && doc.getElementById('lpProgPane').style.display !== 'none');

    // 场景工具条 / 横竖屏 / 来源 dock 已融合进工作室卡片（v1.1.33）
    ['lpSceneSel','lpSceneAdd','lpSceneRename','lpSceneDup','lpSceneDel','lpSceneExport','lpSceneImport']
      .forEach((id) => check('M1 场景工具条在 studio 卡内 ' + id, !!doc.querySelector('#lpStudioCard #' + id)));
    ['lpOrientLand','lpOrientPort','lpRotate','lpStageSize']
      .forEach((id) => check('M2 横竖屏控制在 studio 卡内 ' + id, !!doc.querySelector('#lpStudioCard #' + id)));
    ['lpSources','lpSrcAddText','lpSrcAddImg']
      .forEach((id) => check('M3 来源 dock 在 studio 卡内 ' + id, !!doc.querySelector('#lpStudioCard #' + id)));

    // 添加来源，验证三处叠加层都渲染芯片
    const srcCnt0 = ex('lpActiveScene().sources.length');
    doc.getElementById('lpSrcAddText').click();
    await wait(30);
    check('S4 ＋文字来源 +1', ex('lpActiveScene().sources.length') === srcCnt0 + 1);
    check('S5 预览叠加层渲染芯片', doc.querySelectorAll('#lpPrevOverlay .lp-stage-chip').length === 1,
      'prevChips=' + doc.querySelectorAll('#lpPrevOverlay .lp-stage-chip').length);
    check('S6 输出叠加层渲染芯片（工作室模式未开，跟随活动场景）', doc.querySelectorAll('#lpProgOverlay .lp-stage-chip').length === 1,
      'progChips=' + doc.querySelectorAll('#lpProgOverlay .lp-stage-chip').length);
    check('S7 实时监看叠加层渲染芯片', doc.querySelectorAll('#lpLiveOverlay .lp-stage-chip').length === 1,
      'liveChips=' + doc.querySelectorAll('#lpLiveOverlay .lp-stage-chip').length);

    // 竖屏场景：PVM 预览窗跟随变 9/16（v1.1.33 横竖屏支持）
    doc.getElementById('lpOrientPort').click();
    await wait(30);
    const pvChk = doc.getElementById('lpPrevPane');
    check('M4 竖屏时 PVM 加 .port 类', pvChk.classList.contains('port'));
    check('M5 竖屏时 PVM aspect-ratio=9/16', pvChk.style.aspectRatio === '9 / 16', pvChk.style.aspectRatio);
    doc.getElementById('lpOrientLand').click();
    await wait(20);

    // 开启工作室模式
    const sm = doc.getElementById('lpStudioMode');
    sm.checked = true; sm.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(40);
    check('S8 开启后 lpStudio 加 .studio', doc.getElementById('lpStudio').classList.contains('studio'));
    check('S9 开启后转场栏显示', doc.getElementById('lpTransCol').style.display !== 'none');
    check('S10 开启后输出栏显示', doc.getElementById('lpProgPane').style.display !== 'none');
    check('S11 开启后 Program 场景与活动场景同步', ex('lpProgramSceneId') === ex('lpActiveSceneId'));

    // 转场类型切换不抛错
    const tt = doc.getElementById('lpTransType');
    ['fade', 'slide', 'cut'].forEach((v) => {
      tt.value = v; tt.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await wait(20);
    check('S12 转场类型切换无异常', true);

    // 点「转场到输出」→ lpProgramSceneId 保持与活动场景一致（单场景时），且不抛错
    doc.getElementById('lpTransBtn').click();
    await wait(60);
    check('S13 转场后 lpProgramSceneId === lpActiveSceneId', ex('lpProgramSceneId') === ex('lpActiveSceneId'));
    check('S14 转场后输出叠加层仍渲染芯片', doc.querySelectorAll('#lpProgOverlay .lp-stage-chip').length === 1);

    // 新增一个场景并切到它，验证工作室模式关闭时 Program 恒等于活动场景
    const sceneCnt0 = ex('state.cfg.lpScenes.length');
    doc.getElementById('lpSceneAdd').click();
    await wait(50);
    const inp = doc.getElementById('uiPromptInput');
    if (inp) { inp.value = '第二场景'; doc.getElementById('uiPromptOk').click(); }
    await wait(50);
    check('S15 新建并激活第二场景', ex('state.cfg.lpScenes.length') === sceneCnt0 + 1);
    // 关闭工作室模式
    sm.checked = false; sm.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(30);
    check('S16 关闭后 lpStudio 无 .studio', !doc.getElementById('lpStudio').classList.contains('studio'));
    check('S17 关闭工作室模式后 lpProgramScene() 恒等于活动场景', ex('lpProgramScene() === lpActiveScene()'));
    // 推流域名 payload 在非工作室模式仍用活动场景（兼容 v1.1.30）：sources 恒等于活动场景的 sources
    check('S18 非工作室模式 payload.sources 来自活动场景', ex('lpLanePayload(0).sources === lpActiveScene().sources'));

    // ===== ③ 推流实时输出监看卡片 =====
    ['lpLiveVideo', 'lpLivePrevBtn', 'lpLiveStopBtn', 'lpLiveOrient', 'lpLiveOverlay', 'lpLivePane']
      .forEach((id) => check('L1 实时监看元素 ' + id, !!doc.getElementById(id)));
    // 无推流时点击「开始实时预览」应安全退出（toast），不抛错
    doc.getElementById('lpLivePrevBtn').click();
    await wait(60);
    check('L2 无推流点击实时预览不崩溃', true);
    check('L3 无推流时未进入中继（lpLiveRelaying=false）', ex('lpLiveRelaying') === false);
    // 勾选方向跟随并切竖屏，验证监看卡片 aspect-ratio 跟随
    doc.getElementById('lpLiveOrient').checked = true;
    doc.getElementById('lpOrientPort').click();
    await wait(30);
    check('L4 监看卡片方向跟随场景（竖屏 9/16）', doc.getElementById('lpLivePane').style.aspectRatio === '9 / 16',
      doc.getElementById('lpLivePane').style.aspectRatio);
    doc.getElementById('lpOrientLand').click();
    await wait(20);

    check('B1 版本芯片存在', !!doc.getElementById('sideVerText'));

    // ===== ④ v1.1.34：竖屏画布把横向采集信号转置成竖屏，且翻转/镜像真正进入滤镜 =====
    // 关闭工作室模式，确保 Program 跟随活动场景，便于断言 payload
    var sm2 = doc.getElementById('lpStudioMode');
    if (sm2.checked) { sm2.checked = false; sm2.dispatchEvent(new window.Event('change', { bubbles: true })); await wait(20); }
    ex('lpApplyOrient("port")');                 // 活动场景切竖屏
    ex('lpLastProbe = { w: 1920, h: 1080 }');    // 模拟横向采集源（摄像头/横版素材）
    await wait(20);
    // PVM 预览窗跟随竖屏 9/16
    check('P-P1 竖屏时 PVM 预览窗 aspect-ratio=9/16', doc.getElementById('lpPrevPane').style.aspectRatio === '9 / 16',
      doc.getElementById('lpPrevPane').style.aspectRatio);
    // payload 携带源尺寸，供主进程判断是否需转置
    check('P-P2 payload 携带 inW/inH（横向源）', (function () { var p = ex('lpLanePayload(0)'); return p.inW === 1920 && p.inH === 1080; })());
    // 用真实 composeVideoFilter 构造滤镜，验证竖屏转置生效
    var pPort = ex('lpLanePayload(0)');
    var fPort = composeVideoFilter(pPort, []);
    check('P-P3 竖屏+横向源 → 滤镜含 transpose=1（采集转竖屏）', /transpose=1/.test(fPort.vf || ''), fPort.vf);
    check('P-P4 竖屏+横向源 → 滤镜含 scale=1080:1920（9:16 画布）', /scale=1080:1920/.test(fPort.vf || ''), fPort.vf);
    // 翻转 / 镜像 真正进入滤镜
    doc.getElementById('lpFlip').value = 'hflip'; ex('lpSyncPreviewTransform()'); await wait(10);
    var fFlip = composeVideoFilter(ex('lpLanePayload(0)'), []);
    check('P-P5 水平镜像 hflip 进入滤镜', /hflip/.test(fFlip.vf || ''), fFlip.vf);
    doc.getElementById('lpFlip').value = 'hflip,vflip'; await wait(10);
    var fBoth = composeVideoFilter(ex('lpLanePayload(0)'), []);
    check('P-P6 镜像+翻转 hflip,vflip 同时进入滤镜', /hflip/.test(fBoth.vf || '') && /vflip/.test(fBoth.vf || ''), fBoth.vf);
    // 已为竖屏的源（手机竖拍）不再二次转置
    ex('lpLastProbe = { w: 1080, h: 1920 }'); await wait(10);
    var fPortSrc = composeVideoFilter(ex('lpLanePayload(0)'), []);
    check('P-P7 竖屏源不再二次转置（无 transpose）', !/transpose/.test(fPortSrc.vf || ''), fPortSrc.vf);
    // 旋转 90° 也进入滤镜
    doc.getElementById('lpRotate').value = '90'; doc.getElementById('lpRotate').dispatchEvent(new window.Event('change', { bubbles: true })); await wait(10);
    var fRot = composeVideoFilter(ex('lpLanePayload(0)'), []);
    check('P-P8 旋转 90° 进入滤镜（rotate=PI/2）', /rotate=PI\/2/.test(fRot.vf || ''), fRot.vf);
    // v1.1.35：PVM 预览在竖屏场景应「旋转并等比缩放填满 9:16」（不再裸 rotate 被 overflow 裁成黑条），object-fit=cover
    ex('lpApplyOrient("port")'); await wait(10);
    ex('lpLastProbe = { w: 1920, h: 1080 }'); await wait(10);
    doc.getElementById('lpFlip').value = ''; await wait(5);
    doc.getElementById('lpRotate').value = '0'; doc.getElementById('lpRotate').dispatchEvent(new window.Event('change', { bubbles: true })); await wait(5);
    ex('lpSyncPreviewTransform()'); await wait(10);
    var pvEl = doc.getElementById('lpPreview');
    check('P-P9 竖屏预览 transform 含 rotate(90deg) scale(1.77778 填满 9:16)', /rotate\(90deg\)\s*scale\(1\.77778/.test(pvEl.style.transform || ''), pvEl.style.transform);
    check('P-P10 竖屏预览 object-fit=cover（填满画布不再黑屏）', (pvEl.style.objectFit || '') === 'cover', pvEl.style.objectFit);
    // 还原横屏，避免影响其它用例
    ex('lpApplyOrient("land")');
  } catch (e) {
    check('Ex 测试执行异常', false, (e && e.stack) || String(e));
  }

  clearTimeout(watchdog);
  const pass = results.filter((r) => r.ok).length;
  console.log('\n======== v1.1.35 端到端汇总 ========');
  console.log('通过 ' + pass + ' / ' + results.length);
  if (pass !== results.length) {
    results.filter((r) => !r.ok).forEach((r) => console.log('  FAIL ' + r.name + '  -> ' + r.detail));
  }
  process.exit(pass === results.length ? 0 : 1);
}
