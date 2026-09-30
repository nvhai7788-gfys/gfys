// E2E r53-main：真实 main.js IPC 下阿里云资源包真实查询渲染（BSS QueryResourcePackageInstances）
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
ipcMain.on('app:version-sync', (e) => { e.returnValue = 'test'; });
const ROOT = require('path').resolve(__dirname, '..', '..');
require(path.join(ROOT, 'main.js'));

async function main() {
  let win = null;
  for (let i = 0; i < 60 && !win; i++) {
    await new Promise(r => setTimeout(r, 500));
    const ws = BrowserWindow.getAllWindows();
    if (ws.length) { try { if (!ws[0].webContents.isLoading()) win = ws[0]; } catch (e) {} }
  }
  const ex = (js) => win.webContents.executeJavaScript(js);
  await ex("localStorage.clear(); (function(){ state.cfg={}; bindWatchPrefs(); bindMonitorPrefs(); })(); 'ok'");
  // 配置真实 AK 并切到资源包页阿里云页签触发查询
  await ex(`(function(){
    state.cfg.aliId='LTAI_E2E_TEST_ID'; state.cfg.aliKey='ALI_KEY_E2E_TEST_SECRET';   // 占位符：真实 AK 不入库（历史真机验证用例）
    setViewCloud('package', 'al');
    return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 8000));
  const r1 = await ex(`(function(){
    var pane = document.getElementById('view-package').querySelector(':scope > .cloud-pane');
    var rows = pane.querySelectorAll('#alPkgBody tr');
    var first = rows[0] ? rows[0].textContent : '';
    return { rowCount: rows.length, statsShown: document.getElementById('alPkgStats').style.display === 'grid',
             active: document.getElementById('alPkgActive').textContent,
             total: document.getElementById('alPkgTotal').textContent,
             left: document.getElementById('alPkgLeft').textContent,
             tabsOn: document.querySelector('#view-package .cloud-tabs [data-cloud="al"]').classList.contains('on'),
             err: first.indexOf('查询失败') >= 0 ? first.slice(0, 160) : '' };
  })()`);
  const ok1 = !r1.err && r1.rowCount >= 1 && r1.statsShown && r1.tabsOn;
  console.log((ok1 ? '✅ PASS' : '❌ FAIL') + ' | E1 真实 BSS 查询+页签切换渲染：' + JSON.stringify(r1));
  console.log('===== ' + (ok1 ? 1 : 0) + '/1 passed =====');
  app.exit(ok1 ? 0 : 1);
}
app.whenReady().then(() => setTimeout(main, 800));
