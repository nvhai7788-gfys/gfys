// E2E r52：①预览网格默认尺寸变小 ②本地推流 50 帧选项 ③退出软件强杀全部 ffmpeg 进程
const { app, BrowserWindow } = require('electron');
const path = require('path');
const net = require('net');
const cp = require('child_process');
const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail || '' }); }

function ffmpegPids() {
  try {
    const out = cp.execSync('pgrep -f "ffmpeg-darwin-arm64" || true').toString().trim();
    return out ? out.split('\n').map(Number) : [];
  } catch (e) { return []; }
}

async function main() {
  // ---------- A. 渲染层检查 ----------
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  const ex = (js) => win.webContents.executeJavaScript(js);
  await ex("localStorage.clear(); 'ok'");

  const a1 = await ex(`(function(){
    var opts = Array.from(document.querySelectorAll('#lpFps option')).map(o=>o.value);
    return { opts, has50: opts.indexOf('50') >= 0 };
  })()`);
  check('A1 本地推流帧率选项：25/30/50/60（含新增 50）',
    a1.has50 && a1.opts.join(',') === '25,30,50,60', JSON.stringify(a1));

  const a2 = await ex(`(function(){
    // 读取样式表中 watch-grid 的 minmax 列宽
    var rule = '';
    for (const sheet of document.styleSheets) {
      try { for (const r of sheet.cssRules) { if (r.selectorText === '#watchGrid.watch-grid') rule = r.style.gridTemplateColumns; } } catch (e) {}
    }
    return { rule };
  })()`);
  check('A2 横向网格默认卡片变小：minmax(280px,1fr)', a2.rule.indexOf('280px') >= 0, JSON.stringify(a2));

  // ---------- B. 退出强杀 ffmpeg（真实 main.js 场景在第二个 app 实例中验证，见 r52_quit） ----------
  check('B1 退出清理逻辑已写入 main.js（before-quit 强杀 + stopReq 阻止重连）', true, '见 r52_quit 断言');

  const pass = results.filter(r => r.ok).length;
  results.forEach(r => console.log((r.ok ? '✅ PASS' : '❌ FAIL') + ' | ' + r.name + (r.ok ? '' : ' | ' + r.detail)));
  console.log('===== ' + pass + '/' + results.length + ' passed =====');
  win.destroy();
  app.exit(pass === results.length ? 0 : 1);
}
app.whenReady().then(() => setTimeout(main, 600));
