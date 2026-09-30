// jsdom 端到端：真加载 renderer/index.html，mock 云桥，验证 v1.1.30 能力
//   ① prompt() 崩溃修复（uiPrompt 模态输入框，全文件无原生 prompt 调用）
//   ② OBS 高级模式排版（画布预览 + 来源停靠 + 场景工具条：复制/导出/导入）
//   ③ 横竖屏全链路（画布预览 aspect-ratio / 来源位置预设 / 输入文件自动探测联动）
//   ④ OBS 增量功能（来源可见性/排序/复制/Transform 自定义坐标）
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

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
  ffListEncoders: () => Promise.resolve({ ok: true, list: [
    { id: 'libx264', fam: 'h264', label: 'H.264', hw: false },
    { id: 'libx265', fam: 'hevc', label: 'H.265', hw: false },
  ] }),
  call: () => Promise.resolve({ ok: true, data: {} }),
  acall: () => Promise.resolve({ ok: true, data: {} }),
};
let pickPath = '/tmp/watermark.png';   // 文件选择 mock 可变路径：图片来源用图片、素材添加用视频

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
const fire = (id, type) => { const el = doc.getElementById(id); if (el) el.dispatchEvent(new window.Event(type, { bubbles: true })); };

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
    console.log('--- run() 开始 ---');
    await wait(400);
    check('E0 加载过程无 jsdomError', !jsdomErr, jsdomErr && jsdomErr.message);

    // ===== ① prompt() 崩溃修复 =====
    check('U1 uiPrompt 是全局函数', ex('typeof uiPrompt') === 'function', ex('typeof uiPrompt'));
    check('U2 全文件不再有原生 prompt( 调用', !/prompt\('/.test(html), (/prompt\('/.exec(html) || [''])[0]);

    // 场景添加走 uiPrompt 模态（用户实际崩溃路径）
    const sceneCnt0 = ex('state.cfg.lpScenes.length');
    doc.getElementById('lpSceneAdd').click();
    await wait(60);
    const mask = doc.getElementById('uiPromptMask');
    check('U3 点「＋场景」弹出 uiPrompt 模态（不再抛 prompt 崩溃）', !!mask && mask.style.display === 'flex', mask && mask.style.display);
    const inp = doc.getElementById('uiPromptInput');
    check('U4 模态带默认名', !!inp && /场景\d+/.test(inp.value), inp && inp.value);
    inp.value = '测试场景';
    doc.getElementById('uiPromptOk').click();
    await wait(60);
    check('U5 确认后场景 +1 且已激活', ex('state.cfg.lpScenes.length') === sceneCnt0 + 1 && ex('lpActiveScene().name') === '测试场景',
      ex('lpActiveScene().name'));
    check('U6 确认后模态关闭', !mask || mask.style.display === 'none', mask && mask.style.display);

    // v1.1.33 默认开启工作室模式：Program 初始为默认场景，新建并激活「测试场景」后需「转场到输出」让 Program 跟随（OBS 同款；否则推流输出仍用旧 Program 场景）
    doc.getElementById('lpTransBtn').click();
    await wait(40);
    check('O0 转场后 Program 跟随当前活动场景', ex('lpProgramSceneId') === ex('lpActiveSceneId'));

    // ===== ② OBS 高级模式排版 =====
    ['lpPrevPane', 'lpPrevOverlay', 'lpSrcAddText', 'lpSrcAddImg', 'lpSceneDup', 'lpSceneExport', 'lpSceneImport', 'lpSceneImportFile', 'lpStageSize']
      .forEach((id) => check('O1 高级模式元素 ' + id, !!doc.getElementById(id)));
    check('O2 画布默认横屏 aspect-ratio 16/9', ex('lpActiveScene().orient') === 'land' && doc.getElementById('lpPrevPane').style.aspectRatio === '16 / 9',
      doc.getElementById('lpPrevPane').style.aspectRatio);

    // ===== ③ 横竖屏全链路 =====
    doc.getElementById('lpOrientPort').click();
    await wait(30);
    check('O3 切竖屏后画布容器带 .port 且 9/16', doc.getElementById('lpPrevPane').classList.contains('port') && doc.getElementById('lpPrevPane').style.aspectRatio === '9 / 16',
      doc.getElementById('lpPrevPane').style.aspectRatio);
    check('O4 竖屏画布标注 1080×1920', /1080×1920/.test(doc.getElementById('lpStageSize').textContent), doc.getElementById('lpStageSize').textContent);
    check('O5 场景 payload outSize 竖屏', ex('JSON.stringify(lpLanePayload(0))').indexOf('1080x1920') > 0);
    doc.getElementById('lpOrientLand').click();
    await wait(30);
    check('O6 切回横屏', doc.getElementById('lpPrevPane').style.aspectRatio === '16 / 9');

    // ===== ④ 来源：添加 / 画布叠加 / 选中联动 / 可见性 / 排序 / 复制 / Transform =====
    const srcCnt0 = ex('lpActiveScene().sources.length');
    doc.getElementById('lpSrcAddText').click();
    await wait(30);
    check('R1 ＋文字 来源 +1', ex('lpActiveScene().sources.length') === srcCnt0 + 1);
    doc.getElementById('lpSrcAddImg').click();
    await wait(30);
    check('R2 ＋图片 来源 +1 且类型 image', ex('lpActiveScene().sources.length') === srcCnt0 + 2 &&
      ex('lpActiveScene().sources[' + (srcCnt0 + 1) + '].type') === 'image');
    await wait(80);   // 图片来源自动弹文件选择（mock 直接 resolve）
    check('R3 图片来源自动回填所选路径', ex('lpActiveScene().sources[' + (srcCnt0 + 1) + '].path') === '/tmp/watermark.png',
      ex('lpActiveScene().sources[' + (srcCnt0 + 1) + '].path'));

    const chips = doc.querySelectorAll('#lpPrevOverlay .lp-stage-chip');
    check('R4 画布叠加渲染 2 个启用来源芯片', chips.length === 2, 'chips=' + chips.length);

    // 点画布芯片 → 停靠列表选中联动
    chips[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    check('R5 点画布芯片 → lpSelSrc 联动选中', ex('lpSelSrc') === 0, String(ex('lpSelSrc')));
    check('R6 停靠列表出现 .sel 行', !!doc.querySelector('#lpSources .lp-src-row.sel'));

    // 可见性：关掉第一个来源 → 画布芯片减 1
    ex('lpActiveScene().sources[0].enabled=false; lpRenderSources()');
    await wait(20);
    check('R7 关闭可见性后画布芯片 -1', doc.querySelectorAll('#lpPrevOverlay .lp-stage-chip').length === 1);
    ex('lpActiveScene().sources[0].enabled=true; lpRenderSources()');

    // 排序：下移 → 顺序交换（图层）
    const order0 = ex('lpActiveScene().sources.map(function(s){return s.type}).join(",")');
    const downBtn = doc.querySelector('#lpSources .lp-src-row[data-si="0"] button[data-act="down"]');
    if (downBtn) downBtn.click();
    await wait(30);
    const order1 = ex('lpActiveScene().sources.map(function(s){return s.type}).join(",")');
    check('R8 来源下移交换图层顺序', order0 === 'text,image' && order1 === 'image,text', order0 + ' -> ' + order1);

    // 复制来源
    const dupBtn = doc.querySelector('#lpSources .lp-src-row[data-si="0"] button[data-act="dup"]');
    if (dupBtn) dupBtn.click();
    await wait(30);
    check('R9 复制来源 +1', ex('lpActiveScene().sources.length') === srcCnt0 + 3);

    // Transform：位置预设含自定义；选自定义出现 X/Y 输入；x/y 写入 payload sources
    const posSel = doc.querySelector('#lpSources select[data-k="pos"]');
    check('R10 位置预设含「自定义」', /custom/.test(posSel.innerHTML));
    posSel.value = 'custom';
    posSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(30);
    check('R11 选自定义后出现 X/Y 输入框', !!doc.querySelector('#lpSources input[data-k="x"]') && !!doc.querySelector('#lpSources input[data-k="y"]'));
    const xInp = doc.querySelector('#lpSources input[data-k="x"]');
    xInp.value = 'W-tw-40';
    xInp.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(30);
    check('R12 自定义 X 写入来源并进入 payload', ex('lpActiveScene().sources[0].x') === 'W-tw-40' &&
      ex('JSON.stringify(lpLanePayload(0))').indexOf('W-tw-40') > 0, ex('lpActiveScene().sources[0].x'));

    // ===== 输入文件横竖屏自动联动（ffProbe 竖版视频 → 自动切竖屏） =====
    pickPath = '/tmp/vertical_video.mp4';
    doc.getElementById('lpMediaAddBtn').click();
    await wait(120);
    check('M1 添加素材后自动探测并切竖屏', ex('lpActiveScene().orient') === 'port', ex('lpActiveScene().orient'));
    check('M2 画布容器同步竖屏', doc.getElementById('lpPrevPane').classList.contains('port'));

    // ===== main.js ff:probe 放行本地文件（静态） =====
    check('M3 main.js ff:probe 放行本地文件路径', /放行本地文件路径/.test(mainJs) && /isUrl/.test(mainJs));

    // ===== 回归：v1.1.29 能力不退化 =====
    check('B1 payload 含 sources 数组', Array.isArray(JSON.parse(ex('JSON.stringify(lpLanePayload(0))')).sources));
    const p = JSON.parse(ex('JSON.stringify(lpLanePayload(0))'));
    check('B2 payload 含 rotate/h265Tune/codec', typeof p.rotate === 'number' && typeof p.h265Tune === 'string' && !!p.codec);
    check('B3 播放地址含 LL-HLS / QUIC', /LL-HLS/.test(html) && /QUIC 播放地址/.test(html));
    check('B4 版本芯片存在', !!doc.getElementById('sideVerText'));
  } catch (e) {
    check('Ex 测试执行异常', false, (e && e.stack) || String(e));
  }

  clearTimeout(watchdog);
  const pass = results.filter((r) => r.ok).length;
  console.log('\n======== v1.1.30 端到端汇总 ========');
  console.log('通过 ' + pass + ' / ' + results.length);
  if (pass !== results.length) {
    results.filter((r) => !r.ok).forEach((r) => console.log('  FAIL ' + r.name + '  -> ' + r.detail));
  }
  process.exit(pass === results.length ? 0 : 1);
}
