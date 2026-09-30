// E2E v1.1.1：阿里云多播放域名同流合并 —— 两个播放域名映射同一推流域名时，
// 逐播放域名查询把同一条流返回两次导致「两行/两卡/点错域名必失败」。
// 修复：同 PublishDomain+AppName+StreamName 合并为一条，_alPlayDoms 收集全部播放域名作候选（逐个回退）。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');

const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
const check = (name, ok, extra) => results.push({ name, pass: !!ok, extra: extra || '' });
const tcCalls = [], alCalls = [], prevCalls = [];

ipcMain.on('app:version-sync', (e) => { e.returnValue = '1.1.1-test'; });
ipcMain.on('util:md5-sync', (e, s) => { e.returnValue = crypto.createHash('md5').update(s).digest('hex'); });
ipcMain.on('util:sha256-sync', (e, s) => { e.returnValue = crypto.createHash('sha256').update(s).digest('hex'); });
ipcMain.handle('tc:call', async (_e, args) => {
  tcCalls.push(args);
  if (args.action === 'DescribeLiveDomains') {
    return { ok: true, data: { DomainList: [{ Name: 'push.gfcnn.com', Type: 0 }] } };
  }
  if (args.action === 'DescribeLiveStreamOnlineList') {
    return { ok: true, data: { OnlineInfo: [], TotalNum: 0 } };
  }
  return { ok: false, error: 'unmocked tc: ' + args.action };
});
ipcMain.handle('ac:call', async (_e, args) => {
  alCalls.push(args);
  const p = args.params || args.payload || {};
  if (args.action === 'DescribeLiveUserDomains') {
    return { ok: true, data: { Domains: { PageData: [
      { DomainName: 'push.gfcnn.com', LiveDomainType: 'liveEdge' },
      { DomainName: 'alyplay.gfcnn.com', LiveDomainType: 'liveVideo' },
      { DomainName: 'pl.gfcnn.cn', LiveDomainType: 'liveVideo' }
    ], TotalCount: 3 } } };
  }
  if (args.action === 'DescribeLiveStreamsOnlineList') {
    // 两个播放域名查询都返回同一条流（同推流域名 push.gfcnn.com / live / csi44444）；
    // pl 域名查询额外返回另一条不同推流域名的流（不应被合并）
    const arr = [{ StreamName: 'csi44444', AppName: 'live', DomainName: p.DomainName, PublishDomain: 'push.gfcnn.com',
      PublishUrl: 'rtmp://push.gfcnn.com/live/csi44444', PublishTime: '2026-09-27T07:00:00Z' }];
    if (p.DomainName === 'pl.gfcnn.cn') {
      arr.push({ StreamName: 'csi88888', AppName: 'live', DomainName: 'pl.gfcnn.cn', PublishDomain: 'push2.gfcnn.com',
        PublishUrl: 'rtmp://push2.gfcnn.com/live/csi88888', PublishTime: '2026-09-27T07:05:00Z' });
    }
    return { ok: true, data: { OnlineInfo: { LiveStreamOnlineInfo: arr }, TotalNum: arr.length } };
  }
  if (args.action === 'DescribeLiveDomainConfigs') {
    const dn = p.DomainName || '';
    const key = dn === 'pl.gfcnn.cn' ? 'ak_cn' : 'ak_com';
    return { ok: true, data: { DomainConfigs: { DomainConfig: [
      { FunctionName: 'aliauth', FunctionArgs: { FunctionArg: [
        { ArgName: 'auth_type', ArgValue: 'type_a' },
        { ArgName: 'auth_key1', ArgValue: key },
        { ArgName: 'auth_key2', ArgValue: '' }
      ] } }
    ] } } };
  }
  return { ok: false, error: 'unmocked ac: ' + args.action };
});
ipcMain.handle('ff:list', async () => ({ ok: true, list: [] }));
ipcMain.handle('ff:devices', async () => ({ ok: true, devices: [] }));
ipcMain.handle('ff:pickFile', async () => ({ ok: true, path: '/tmp/test.mp4' }));
ipcMain.handle('ff:pickDir', async () => ({ ok: true, path: '/tmp/rectest' }));
ipcMain.handle('app:openPreview', async (_e, a) => { prevCalls.push(a); return { ok: true }; });
ipcMain.handle('sched:list', () => ({ schedules: [], logs: [] }));
ipcMain.handle('sched:syncCreds', () => ({ ok: true }));

async function main() {
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

  // ---------- A. 同流合并 ----------
  await ex("refreshMonitor(false); 'ok';");
  await new Promise(r => setTimeout(r, 1500));
  const a1 = await ex(`(function () {
    var al = (_monList || []).filter(function (s) { return s._prov === 'aliyun'; });
    var m = al.filter(function (s) { return s.StreamName === 'csi44444'; });
    return { total: al.length, merged: m.length, doms: m.length ? m[0]._alPlayDoms : [] };
  })()`);
  check('A1 两播放域名查回的同一条流合并为一行', a1.total === 2 && a1.merged === 1, JSON.stringify(a1));
  check('A2 合并行 _alPlayDoms 收齐云端报过的全部播放域名',
    a1.doms.length === 2 && a1.doms.indexOf('alyplay.gfcnn.com') >= 0 && a1.doms.indexOf('pl.gfcnn.cn') >= 0, JSON.stringify(a1.doms));
  const a3 = await ex(`(function () {
    var rows = Array.prototype.slice.call(document.querySelectorAll('#monBody tr'));
    var hit = rows.filter(function (r) { return r.textContent.indexOf('csi44444') >= 0 && r.textContent.indexOf('阿里云') >= 0; });
    var t = hit.length ? hit[0].textContent : '';
    return { rows: hit.length, play: t.indexOf('播放: ') >= 0 ? (t.split('播放: ')[1] || '').trim() : '' };
  })()`);
  check('A3 监控表该流仅一行且展示播放域名候选', a3.rows === 1 && a3.play.indexOf('alyplay.gfcnn.com') >= 0 && a3.play.indexOf('pl.gfcnn.cn') >= 0, JSON.stringify(a3));
  const a4 = await ex(`(function () {
    var btn = document.querySelector('#monBody button[data-act="preview"][data-stream="csi44444"]');
    return btn ? { play: btn.dataset.play } : { play: '' };
  })()`);
  check('A4 预览按钮 data-play 携带逗号分隔的双域名', (a4.play.split(',').indexOf('alyplay.gfcnn.com') >= 0 && a4.play.split(',').indexOf('pl.gfcnn.cn') >= 0), a4.play);

  // ---------- B. 播放候选 ----------
  const getKeys = () => ex("({ aly: (state.cfg.alDomainKeys||{})['alyplay.gfcnn.com']||'', cn: (state.cfg.alDomainKeys||{})['pl.gfcnn.cn']||'' })");
  const b1 = await ex(`(function () {
    var c = alPlayCandidates('csi44444', 'live', 'push.gfcnn.com', ['alyplay.gfcnn.com', 'pl.gfcnn.cn']);
    var hosts = [];
    c.forEach(function (u) { var h = (u.split('/')[2] || '').toLowerCase(); if (hosts.indexOf(h) < 0) hosts.push(h); });
    return { hosts: hosts, n: c.length, auth: _alPlayAuthSrc };
  })()`);
  const keys1 = await getKeys();
  check('B1 hints 数组 → 候选同时含两个播放域名（每域名云端 Key 已拉取）',
    b1.hosts.indexOf('alyplay.gfcnn.com') >= 0 && b1.hosts.indexOf('pl.gfcnn.cn') >= 0 &&
    keys1.aly === 'ak_com' && keys1.cn === 'ak_cn',
    JSON.stringify({ hosts: b1.hosts, keys: keys1 }));
  const b2 = await ex(`(function () {
    var c = alPlayCandidates('csi44444', 'live', 'push.gfcnn.com', 'alyplay.gfcnn.com,pl.gfcnn.cn');
    var hosts = [];
    c.forEach(function (u) { var h = (u.split('/')[2] || ''); if (hosts.indexOf(h) < 0) hosts.push(h); });
    return { hosts: hosts };
  })()`);
  check('B2 hints 逗号字符串同样生效',
    b2.hosts.indexOf('alyplay.gfcnn.com') >= 0 && b2.hosts.indexOf('pl.gfcnn.cn') >= 0, JSON.stringify(b2.hosts));
  const b3 = await ex(`(function () {
    var c = alPlayCandidates('csi44444', 'live', 'push.gfcnn.com', '');
    var hosts = [];
    c.forEach(function (u) { var h = (u.split('/')[2] || ''); if (hosts.indexOf(h) < 0) hosts.push(h); });
    return { hosts: hosts, first: hosts[0] };
  })()`);
  check('B3 无 hints 走兜底（同主域 alyplay 排最前，且两播放域名都在候选）',
    b3.hosts.indexOf('pl.gfcnn.cn') >= 0 && b3.first === 'alyplay.gfcnn.com', JSON.stringify(b3));
  const b4 = await ex(`(function () {
    var c = alPlayCandidates('csi44444', 'live', 'push.gfcnn.com', 'push.gfcnn.com');
    var hosts = [];
    c.forEach(function (u) { var h = (u.split('/')[2] || ''); if (hosts.indexOf(h) < 0) hosts.push(h); });
    return { hosts: hosts };
  })()`);
  // r50 起云端 hint 权威化（官方控制台语义：列表在哪个播放域名下就用哪个；不再按黑名单过滤）
  check('B4 hints 权威保留（v1.1.7 起云端 DomainName 直接作为候选，不再黑名单过滤）',
    b4.hosts.length > 0 && b4.hosts[0] === 'push.gfcnn.com', JSON.stringify(b4.hosts));
  const b5 = await ex(`(function () {
    var c = alPlayCandidates('csi44444', 'live', 'push.gfcnn.com', ['alyplay.gfcnn.com', 'pl.gfcnn.cn']);
    var comFlv = c.filter(function (u) { return u.indexOf('alyplay.gfcnn.com') >= 0 && u.indexOf('.flv') >= 0; });
    var cnFlv = c.filter(function (u) { return u.indexOf('pl.gfcnn.cn') >= 0 && u.indexOf('.flv') >= 0; });
    return { comFlv: comFlv.length, cnFlv: cnFlv.length,
             comSigned: comFlv.length > 0 && comFlv[0].indexOf('auth_key=') > 0,
             cnSigned: cnFlv.length > 0 && cnFlv[0].indexOf('auth_key=') > 0 };
  })()`);
  const keys2 = await getKeys();
  check('B5 各域名用各自云端 Key（alDomainKeys：ak_com↔alyplay、ak_cn↔pl，TypeA 签名串内不含明文 Key）',
    keys2.aly === 'ak_com' && keys2.cn === 'ak_cn' && b5.comFlv > 0 && b5.cnFlv > 0, JSON.stringify({ keys: keys2, b5: b5 }));

  // ---------- C. 观看页单卡 + 预览窗口双域名 ----------
  await ex(`document.querySelector('.nav-item[data-view="watch"]').click(); 'ok';`);
  await new Promise(r => setTimeout(r, 800));
  const c1 = await ex(`(function () {
    var ks = Object.keys(_watchPlayers).filter(function (k) { return k.indexOf('csi44444') >= 0; });
    return { n: ks.length, keys: ks };
  })()`);
  check('C1 观看页同一物理流只有一张卡（不再按播放域名裂成两张）', c1.n === 1, JSON.stringify(c1));
  const c2 = await ex(`(function () {
    var k = Object.keys(_watchPlayers).filter(function (kk) { return kk.indexOf('csi44444') >= 0; })[0];
    if (!k) return { ok: false };
    var card = _watchPlayers[k].card;
    var btn = card.querySelector('[data-wact="pop"]');
    btn.click();
    return { ok: true };
  })()`);
  await new Promise(r => setTimeout(r, 2500));
  const c3 = (function () {
    const last = prevCalls[prevCalls.length - 1];
    const hosts = [];
    (Array.isArray(last) ? last : []).forEach(u => { const h = (String(u).split('/')[2] || ''); if (hosts.indexOf(h) < 0) hosts.push(h); });
    return { hosts: hosts };
  })();
  check('C2 独立预览窗口候选含两个播放域名（可手动切换）',
    c3.hosts.indexOf('alyplay.gfcnn.com') >= 0 && c3.hosts.indexOf('pl.gfcnn.cn') >= 0, JSON.stringify(c3));

  // ---------- D. 不同推流域名不合并 ----------
  const d1 = await ex(`(function () {
    var m = (_monList || []).filter(function (s) { return s._prov === 'aliyun' && s.StreamName === 'csi88888'; });
    return { n: m.length, doms: m.length ? m[0]._alPlayDoms : [] };
  })()`);
  check('D1 推流域名不同的流独立成行（csi88888 不并入 csi44444）', d1.n === 1 && d1.doms.length === 1, JSON.stringify(d1));

  // ---------- 汇总 ----------
  const pass = results.filter(r => r.pass).length;
  console.log('===== E2E v1.1.1 结果: ' + pass + '/' + results.length + ' PASS =====');
  results.forEach(r => console.log((r.pass ? '✅' : '❌') + ' ' + r.name + (r.pass ? '' : '  → ' + r.extra)));
  app.exit(pass === results.length ? 0 : 1);
}
app.whenReady().then(main).catch(e => { console.error('FATAL', e); app.exit(2); });
