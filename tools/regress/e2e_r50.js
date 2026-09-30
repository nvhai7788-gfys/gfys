// E2E r50（v1.1.7）——阿里在线流播放域名对调根治 + 探测防御加固
// 用户账号实测拓扑（2026-09-27）：alylive.gfcnn.com(liveEdge)→alyplay.gfcnn.com(liveVideo)、
// tl.gfcnn.cn(liveEdge)→pl.gfcnn.cn(liveVideo)；且存在「直接推流到播放域名」模式
//（ces5555 推 alyplay、ces9999 推 pl，DescribeLiveStreamsOnlineList 响应 PublishDomain == DomainName）。
// v1.1.6 根因：alPlayCandidates 把 PublishDomain 无条件加入推流域名黑名单 → 正确播放域名提示被
// 剔除 → 只剩另一个错误域名（ces9999 该播 pl 却播 alyplay，域名对调）。
// v1.1.7 修复：云端响应 DomainName 即官方播放域名（官方控制台行为），权威候选不再按黑名单过滤。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
const check = (name, ok, extra) => results.push({ name, pass: !!ok, extra: extra || '' });

let dataSrv, emptySrv, DATA_PORT, EMPTY_PORT;

ipcMain.on('app:version-sync', (e) => { e.returnValue = '1.1.7-test'; });
ipcMain.on('util:md5-sync', (e, s) => { e.returnValue = crypto.createHash('md5').update(s).digest('hex'); });
ipcMain.on('util:sha256-sync', (e, s) => { e.returnValue = crypto.createHash('sha256').update(s).digest('hex'); });
ipcMain.handle('tc:call', async () => ({ ok: false, error: 'unmocked tc' }));
ipcMain.handle('ac:call', async () => ({ ok: false, error: 'unmocked ac' }));
ipcMain.handle('ff:list', async () => ({ ok: true, list: [] }));
ipcMain.handle('ff:devices', async () => ({ ok: true, devices: [] }));
ipcMain.handle('ff:pickFile', async () => ({ ok: true, path: '/tmp/test.mp4' }));
ipcMain.handle('ff:pickDir', async () => ({ ok: true, path: '/tmp/rectest' }));
ipcMain.handle('app:openPreview', async () => ({ ok: true }));
ipcMain.handle('sched:list', () => ({ schedules: [], logs: [] }));
ipcMain.handle('sched:syncCreds', () => ({ ok: true }));

const HOSTS = `[{ DomainName: 'alylive.gfcnn.com', LiveDomainType: 'liveEdge', LiveDomainStatus: 'online' },
  { DomainName: 'tl.gfcnn.cn', LiveDomainType: 'liveEdge', LiveDomainStatus: 'online' },
  { DomainName: 'alyplay.gfcnn.com', LiveDomainType: 'liveVideo', LiveDomainStatus: 'online' },
  { DomainName: 'pl.gfcnn.cn', LiveDomainType: 'liveVideo', LiveDomainStatus: 'online' }]`;

async function main() {
  await new Promise(r => { dataSrv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'video/x-flv' }); res.write('FLVhead01'); }); dataSrv.listen(0, '127.0.0.1', r); });
  await new Promise(r => { emptySrv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'video/x-flv' }); res.write(''); }); emptySrv.listen(0, '127.0.0.1', r); });
  DATA_PORT = dataSrv.address().port; EMPTY_PORT = emptySrv.address().port;

  const win = new BrowserWindow({ width: 1440, height: 960, show: false, webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true } });
  win.webContents.on('console-message', (_e, lvl, msg, line) => {
    if (lvl >= 3) console.log('[renderer:' + line + '] ' + msg.slice(0, 300));
  });
  await win.loadFile(path.join(ROOT, 'renderer/index.html'));
  await win.webContents.executeJavaScript("localStorage.clear(); 'cleared';");
  await win.loadURL('about:blank');
  await win.loadFile(path.join(ROOT, 'renderer/index.html'));
  const ex = (js) => win.webContents.executeJavaScript(js);

  await ex("state.cfg = { secretId: 'x', secretKey: 'y', region: 'ap-guangzhou', domainAuth: {}, domainKeys: {}, aliId: 'a', aliKey: 'b', users: [], genHistory: [], alDomainKeys: {}, alDomainAuth: {} }; state.connected = true; 'ok';");
  await ex(`window._alDomains = ${HOSTS}; window._ovDomains = []; window._monList = undefined; window._taskList = []; 'ok';`);
  await ex(`state.cfg.alDomainAuth = {
    'alylive.gfcnn.com': { on: true, type: 'type_a', main: 'pushA', backup: 'pushA2', deltaMin: 144000 },
    'tl.gfcnn.cn':       { on: true, type: 'type_a', main: 'pushT', backup: 'pushT2', deltaMin: 144000 },
    'alyplay.gfcnn.com': { on: true, type: 'type_a', main: 'playA', backup: 'playA2', deltaMin: 144000 },
    'pl.gfcnn.cn':       { on: true, type: 'type_a', main: 'playP', backup: 'playP2', deltaMin: 144040 }
  }; 'ok';`);
  await ex("enterApp(false); 'ok';");

  // ---------- A. 域名对调根治：云端 DomainName 权威候选 ----------
  // A1 = 用户实测案例：ces9999 直接推流到 pl.gfcnn.cn（PublishDomain == pl），应只播 pl
  const a1 = await ex(`alPlayCandidates('ces9999', 'live', 'pl.gfcnn.cn', 'pl.gfcnn.cn').map(function (u) { return u.split('/')[2]; })`);
  check('A1 ces9999（PublishDomain=pl.gfcnn.cn）：候选全部为 pl，不再被黑名单剔除后对调到 alyplay',
    a1.length > 0 && a1.every(h => h === 'pl.gfcnn.cn'), JSON.stringify(a1));

  // A2 = 反向案例：ces5555 直接推流到 alyplay.gfcnn.com，应只播 alyplay
  const a2 = await ex(`alPlayCandidates('ces5555', 'live', 'alyplay.gfcnn.com', 'alyplay.gfcnn.com').map(function (u) { return u.split('/')[2]; })`);
  check('A2 ces5555（PublishDomain=alyplay.gfcnn.com）：候选全部为 alyplay，不对调到 pl',
    a2.length > 0 && a2.every(h => h === 'alyplay.gfcnn.com'), JSON.stringify(a2));

  // A3 = 经推流域名 alylive 推流的流（PublishDomain=alylive 是真 liveEdge）：hint=alyplay 权威生效
  const a3 = await ex(`alPlayCandidates('aptest0927', 'live', 'alylive.gfcnn.com', 'alyplay.gfcnn.com').map(function (u) { return u.split('/')[2]; })`);
  check('A3 推流域名行（PublishDomain=alylive）：hint alyplay 权威生效且不受黑名单影响',
    a3.length > 0 && a3.every(h => h === 'alyplay.gfcnn.com'), JSON.stringify(a3));

  // A4 = 无 hint 且 PublishDomain 是真推流域名：不得把推流域名混进候选
  const a4 = await ex(`alPlayCandidates('st001', 'live', 'alylive.gfcnn.com', '').map(function (u) { return u.split('/')[2]; })`);
  check('A4 无 hint + 真推流域名行：候选不含 alylive.gfcnn.com（推流域名不进播放候选）',
    a4.length > 0 && a4.every(h => h !== 'alylive.gfcnn.com' && h !== 'tl.gfcnn.cn'), JSON.stringify(a4));

  // A5 = 无 hint 且 PublishDomain 是播放域名（直接推流，云端缺 DomainName 兜底）：该播放域名不被剔除
  const a5 = await ex(`alPlayCandidates('ces7777', 'live', 'pl.gfcnn.cn', '').map(function (u) { return u.split('/')[2]; })`);
  check('A5 无 hint + PublishDomain=播放域名：pl.gfcnn.cn 不被黑名单剔除（旧版被剔除只剩 alyplay）',
    a5.length > 0 && a5.some(h => h === 'pl.gfcnn.cn'), JSON.stringify(a5));

  // A6 = 多 hint（云端同流报多个播放域名，历史合并场景）：按云端顺序保留为候选
  const a6 = await ex(`alPlayCandidates('dual01', 'live', 'alylive.gfcnn.com', ['alyplay.gfcnn.com', 'pl.gfcnn.cn']).map(function (u) { return u.split('/')[2]; })`);
  check('A6 多播放域名 hint：云端顺序保留（alyplay 在前 pl 在后，作为回退序）',
    a6.length > 0 && a6[0] === 'alyplay.gfcnn.com' && a6.indexOf('pl.gfcnn.cn') >= 0, JSON.stringify(a6));

  // A7 = 各域名用各自的 Key 签名（不跨域名混用）
  const a7 = await ex(`(function () {
    var urls = alPlayCandidates('ces9999', 'live', 'pl.gfcnn.cn', 'pl.gfcnn.cn');
    var exp = Math.floor(Date.now() / 1000) + 6 * 3600;
    var uri = '/live/ces9999.flv';
    var md5 = window.tcapi.md5Sync;
    var good = urls.filter(function (u) { return u.indexOf('auth_key=' + exp + '-0-0-' + md5(uri + '-' + exp + '-0-0-playP')) >= 0; }).length;
    var bad = urls.filter(function (u) { return u.indexOf(md5(uri + '-' + exp + '-0-0-playA')) >= 0; }).length;
    return { good: good, bad: bad, total: urls.length };
  })()`);
  check('A7 签名 Key 按域名各自取（pl 用 playP，不混入 alyplay 的 playA）',
    a7.good > 0 && a7.bad === 0, JSON.stringify(a7));

  // ---------- B. 探测排序回归 + 每域名一次结算防御 ----------
  const b1 = await ex(`new Promise(function (res) {
    alPlayCandidatesAsync = function (stream, app, pushDomain, hints, cb) {
      cb(['http://127.0.0.1:${EMPTY_PORT}/b1.flv', 'http://127.0.0.1:${DATA_PORT}/b2.flv']);
    };
    var v = document.createElement('video');
    _watchPlayers['k1'] = { live: true,
      s: { _prov: 'aliyun', StreamName: 'k1x', AppName: 'live', PublishDomain: 'alylive.gfcnn.com' },
      video: v, status: document.createElement('div'), cands: [], candIdx: 0, retries: 0, player: null };
    watchStartPlay('k1');
    setTimeout(function () {
      var st = _watchPlayers['k1'];
      res({ first: st && st.cands[0] ? (st.cands[0].split('/')[2] || '') : '', n: st ? st.cands.length : 0 });
    }, 6500);
  })`);
  check('B1 观看卡起播前实测：有流数据域名排第一（回归 r47/r49 行为）',
    b1.n === 2 && b1.first === '127.0.0.1:' + DATA_PORT, JSON.stringify(b1));
  await ex(`watchStop('k1'); delete _watchPlayers['k1']; 'ok';`);

  const b2 = await ex(`new Promise(function (res) {
    // 单域名候选不探测（hosts<2 直接原序返回，无额外延迟）
    var t0 = Date.now();
    probeCandHosts(['http://127.0.0.1:${DATA_PORT}/only.flv'], function (ordered) {
      res({ ms: Date.now() - t0, same: ordered.length === 1 });
    });
  })`);
  check('B2 单域名候选跳过探测立即返回', b2.same && b2.ms < 300, JSON.stringify(b2));

  // ---------- E. 权限深链 IPC 暴露 ----------
  const e1 = await ex(`typeof window.tcapi.openPrivacy === 'function'`);
  check('E1 tcapi.openPrivacy 已暴露（权限被拒一键打开系统设置）', e1 === true, String(e1));

  let pass = 0, fail = 0;
  results.forEach(r => { if (r.pass) pass++; else { fail++; console.log('FAIL:', r.name, r.extra); } });
  console.log(`===== E2E r50: ${pass}/${results.length} PASS${fail ? ' (' + fail + ' FAIL)' : ''} =====`);
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(() => setTimeout(main, 500)).catch((e) => { console.error('E2E error:', e); app.exit(2); });
