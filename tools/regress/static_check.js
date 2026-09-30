// 静态校验：抽取 HTML 内联脚本做语法检查 + DOM id 引用完整性 + 关键函数存在性
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = process.argv[2];
const html = fs.readFileSync(FILE, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
console.log('内联脚本块:', scripts.length, '总字符:', scripts.reduce((a, s) => a + s.length, 0));

let fail = 0;
scripts.forEach((code, i) => {
  const line = html.slice(0, html.indexOf(code)).split('\n').length;
  try {
    new vm.Script(code, { filename: 'inline-script-' + i });
    console.log('  [OK]  脚本块 ' + i + '（起始行 ' + line + '，' + code.length + ' 字符）');
  } catch (e) {
    console.log('  [FAIL] 脚本块 ' + i + '（起始行 ' + line + '）：' + e.message);
    fail++;
  }
});

// 静态引用的 DOM id 是否都存在于 HTML 中（只查 $( 'x' ) / getElementById('x') 的字面量）
const body = html.replace(/<script[\s\S]*?<\/script>/gi, '');
const ids = new Set([...body.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
// 运行时动态创建的 id 也算「存在」：模板字符串里的 id=\"x\" / id='x'，以及 el.id = 'x'
// （早期版本只看静态 HTML，把「JS 运行时插入 DOM」的按钮误报成断链，这里补上）
const dyn = new Set();
for (const m of html.matchAll(/\bid=\\?["']([A-Za-z][\w-]*)\\?["']/g)) dyn.add(m[1]);
for (const m of html.matchAll(/\.id\s*=\s*['"]([A-Za-z][\w-]*)['"]/g)) dyn.add(m[1]);
const refs = new Set();
for (const m of html.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)) refs.add(m[1]);
for (const m of html.matchAll(/getElementById\('([A-Za-z][\w-]*)'\)/g)) refs.add(m[1]);
const missing = [...refs].filter(x => !ids.has(x) && !dyn.has(x));
console.log('\nHTML 中 id 数:', ids.size, '运行时动态 id 数:', dyn.size, '静态引用 id 数:', refs.size);
if (missing.length) { console.log('  [FAIL] 引用了不存在的 id:', missing.join(', ')); fail++; }
else console.log('  [OK]  所有静态引用的 id 都存在（含运行时动态创建的）');

// 重复 id（HTML 规范禁止，会导致 $() 取到错误元素）
const all = [...body.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const dup = all.filter((x, i) => all.indexOf(x) !== i);
const dupU = [...new Set(dup)];
if (dupU.length) { console.log('  [WARN] 重复 id:', dupU.join(', ')); }
else console.log('  [OK]  无重复 id');

// 关键函数是否成对定义（define + 调用）
const need = process.argv.slice(3).filter(Boolean);
if (need.length) {
  console.log('\n关键函数定义检查:');
  need.forEach(fn => {
    const def = new RegExp('\\nfunction ' + fn + '\\s*\\(').test(html);
    const use = new RegExp('[^\\w.]' + fn + '\\s*\\(').test(html);
    const ok = def;
    console.log('  ' + (ok ? '[OK]  ' : '[FAIL]') + ' ' + fn + ' 定义=' + def + ' 被引用=' + use);
    if (!ok) fail++;
  });
}

console.log('\n=== ' + (fail ? (fail + ' 项失败') : 'ALL PASS') + ' ===');
process.exit(fail ? 1 : 0);
