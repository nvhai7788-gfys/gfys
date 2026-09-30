// E2E v1.1.3：阿里云播放地址串域根治之三——
// ①「200 空响应」看门狗（鉴权通过但流未路由到该播放域名：200+0字节，播放器永不报错 → 自动回退失效）
// ②候选瘦身（协议/https 跟随监控设置、每域名最多主+备 2 Key、裸 Key 不再混入有 Key 域名）
// ③成功播放域名自学习（实测哪个域名真有流 → 记忆 → 下次排最前）
// ④全候选失败后自动从头重试一轮
// ⑤独立预览窗口同款看门狗
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
const check = (name, ok, extra) => results.push({ name, pass: !!ok, extra: extra || '' });

// 本地 200 空响应服务器：模拟「流未路由到该播放域名」的 CDN 行为（200 + 永不发送数据 + 永不结束）
const emptySrv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'video/x-flv' });
  res.write('');            // 0 字节，连接保持
  req.on('close', () => { try { res.destroy(); } catch (e) {} });
});
let PORT = 0;

ipcMain.on('app:version-sync', (e) => { e.returnValue = '1.1.3-test'; });
ipcMain.on('util:md5-sync', (e, s) => { e.returnValue = crypto.createHash('md5').update(s).digest('hex'); });
ipcMain.on('util:sha256-sync', (e, s) => { e.returnValue = crypto.createHash('sha256').update(s).digest('hex'); });
ipcMain.handle('tc:call', async () => ({ ok: false, error: 'unmocked tc' }));
ipcMain.handle('ac:call', async (_e, args) => {
  const p = (args && (args.params || args.payload)) || {};
  if (args.action === 'DescribeLiveUserDomains') {
    return { ok: true, data: { Domains: { PageData: [
      { DomainName: 'push.gfcnn.com', LiveDomainType: 'liveEdge', LiveDomainStatus: 'online' },
      { DomainName: 'alyplay.gfcnn.com', LiveDomainType: 'liveVideo', LiveDomainStatus: 'online' },
      { DomainName: 'pl.gfcnn.cn', LiveDomainType: 'liveVideo', LiveDomainStatus: 'online' }
    ], TotalCount: 3 } } };
  }
  if (args.action === 'DescribeLiveDomainConfigs') return { ok: true, data: { DomainConfigs: { DomainConfig: [] } } };
  return { ok: false, error: 'unmocked ac: ' + args.action };
});
ipcMain.handle('ff:list', async () => ({ ok: true, list: [] }));
ipcMain.handle('ff:devices', async () => ({ ok: true, devices: [] }));
ipcMain.handle('ff:pickFile', async () => ({ ok: true, path: '/tmp/test.mp4' }));
ipcMain.handle('ff:pickDir', async () => ({ ok: true, path: '/tmp/rectest' }));
ipcMain.handle('app:openPreview', async () => ({ ok: true }));
ipcMain.handle('sched:list', () => ({ schedules: [], logs: [] }));
ipcMain.handle('sched:syncCreds', () => ({ ok: true }));

async function main() {
  await new Promise(r => emptySrv.listen(0, '127.0.0.1', r));
  PORT = emptySrv.address().port;

  const win = new BrowserWindow({ width: 1440, height: 960, show: false, webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true } });
  win.webContents.on('console-message', (_e, lvl, msg, line) => {
    if (lvl >= 3) console.log('[renderer:' + line + '] ' + msg.slice(0, 300));
  });
  await win.loadFile(path.join(ROOT, 'renderer/index.html'));
  await win.webContents.executeJavaScript("localStorage.clear(); 'cleared';");
  await win.loadURL('about:blank');
  await win.loadFile(path.join(ROOT, 'renderer/index.html'));
  const ex = (js) => win.webContents.executeJavaScript(js);

  await ex("state.cfg = { secretId: 'x', secretKey: 'y', region: 'ap-guangzhou', domainAuth: {}, domainKeys: {}, aliId: 'a', aliKey: 'b', alDomainAuth: {}, alDomainKeys: {}, users: [], genHistory: [] }; state.connected = true; 'ok';");
  await ex("window._ovDomains = []; window._alDomains = []; window._monList = undefined; window._taskList = []; 'ok';");
  await ex("enterApp(false); 'ok';");
  // 两域名主 Key 预置（免拉云端）
  await ex(`state.cfg.alDomainAuth = {
    'alyplay.gfcnn.com': { on: true, type: 'type_a', main: 'key_aly', backup: 'key_aly_bk' },
    'pl.gfcnn.cn': { on: true, type: 'type_a', main: 'key_pl' }
  }; 'ok';`);

  // ---------- A. 候选瘦身 ----------
  const a1 = await ex(`alPlayCandidates('csi33333', 'liveApp', 'push.gfcnn.com', ['alyplay.gfcnn.com', 'pl.gfcnn.cn'])`);
  check('A1 候选瘦身：主+备 Key 有上限（alyplay 主备 2 条 + pl 主 1 条 = 3 条，不再全组合膨胀）',
    a1.length === 3 &&
    a1.filter(u => u.indexOf('alyplay.gfcnn.com') >= 0).length === 2 &&
    a1.filter(u => u.indexOf('pl.gfcnn.cn') >= 0).length === 1, JSON.stringify(a1));
  check('A1b 每条都是 https+flv 且已签名（auth_key 附加、无裸地址混入）',
    a1.every(u => /^https:\/\/(alyplay\.gfcnn\.com|pl\.gfcnn\.cn)\/liveApp\/csi33333\.flv\?auth_key=/.test(u)),
    JSON.stringify(a1));

  const a2 = await ex(`(function () {
    document.getElementById('monProto').value = 'hls';
    var hls = alPlayCandidates('csi33333', 'liveApp', 'push.gfcnn.com', ['alyplay.gfcnn.com', 'pl.gfcnn.cn']);
    document.getElementById('monProto').value = 'flv';
    document.getElementById('monHttps').checked = false;
    var httpBoth = alPlayCandidates('csi33333', 'liveApp', 'push.gfcnn.com', ['alyplay.gfcnn.com', 'pl.gfcnn.cn']);
    document.getElementById('monHttps').checked = true;
    return { hls: hls, httpBoth: httpBoth };
  })()`);
  check('A2 协议跟随设置：monProto=hls → 全部 .m3u8', a2.hls.every(u => u.indexOf('.m3u8?') > 0), JSON.stringify(a2.hls));
  check('A2b 关闭 https → http/https 双方案（3 Key × 2 方案 = 6 条）',
    a2.httpBoth.length === 6 && a2.httpBoth.filter(u => u.indexOf('http://') === 0).length === 3, JSON.stringify(a2.httpBoth));

  // ---------- B. 成功域名自学习 ----------
  const b1 = await ex(`(function () {
    state.cfg.alPlayDomOk = { 'liveApp|csi77777': 'pl.gfcnn.cn' };
    var c = alPlayCandidates('csi77777', 'liveApp', 'push.gfcnn.com', ['alyplay.gfcnn.com', 'pl.gfcnn.cn']);
    return { first: (c[0].split('/')[2] || '') };
  })()`);
  check('B1 自学习：上次成功域名（pl）排到候选最前', b1.first === 'pl.gfcnn.cn', JSON.stringify(b1));

  // ---------- C. 看门狗：200 空响应 ----------
  // C1 成功路径：buffered 有数据 → 清看门狗 + 记忆成功域名
  await ex(`(function () {
    var v = document.createElement('video');
    Object.defineProperty(v, 'buffered', { get: function () { return { length: 1 }; } });
    _watchPlayers['t1'] = { live: true,
      s: { _prov: 'aliyun', StreamName: 'csiwd', AppName: 'liveApp', PublishDomain: 'push.gfcnn.com' },
      video: v, status: document.createElement('div'), cands: ['http://127.0.0.1:${PORT}/ok.flv'], candIdx: 0, retries: 0, player: null };
    watchPlayCand('t1');
    return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 2500));
  const c1 = await ex(`({ learned: (state.cfg.alPlayDomOk || {})['liveApp|csiwd'], wdCleared: !_watchPlayers.t1.wd })`);
  check('C1 看门狗·成功路径：收到媒体数据即记忆成功域名并清除看门狗',
    c1.learned === '127.0.0.1:' + PORT && c1.wdCleared, JSON.stringify(c1));
  await ex(`watchStop('t1'); delete _watchPlayers['t1']; 'ok';`);

  // C2 失败路径：200 空响应无数据 → 7 秒判失败切候选；全候选失败 → 从头重试一轮
  await ex(`(function () {
    var v = document.createElement('video');   // 真实 video：buffered 恒空
    _watchPlayers['t2'] = { live: true,
      s: { _prov: 'aliyun', StreamName: 'csi33333', AppName: 'liveApp', PublishDomain: 'push.gfcnn.com' },
      video: v, status: document.createElement('div'),
      cands: ['http://127.0.0.1:${PORT}/e1.flv', 'http://127.0.0.1:${PORT}/e2.flv'], candIdx: 0, retries: 0, player: null };
    watchPlayCand('t2');
    return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 8200));   // > 7s 看门狗
  const c2 = await ex(`({ idx: _watchPlayers.t2.candIdx, st: _watchPlayers.t2.status.textContent })`);
  check('C2 看门狗·空响应：7 秒无流数据自动切下一候选（旧版永远卡死）',
    c2.idx === 1 && c2.st.indexOf('候选 2/2') >= 0, JSON.stringify(c2));
  await new Promise(r => setTimeout(r, 7500));   // 第二候选也失败 → 从头重试
  const c3 = await ex(`({ retries: _watchPlayers.t2.retries, idx: _watchPlayers.t2.candIdx, st: _watchPlayers.t2.status.textContent })`);
  check('C3 全候选失败 → 自动从头重试一轮（retries=1、candIdx 归零）',
    c3.retries === 1 && c3.idx === 0 && c3.st.indexOf('从头自动重试') >= 0, JSON.stringify(c3));
  await ex(`watchStop('t2'); delete _watchPlayers['t2']; 'ok';`);

  // ---------- D. 独立预览窗口看门狗 ----------
  const pv = new BrowserWindow({ width: 900, height: 640, show: false, webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true } });
  const pvUrl = 'file://' + path.join(ROOT, 'renderer/preview.html') +
    '?urls=' + encodeURIComponent(JSON.stringify(['http://127.0.0.1:' + PORT + '/pv.flv'])) +
    '&title=' + encodeURIComponent('E2E 空响应') +
    '&meta=' + encodeURIComponent(JSON.stringify({ push: '', plays: [], auth: {} }));
  await pv.loadURL(pvUrl);
  await new Promise(r => setTimeout(r, 9500));   // > 8s 看门狗
  const d1 = await pv.webContents.executeJavaScript(`({ tip: document.getElementById('tip').textContent, diag: document.getElementById('diag').textContent })`);
  check('D1 独立预览窗口：8 秒空响应自动提示并给出切换/中继指引',
    d1.tip.indexOf('空响应') >= 0 && d1.diag.indexOf('未收到流数据') >= 0,
    JSON.stringify({ tip: d1.tip.slice(0, 120), diagHit: d1.diag.indexOf('未收到流数据') >= 0 }));
  pv.destroy();

  // ---------- 汇总 ----------
  const pass = results.filter(r => r.pass).length;
  console.log('===== E2E r46: ' + pass + '/' + results.length + ' PASS =====');
  results.forEach(r => console.log((r.pass ? '✅' : '❌') + ' ' + r.name + (r.pass ? '' : '  → ' + r.extra)));
  app.exit(pass === results.length ? 0 : 1);
}

app.whenReady().then(main).catch(e => { console.error('FATAL', e); app.exit(2); });
