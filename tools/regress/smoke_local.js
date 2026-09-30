// 本机环境冒烟测试：真加载 renderer/index.html（含全部 vendor），统计关键元素与加载错误
// 用途：换机/新环境同步后，快速确认源码可加载、UI 结构完整
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');
let html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

// jsdom 不会自动拉取外部 <script src>，把 scene-engine.js 内联进来（与官方 e2e 用例同法）
const seSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'scene-engine.js'), 'utf8');
html = html.replace('<script src="scene-engine.js"></script>', '<script>\n' + seSrc + '\n</script>');

const errs = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errs.push(String((e && e.message) || e)));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  virtualConsole: vc,
  url: 'http://localhost/',
  pretendToBeVisual: true
});
const w = dom.window;

setTimeout(() => {
  const d = w.document;
  const out = {
    SceneEngine: typeof w.SceneEngine,
    DOM节点数: d.querySelectorAll('*').length,
    导航项: d.querySelectorAll('.nav-item, [data-page]').length,
    工作室区域: !!d.querySelector('#lpStudio') || !!d.querySelector('.studio'),
    添加来源按钮: !!d.querySelector('#lpSrcAddMenu'),
    来源列表容器: !!d.querySelector('#lpSources'),
    id元素总数: d.querySelectorAll('[id]').length,
    jsdomError数: errs.length
  };
  console.log('=== 本机冒烟测试 ===');
  for (const [k, v] of Object.entries(out)) console.log('  ' + k + ':', v);
  if (errs.length) console.log('  前3条错误:', errs.slice(0, 3).join(' | ').slice(0, 500));
  process.exit(0);
}, 2500);
