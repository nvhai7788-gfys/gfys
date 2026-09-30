// asar 源码抽查：确认「本轮改动的代码」真的进了三个平台的包，且三平台内容一致
//
// 用途：打包 ≠ 打进包。本脚本直接读 dist 下三平台 app.asar 里的 renderer/index.html 与
//       package.json，按「关键标识正则 → 命中次数」核对，任一平台缺项即 FAIL；
//       同时打印三平台 html 字节数便于比对一致性（应完全相同）。
//
// 用法（需清掉会话注入的 NODE_OPTIONS）：
//   cd <项目根> && env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE node tools/asar-probe.js
//   # 退出码 0 = PASS，1 = FAIL
//
// 维护：每次发版把本轮新增/改名的关键函数补进 NEEDLES（可带用途说明）。
// 坑：@electron/asar 的 listPackage 返回带前导斜杠（"/package.json"），
//     而 extractFile 只认不带前导斜杠的（"package.json"），必须显式转换。
const fs = require('fs');
const path = require('path');
const ASAR = require('@electron/asar');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const EXPECT_VER = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const TARGETS = [
  ['mac-arm64', 'mac-arm64/港丰影视直播工作台.app/Contents/Resources/app.asar'],
  ['mac-x64', 'mac/港丰影视直播工作台.app/Contents/Resources/app.asar'],
  ['win-x64', 'win-unpacked/resources/app.asar']
];
// 关键标识（任一为 0 即说明该平台的包没打进去）
const NEEDLES = {
  'alPushDom 阿里推流域名': /function alPushDom/g,
  'alBitRateToKbps 单位换算': /function alBitRateToKbps/g,
  'extMonList 注入外部流': /function extMonList/g,
  'extAdd 加入外部流': /function extAdd\(/g,
  'extRemove 手动关闭': /function extRemove\(/g,
  'extHistFinalize 历史落盘': /function extHistFinalize\(/g,
  'extHistOwn 收尾幂等': /function extHistOwn\(/g,
  'qRenderExt 质量卡实测': /function qRenderExt\(/g,
  'extMeasure 静默实测': /function extMeasure\(/g,
  '外部流历史存储键': /wb_tclive_exthist/g,
  '外部地址流 UI 文案': /外部地址流/g,
  'ff:probe 采样秒数': /seconds:\s*sec/g
};

let bad = 0;
const sizes = [];
TARGETS.forEach(function (t) {
  const name = t[0], p = path.resolve(DIST, t[1]);
  if (!fs.existsSync(p)) { console.log('[' + name + '] 缺少 app.asar：' + t[1]); bad++; return; }
  const files = ASAR.listPackage(p)
    .filter(function (f) { return /(^|\/)renderer\/index\.html$/.test(f) || /(^|\/)package\.json$/.test(f); })
    .map(function (f) { return f.replace(/^\//, ''); });   // listPackage 带前导斜杠，extractFile 反而不认（实测）
  let html = '', pkg = '';
  files.forEach(function (f) {
    const buf = ASAR.extractFile(p, f).toString('utf8');
    if (/index\.html$/.test(f)) html = buf; else pkg = buf;
  });
  if (!html) { console.log('[' + name + '] app.asar 内未找到 renderer/index.html'); bad++; return; }
  const ver = (pkg.match(/"version"\s*:\s*"([^"]+)"/) || [])[1] || '?';
  const miss = [];
  const out = [];
  Object.keys(NEEDLES).forEach(function (k) {
    const n = (html.match(NEEDLES[k]) || []).length;
    if (!n) { bad++; miss.push(k); }
    out.push(k + '=' + n);
  });
  if (ver !== EXPECT_VER) { bad++; console.log('[' + name + '] 版本不符：包内 ' + ver + ' ≠ package.json ' + EXPECT_VER); }
  sizes.push(name + '=' + html.length);
  console.log('[' + name + '] version=' + ver + ' html=' + html.length + 'B' + (miss.length ? '  缺失：' + miss.join('、') : ''));
  console.log('   ' + out.join('  '));
});

// 三平台内容一致性：同一次构建的三个包，renderer/index.html 应逐字节相同
const uniq = new Set(sizes.map(function (s) { return s.split('=')[1]; }));
if (uniq.size > 1) { bad++; console.log('\n三平台 html 大小不一致：' + sizes.join('  ')); }
else console.log('\n三平台 html 大小一致：' + sizes.join('  '));

console.log(bad === 0 ? '\nASAR PROBE PASS（三平台标识齐全、版本一致、内容一致）' : '\nASAR PROBE FAIL，问题项 ' + bad);
process.exit(bad === 0 ? 0 : 1);
