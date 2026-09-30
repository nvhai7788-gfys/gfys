// E2E v1.0.9：阿里云多播放域名串域修复
//   ① 云端确切播放域名（playHint）唯一使用——不混入其他播放域名候选
//   ② _alDomains 未加载时 playHint 仍生效（不退回主域猜测）
//   ③ 无 playHint 时保持同主域优先（回归）
//   ④ watchKey 带播放域名维度——两个播放域名的同名流不合并
// 复刻用户报告场景：csi44444 推流在 push.gfcnn.com，但正确播放域名是 pl.gfcnn.cn（跨主域映射）
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');

const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
const check = (name, ok, extra) => results.push({ name, pass: !!ok, extra: extra || '' });
const alCalls = [], previewCalls = [];

ipcMain.on('app:version-sync', (e) => { e.returnValue = '1.0.9-test'; });
ipcMain.on('util:md5-sync', (e, s) => { e.returnValue = crypto.createHash('md5').update(s).digest('hex'); });
ipcMain.on('util:sha256-sync', (e, s) => { e.returnValue = crypto.createHash('sha256').update(s).digest('hex'); });
ipcMain.handle('tc:call', async () => ({ ok: false, error: 'not-used' }));
ipcMain.handle('ac:call', async (_e, args) => {
  alCalls.push(args);
  const p = args.params || args.payload || {};
  if (args.action === 'DescribeLiveUserDomains') {
    return { ok: true, data: { Domains: { PageData: [
      { DomainName: 'push.gfcnn.com', LiveDomainType: 'liveEdge' },
      { DomainName: 'push.gfcnn.cn', LiveDomainType: 'liveEdge' },
      { DomainName: 'alyplay.gfcnn.com', LiveDomainType: 'liveVideo' },
      { DomainName: 'pl.gfcnn.cn', LiveDomainType: 'liveVideo' }
    ], TotalCount: 4 } } };
  }
  if (args.action === 'DescribeLiveStreamsOnlineList') {
    const dn = p.DomainName;
    if (dn === 'alyplay.gfcnn.com') {
      return { ok: true, data: { OnlineInfo: { LiveStreamOnlineInfo: [
        { StreamName: 'csi44444', AppName: 'live', DomainName: dn, PublishDomain: 'push.gfcnn.com',
          PublishUrl: 'rtmp://push.gfcnn.com/live/csi44444', PublishTime: '2026-09-27T07:00:00Z' }
      ] }, TotalNum: 1 } };
    }
    if (dn === 'pl.gfcnn.cn') {
      // 用户报告的流：推流域名是 push.gfcnn.com（com 主域），正确播放域名却是 pl.gfcnn.cn
      return { ok: true, data: { OnlineInfo: { LiveStreamOnlineInfo: [
        { StreamName: 'csi44444', AppName: 'live', DomainName: dn, PublishDomain: 'push.gfcnn.com',
          PublishUrl: 'rtmp://push.gfcnn.com/live/csi44444', PublishTime: '2026-09-27T07:02:00Z' }
      ] }, TotalNum: 1 } };
    }
    return { ok: true, data: { OnlineInfo: { LiveStreamOnlineInfo: [] }, TotalNum: 0 } };
  }
  if (args.action === 'DescribeLiveDomainConfigs') {
    const dn = p.DomainName;
    const key = dn === 'pl.gfcnn.cn' ? 'plkey123' : dn === 'alyplay.gfcnn.com' ? 'alykey999' : '';
    if (!key) return { ok: true, data: { DomainConfigs: { DomainConfig: [] } } };
    return { ok: true, data: { DomainConfigs: { DomainConfig: [
      { FunctionName: 'aliauth', FunctionArgs: { FunctionArg: [
        { ArgName: 'auth_type', ArgValue: 'type_a' },
        { ArgName: 'auth_key1', ArgValue: key },
        { ArgName: 'auth_key2', ArgValue: '' },
        { ArgName: 'ali_auth_delta', ArgValue: '1800' }
      ] } }
    ] } } };
  }
  return { ok: false, error: 'unmocked: ' + args.action };
});
ipcMain.handle('ff:list', async () => ({ ok: true, list: [] }));
ipcMain.handle('ff:devices', async () => ({ ok: true, devices: [] }));
ipcMain.handle('ff:pickFile', async () => ({ ok: true, path: '/tmp/test.mp4' }));
ipcMain.handle('ff:pickDir', async () => ({ ok: true, path: '/tmp/rectest' }));
ipcMain.handle('app:openPreview', async (_e, cands, title, meta) => {
  previewCalls.push({ cands, title, meta: JSON.parse(JSON.stringify(meta || {})) });
  return { ok: true };
});
ipcMain.handle('sched:list', () => ({ schedules: [], logs: [] }));
ipcMain.handle('sched:syncCreds', () => ({ ok: true }));

const hostOf = (u) => (String(u).split('/')[2] || '').toLowerCase();

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

  // ---------- A. playHint（云端确切播放域名）唯一使用 ----------
  // A1: _alDomains 已加载 + Key 已同步：候选全部 host == pl.gfcnn.cn，且用 pl 的 key 签名
  await ex(`alLoadDomains(true).then(function () { return fetchAlPlayKeys(['alyplay.gfcnn.com', 'pl.gfcnn.cn']); }).then(function () { window.__ready = 1; }); 'ok';`);
  for (let i = 0; i < 40 && !(await ex('window.__ready || 0')); i++) await new Promise(r => setTimeout(r, 200));
  const cands = await ex(`alPlayCandidates('csi44444', 'live', 'push.gfcnn.com', 'pl.gfcnn.cn')`);
  const hosts = Array.from(new Set(cands.map(hostOf)));
  check('A1 playHint=pl.gfcnn.cn 时候选只用该域名（无 alyplay 串域）',
    hosts.length === 1 && hosts[0] === 'pl.gfcnn.cn', JSON.stringify({ hosts, n: cands.length }));
  check('A2 候选 = pl Key 签名 4 条 + 裸地址兜底 4 条（Key 与域名配对）',
    cands.length === 8 &&
    cands.filter(u => /auth_key=\d+-0-0-[0-9a-f]{32}/.test(u)).length === 4 &&
    cands.filter(u => u.indexOf('auth_key=') < 0).length === 4, 'n=' + cands.length);
  // 校验签名确实用了 pl 的 key：type_a md5(uri-ts-0-0-key)，从候选 URL 反解
  const sigOk = await ex(`(function () {
    var u = alPlayCandidates('csi44444', 'live', 'push.gfcnn.com', 'pl.gfcnn.cn')[0];
    var m = u.match(/auth_key=(\\d+)-0-0-([0-9a-f]{32})/);
    if (!m) return { ok: false, u: u };
    var md5 = function (s) { return ''; };   // md5 由 node 侧对拍
    return { ok: true, uri: '/live/csi44444.flv', ts: m[1], sig: m[2], host: u.split('/')[2] };
  })()`);
  if (sigOk.ok) {
    const expect = crypto.createHash('md5').update(sigOk.uri + '-' + sigOk.ts + '-0-0-plkey123').digest('hex');
    check('A3 签名用 pl 域名 Key（md5(uri-ts-0-0-plkey123) 对拍一致）',
      expect === sigOk.sig && sigOk.host === 'pl.gfcnn.cn', 'sig=' + sigOk.sig.slice(0, 8) + '… expect=' + expect.slice(0, 8) + '…');
  } else {
    check('A3 签名用 pl 域名 Key', false, 'no auth_key in candidate: ' + String(sigOk.u).slice(0, 90));
  }

  // A4: _alDomains 未加载（清空）时 playHint 仍唯一生效
  const cands2 = await ex(`window._alDomains = []; alPlayCandidates('csi44444', 'live', 'push.gfcnn.com', 'pl.gfcnn.cn')`);
  const hosts2 = Array.from(new Set(cands2.map(hostOf)));
  check('A4 _alDomains 未加载时 playHint 仍生效（不退回主域猜测）',
    hosts2.length === 1 && hosts2[0] === 'pl.gfcnn.cn', JSON.stringify(hosts2));

  // A5: 无 playHint 时旧行为回归：push.gfcnn.com → 同主域 alyplay.gfcnn.com 第一
  const cands3 = await ex(`alLoadDomains(true).then(function () { return alPlayCandidates('alStr1', 'live', 'push.gfcnn.com', ''); });`);
  const firstHost3 = hostOf(cands3[0] || '');
  check('A5 无 playHint：同主域播放域名仍排第一（回归）',
    firstHost3 === 'alyplay.gfcnn.com', 'first=' + firstHost3);

  // ---------- B. 在线流列表：每条流带确切播放域名 ----------
  await ex(`refreshMonitor(false); 'ok';`);
  await new Promise(r => setTimeout(r, 1200));
  const rows = await ex(`(window._monList || []).filter(function (s) { return s.StreamName === 'csi44444'; })
    .map(function (s) { return { dn: s.DomainName, pd: s.PublishDomain, app: s.AppName }; })`);
  check('B1 两个播放域名的 csi44444 各自带确切 DomainName（pl + alyplay，不串）',
    rows.length === 2 && rows.some(r => r.dn === 'pl.gfcnn.cn') && rows.some(r => r.dn === 'alyplay.gfcnn.com') &&
    rows.every(r => r.pd === 'push.gfcnn.com'), JSON.stringify(rows));
  const btnPlay = await ex(`Array.prototype.map.call(document.querySelectorAll('#monBody [data-act="preview"]'), function (b) { return b.dataset.play; })`);
  check('B2 预览按钮携带各自播放域名（data-play）',
    btnPlay.indexOf('pl.gfcnn.cn') >= 0 && btnPlay.indexOf('alyplay.gfcnn.com') >= 0, JSON.stringify(btnPlay));

  // ---------- C. 预览观看：同名流按播放域名分卡 ----------
  previewCalls.length = 0;
  await ex(`renderWatch(); 'ok';`);
  await new Promise(r => setTimeout(r, 800));
  const cards = await ex(`Object.keys(_watchPlayers).filter(function (k) { return k.indexOf('csi44444') >= 0; })`);
  check('C1 两个播放域名的同名流生成两张观看卡（watchKey 带域名）',
    cards.length === 2 && cards.some(k => k.indexOf('pl.gfcnn.cn') >= 0) && cards.some(k => k.indexOf('alyplay.gfcnn.com') >= 0),
    JSON.stringify(cards));
  // 手动触发两张卡的弹窗，确认候选域名各自正确
  previewCalls.length = 0;
  const popHosts = await ex(`(function () {
    var hosts = [];
    Object.keys(_watchPlayers).forEach(function (k) {
      if (k.indexOf('csi44444') < 0) return;
      var st = _watchPlayers[k];
      var dom = k.indexOf('pl.gfcnn.cn') >= 0 ? 'pl.gfcnn.cn' : 'alyplay.gfcnn.com';
      openStreamPreview(st.s.StreamName, st.s.AppName || 'live', st.s.PublishDomain || '', 'aliyun', dom);
      hosts.push(dom);
    });
    return hosts;
  })()`);
  await new Promise(r => setTimeout(r, 1500));
  check('C2 两张卡弹窗候选各自域名唯一（pl 卡只有 pl，alyplay 卡只有 alyplay）',
    previewCalls.length === 2 &&
    previewCalls.every(p => new Set(p.cands.map(hostOf)).size === 1) &&
    previewCalls.some(p => hostOf(p.cands[0]) === 'pl.gfcnn.cn') &&
    previewCalls.some(p => hostOf(p.cands[0]) === 'alyplay.gfcnn.com'),
    JSON.stringify(previewCalls.map(p => ({ host: hostOf(p.cands[0]), n: p.cands.length }))));

  // ---------- 汇总 ----------
  const pass = results.filter(r => r.pass).length;
  console.log('===== E2E v1.0.9 结果: ' + pass + '/' + results.length + ' PASS =====');
  results.forEach(r => console.log((r.pass ? '✅' : '❌') + ' ' + r.name + (r.pass ? '' : '  → ' + r.extra)));
  app.exit(pass === results.length ? 0 : 1);
}
app.whenReady().then(main).catch(e => { console.error('FATAL', e); app.exit(2); });
