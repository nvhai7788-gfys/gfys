// jsdom 端到端（v1.1.46）：地址生成横版 + 流条目横屏 + 云商合并 + 菜单版本/免责声明页
//   ① 地址横版：腾讯云 genPushCard/genPlayCard 纵向堆叠（PUSH 上、PLAY 下）；阿里云 alAddrGroupedHtml 归组
//   ② 流条目横屏：qGrid 单列（1fr）；watchGrid 保留 grid/list 切换
//   ③ 云商合并：provTencent/provAliyun 已移除；PROVIDER_VIEWS 两份一致且含 watch/localpush/localrec
//   ④ 菜单版本：顶栏 topVerText；免责声明独立菜单页 data-view=legal + #view-legal；VIEW_REFRESHERS 含 legal
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
  md5Sync: (s) => 'md5_' + s.length,
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

  // ===== ① 地址生成横版（腾讯云纵向堆叠） =====
  const pushCard = doc.querySelector('#genPushCard');
  const playCard = doc.querySelector('#genPlayCard');
  check('B1 genPushCard / genPlayCard 存在', !!pushCard && !!playCard);
  const wrap = pushCard && pushCard.parentElement;
  check('B2 外层容器为纵向堆叠（flex-direction:column）', !!wrap && wrap.style.display === 'flex' && wrap.style.flexDirection === 'column',
    wrap && (wrap.style.display + '/' + wrap.style.flexDirection));
  check('B3 PUSH 卡在 PLAY 卡之前（文档顺序）', !!pushCard && !!playCard && (pushCard.compareDocumentPosition(playCard) & window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0);

  // 阿里云分组渲染函数
  check('B4 alAddrGroupedHtml 已定义', ex('typeof alAddrGroupedHtml === "function"'));
  const grouped = ex('alAddrGroupedHtml([{label:"RTMP 推流地址",value:"rtmp://a"},{label:"RTMP 播放地址",value:"rtmp://b",preview:true},{label:"HLS 播放地址",value:"https://c.m3u8",preview:true}])');
  check('B5 PUSH 组在上（分组标题先出现）', grouped.indexOf('PUSH 推流地址') < grouped.indexOf('PLAY 播放地址'), '');
  check('B6 保留原始下标（data-alcopy=0 指向推流地址）', grouped.indexOf('data-alcopy="0"') >= 0);
  check('B7 预览标记保留（data-alprev）', grouped.indexOf('data-alprev') >= 0);

  // ===== ② 流条目横屏 =====
  const qGrid = doc.querySelector('#qGrid');
  check('C1 qGrid 单列（grid-template-columns:1fr）', !!qGrid && qGrid.style.gridTemplateColumns === '1fr', qGrid && qGrid.style.gridTemplateColumns);
  const watchGrid = doc.querySelector('#watchGrid');
  check('C2 watchGrid 保留（grid/list 可切换）', !!watchGrid);

  // ===== ③ 云商合并 =====
  check('D1 provTencent/provAliyun 已移除', !doc.querySelector('#provTencent') && !doc.querySelector('#provAliyun'));
  const provTencent = ex('PROVIDER_VIEWS.tencent');
  const provAliyun = ex('PROVIDER_VIEWS.aliyun');
  check('D2 tencent 列表含 watch/localpush/localrec（修复未登录隐藏缺陷）',
    provTencent.indexOf('watch') >= 0 && provTencent.indexOf('localpush') >= 0 && provTencent.indexOf('localrec') >= 0,
    provTencent.join(','));
  check('D3 两份列表完全一致', JSON.stringify(provTencent) === JSON.stringify(provAliyun));

  // ===== ④ 菜单版本 + 免责声明页 =====
  check('E1 顶栏版本芯片 #topVerText 存在', !!doc.querySelector('#topVerText'));
  const legalNav = doc.querySelector('.nav-item[data-view="legal"]');
  check('E2 免责声明独立菜单项 data-view=legal', !!legalNav, '');
  check('E3 #view-legal 页面存在', !!doc.querySelector('#view-legal'));
  check('E4 VIEW_REFRESHERS 含 legal 占位', ex('typeof VIEW_REFRESHERS.legal === "function"'));
  check('E5 legal 菜单项注入颜色（--ni）', !!legalNav && !!legalNav.style.getPropertyValue('--ni'), legalNav && legalNav.style.getPropertyValue('--ni'));
  check('E6 operator/viewer 角色可读 legal', ex('ROLE_PERMS.operator.indexOf("legal") >= 0 && ROLE_PERMS.viewer.indexOf("legal") >= 0'));

  clearTimeout(watchdog);
  const pass = results.filter(r => r.ok).length;
  console.log('\n======== v1.1.46 地址横版/流横屏/云商合并/菜单版本 端到端汇总 ========');
  console.log('通过 ' + pass + ' / ' + results.length);
  process.exit(pass === results.length ? 0 : 1);
}

dom.window.addEventListener('load', () => { run(); });
setTimeout(run, 2500);
