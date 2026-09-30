// E2E r64：单流详细检测（流质量页「单流详细检测」折叠区）三处缺陷的确定性回归
//  ① 单流查询请求体缺 AppName：实时卡片 qDetectOne 与多流批量 qQueryMulti 都传了 AppName
//     （不传则应用名非 live 的流永远查不到数据），唯独单流路径漏传 → 单流详细检测查不出东西。
//     修复：新增 AppName 输入框 #qApp（默认 live），请求体必传。
//  ② 时间范围与推流域名下拉只在首次进入填充（_qLoaded 一次性守卫）：隔一段时间再进页面，
//     窗口仍停在首次那 30 分钟 → 查询必然「该时间段没有质量数据」；域名列表首次没拉到就永久只剩「不限」。
//     修复：每次进入刷新（用户手动改过时间范围则不覆盖），域名下拉每次重建并保留选择。
//  ③ 「导出 CSV（单流）」只看 window.qData：走多流查询后必然误报「请先执行检测」。
//     修复：回退导出第一条多流结果。
// 用法：env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1 electron tools/regress/e2e_r64.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..', '..');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const out = [];
function chk(n, ok, d) { out.push({ n, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  → ' + JSON.stringify(d))); }

(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1500, height: 950, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  const ex = (js) => win.webContents.executeJavaScript(js);
  await wait(600);
  await ex("localStorage.clear(); (function(){ state.cfg={}; enterApp(false); })(); 'ok'");
  await wait(300);
  await ex(`(function(){ window.__calls=[]; window.api=function(a,p){ window.__calls.push({action:a,payload:p});
      return Promise.resolve({ ok:true, data:{ DataInfoList:[
        { Time:'2026-09-29T02:00:00Z', Resolution:'1920x1080', VCodec:'H.264', VideoFps:25, AudioFps:44, VideoRate:3500000, VideoTs:1000, AudioTs:1015, MateFps:30 } ] } }); };
    window.__csv=null; window.exportCsv=function(n,h,r){ window.__csv={name:n,header:h,rows:r}; }; return 'ok' })()`);

  // 进入质量页（域名列表此时为空）
  await ex(`document.querySelector('.nav-item[data-view="quality"]').click(); 'ok'`);
  await wait(400);
  const s1 = await ex(`({ start: $('qStart').value, end: $('qEnd').value, dom: $('qDomain').options.length })`);
  chk('1 首次进入：时间范围为最近 30 分钟且已填充', !!s1.start && !!s1.end, s1);

  // 单流查询 → payload 必须含 AppName
  await ex(`(function(){ document.querySelector('#view-quality details').open = true;
    $('qStream').value='mystream'; $('qApp').value='myapp'; $('qQueryBtn').click(); return 'ok' })()`);
  await wait(900);
  const s2 = await ex(`(function(){
    var c = (window.__calls||[]).filter(function(x){ return x.action === 'DescribeStreamPushInfoList'; })[0]||{};
    var p = c.payload||{};
    return { payload: p, rows: document.querySelectorAll('#qBody tr').length,
      firstRow: (document.querySelector('#qBody tr')||{}).textContent||'' }; })()`);
  chk('2 单流查询请求体含 AppName（默认/自定义都能带上）', s2.payload.AppName === 'myapp', s2.payload);
  chk('2b 单流查询结果正常渲染（表格有数据行）', s2.rows === 1, s2);

  // 默认 AppName：清空 qApp 应回落 live
  await ex(`(function(){ window.__calls=[]; $('qApp').value=''; $('qQueryBtn').click(); return 'ok' })()`);
  await wait(700);
  const s3 = await ex(`((window.__calls[0]||{}).payload||{})`);
  chk('3 AppName 留空时回落 live（与实时卡片口径一致）', s3.AppName === 'live', s3);

  // 时间范围：模拟「隔很久再进页面」——把值改旧（未手动改过）后重新进入应被刷新
  await ex(`(function(){ $('qStart').value='2020-01-01T00:00'; $('qEnd').value='2020-01-01T00:30';
    // 不触发 change（模拟代码里直接写入的旧值 / 长时间未使用），再点导航进入
    document.querySelector('.nav-item[data-view="overview"]').click(); return 'ok' })()`);
  await wait(200);
  await ex(`document.querySelector('.nav-item[data-view="quality"]').click(); 'ok'`);
  await wait(400);
  const s4 = await ex(`({ start: $('qStart').value, end: $('qEnd').value })`);
  chk('4 再次进入：过期时间范围被刷新（不再停在旧窗口）', s4.start.indexOf('2020-') !== 0, s4);

  // 用户手动改过 → 不被覆盖
  await ex(`(function(){ $('qStart').value='2020-01-01T00:00'; $('qStart').dispatchEvent(new Event('change')); return 'ok' })()`);
  await wait(100);
  await ex(`(function(){ document.querySelector('.nav-item[data-view="overview"]').click(); return 'ok' })()`);
  await wait(150);
  await ex(`document.querySelector('.nav-item[data-view="quality"]').click(); 'ok'`);
  await wait(400);
  const s5 = await ex(`$('qStart').value`);
  chk('5 用户手动改过时间范围后不被自动覆盖', s5 === '2020-01-01T00:00', s5);

  // 域名下拉：有域名数据时重建并保留选择
  // 先离开（会被 refreshOverview 用 mock 覆盖 _ovDomains），再设域名数据，最后回到质量页
  await ex(`(function(){ document.querySelector('.nav-item[data-view="overview"]').click(); return 'ok' })()`);
  await wait(250);
  await ex(`(function(){ window._ovDomains=[{Type:0,Name:'push.a.com'},{Type:1,Name:'play.a.com'}]; $('qDomain').value=''; return 'ok' })()`);
  await ex(`document.querySelector('.nav-item[data-view="quality"]').click(); 'ok'`);
  await wait(400);
  const s6 = await ex(`(function(){ var o=[].slice.call($('qDomain').options).map(function(x){return x.value}); return {opts:o}; })()`);
  chk('6 推流域名下拉按最新域名列表重建（含真实推流域名）', s6.opts.indexOf('push.a.com') >= 0 && s6.opts.indexOf('play.a.com') < 0, s6);

  // CSV 回退：只做多流查询后点「导出 CSV（单流）」
  await ex(`(function(){ window.qData=[]; window._monList=[{_prov:'tencent',StreamName:'s1',AppName:'live',DomainName:'push.a.com'}];
    $('qLoadStreamsBtn').click(); return 'ok' })()`);
  await wait(300);
  await ex(`(function(){ var c=document.getElementById('qSelAll'); c.checked=true; c.dispatchEvent(new Event('change')); return 'ok' })()`);
  await wait(150);
  await ex(`$('qQueryBtn').click(); 'ok'`);
  await wait(900);
  await ex(`(function(){ window.__csv=null; $('qExportBtn').click(); return 'ok' })()`);
  await wait(300);
  const s7 = await ex(`window.__csv`);
  chk('7 多流查询后「导出 CSV（单流）」回退导出多流数据（不再误报请先执行检测）',
    !!(s7 && s7.rows && s7.rows.length === 1), s7);

  const bad = out.filter(x => !x.ok).length;
  console.log('———— ' + (out.length - bad) + '/' + out.length + (bad ? ' FAILED' : ' ALL PASS'));
  await app.quit();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('ERR', e); app.quit(); process.exit(1); });
