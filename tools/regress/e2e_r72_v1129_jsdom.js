// jsdom 端到端：真加载 renderer/index.html，mock 云桥，验证 v1.1.29 四项能力
//   #82 版本号芯片  #84 H.265 优化档  #85 OBS 场景/来源 + 横竖屏  #3 低延时播放地址（静态）
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = require('path').resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const srcHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'); // 仅用于静态比对根文件是否含同款特性

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + (detail || '')));
}

const tcHandlers = {
  appVersion: '1.1.29',
  ff: () => Promise.resolve({ ok: true, id: 'ff_test_1' }),
  ffStop: () => Promise.resolve({ ok: true }),
  ffPickFile: () => Promise.resolve({ ok: true, path: '/tmp/watermark.png' }),
  ffListEncoders: () => Promise.resolve({ ok: true, list: [
    { id: 'libx264', fam: 'h264', label: 'H.264', hw: false },
    { id: 'h264_videotoolbox', fam: 'h264', label: 'H.264 硬', hw: true },
    { id: 'libx265', fam: 'hevc', label: 'H.265', hw: false },
    { id: 'hevc_videotoolbox', fam: 'hevc', label: 'H.265 硬', hw: true },
    { id: 'libvpx-vp9', fam: 'vp9', label: 'VP9', hw: false },
  ] }),
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

    // #82 版本号芯片
    const sideVer = doc.getElementById('sideVerText');
    check('V1 侧边栏版本芯片元素存在', !!sideVer);
    check('V2 版本号渲染为 v1.1.29（来自 tcapi.appVersion）', sideVer && sideVer.textContent === 'v1.1.29', sideVer && sideVer.textContent);

    // #85 场景/来源 MVP 基础
    const sel = doc.getElementById('lpSceneSel');
    check('S1 场景选择器已渲染且至少 1 个场景', sel && sel.options.length >= 1, sel && ('options=' + sel.options.length));
    check('S2 默认激活场景存在', ex('!!lpActiveScene()'));

    // 横屏/竖屏切换
    doc.getElementById('lpOrientPort').click();
    await wait(30);
    check('S3 切竖屏：场景 orient=port', ex('lpActiveScene().orient') === 'port', ex('lpActiveScene().orient'));
    check('S4 切竖屏：画布尺寸联动为 1080x1920', doc.getElementById('lpSize').value === '1080x1920', doc.getElementById('lpSize').value);
    check('S5 切竖屏：lpOrientPort 高亮(.on)', doc.getElementById('lpOrientPort').classList.contains('on'));
    doc.getElementById('lpOrientLand').click();
    await wait(30);
    check('S6 切横屏：场景 orient=land', ex('lpActiveScene().orient') === 'land');
    check('S7 切横屏：画布尺寸联动为 1920x1080', doc.getElementById('lpSize').value === '1920x1080', doc.getElementById('lpSize').value);

    // 旋转
    const rot = doc.getElementById('lpRotate');
    rot.value = '90'; fire('lpRotate', 'change');
    await wait(20);
    check('S8 旋转 90° 写入场景 rotate', ex('lpActiveScene().rotate') === 90, String(ex('lpActiveScene().rotate')));

    // 添加来源
    const before = ex('lpActiveScene().sources.length');
    doc.getElementById('lpSrcAdd').click();
    await wait(30);
    const after = ex('lpActiveScene().sources.length');
    check('S9 添加来源后 sources +1', after === before + 1, 'before=' + before + ' after=' + after);
    check('S10 新增来源默认是文字类型', ex('lpActiveScene().sources[' + (after - 1) + '].type') === 'text');
    check('S11 来源面板已渲染输入框', /<input/.test(doc.getElementById('lpSources').innerHTML));

    // #84 H.265 优化档（直接驱动函数，避免依赖下拉是否含 libx265）
    ex('lpSyncH265Box("hevc")');
    await wait(20);
    check('H1 H.265 优化档面板在 hevc 族时显示', doc.getElementById('lpH265Box').style.display !== 'none', 'display=' + doc.getElementById('lpH265Box').style.display);
    check('H2 lpH265Tune 下拉存在', !!doc.getElementById('lpH265Tune'));
    ex('lpSyncH265Box("h264")');
    await wait(20);
    check('H3 非 HEVC 族时 H.265 优化档隐藏', doc.getElementById('lpH265Box').style.display === 'none');

    // 推送 payload 关键字段（来源叠加 + 横竖屏旋转 + H.265 优化档）
    const p = JSON.parse(ex('JSON.stringify(lpLanePayload(0))'));
    check('P1 payload 含 sources 数组', Array.isArray(p.sources), 'type=' + typeof p.sources);
    check('P2 payload 含 rotate 数字', typeof p.rotate === 'number', 'rotate=' + p.rotate);
    check('P3 payload 含 h265Tune 字符串', typeof p.h265Tune === 'string', 'h265Tune=' + p.h265Tune);
    check('P4 payload 含 codec 字段', !!p.codec, 'codec=' + p.codec);

    // #3 低延时播放地址（静态比对根/渲染文件均含 LL-HLS 与 QUIC）
    check('L1 播放地址生成器含 LL-HLS 选项', /LL-HLS/.test(html));
    check('L2 播放地址生成器含 QUIC 选项', /QUIC 播放地址/.test(html));
    check('L3 根 index.html 同样含 LL-HLS（双文件一致）', /LL-HLS/.test(srcHtml));
  } catch (e) {
    check('Ex 测试执行异常', false, (e && e.stack) || String(e));
  }

  clearTimeout(watchdog);
  const pass = results.filter((r) => r.ok).length;
  console.log('\n======== v1.1.29 端到端汇总 ========');
  console.log('通过 ' + pass + ' / ' + results.length);
  if (pass !== results.length) {
    results.filter((r) => !r.ok).forEach((r) => console.log('  FAIL ' + r.name + '  -> ' + r.detail));
  }
  process.exit(pass === results.length ? 0 : 1);
}
