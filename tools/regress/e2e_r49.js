// E2E r49（v1.1.6）：
// ①ECS 动态地域扫描：DescribeRegions 拉账号全部可用地域（含硬编码漏掉的广州），金融云地域过滤，失败回退下拉列表
// ②探测门控修复：2 条候选（=2 域名）也触发实测排序（v1.1.4 的 > 2 门控让实测永远跳过）
// ③push 级记忆移除后的候选排序（流级优先，push 级不污染）——r47 已同步更新，此处补充看门狗写入口径
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
const check = (name, ok, extra) => results.push({ name, pass: !!ok, extra: extra || '' });

let dataSrv, emptySrv, DATA_PORT, EMPTY_PORT;
let acHosts = [];

ipcMain.on('app:version-sync', (e) => { e.returnValue = '1.1.6-test'; });
ipcMain.on('util:md5-sync', (e, s) => { e.returnValue = crypto.createHash('md5').update(s).digest('hex'); });
ipcMain.on('util:sha256-sync', (e, s) => { e.returnValue = crypto.createHash('sha256').update(s).digest('hex'); });
ipcMain.handle('tc:call', async () => ({ ok: false, error: 'unmocked tc' }));

ipcMain.handle('ac:call', async (_e, args) => {
  const p = (args && (args.params || args.payload)) || {};
  acHosts.push(args.action + '@' + (args.host || ''));
  if (args.action === 'DescribeRegions') {
    return { ok: true, data: { Regions: { Region: [
      { RegionId: 'cn-hangzhou' }, { RegionId: 'cn-guangzhou' }, { RegionId: 'cn-beijing' },
      { RegionId: 'cn-hangzhou-finance' }   // 金融云地域：应被过滤不扫描
    ] } } };
  }
  if (args.action === 'DescribeLiveUserDomains') {
    return { ok: true, data: { Domains: { PageData: [
      { DomainName: 'push.gfcnn.com', LiveDomainType: 'liveEdge', LiveDomainStatus: 'online' },
      { DomainName: 'alyplay.gfcnn.com', LiveDomainType: 'liveVideo', LiveDomainStatus: 'online' },
      { DomainName: 'pl.gfcnn.cn', LiveDomainType: 'liveVideo', LiveDomainStatus: 'online' }
    ], TotalCount: 3 } } };
  }
  if (args.action === 'DescribeLiveDomainConfigs') return { ok: true, data: { DomainConfigs: { DomainConfig: [] } } };
  if (args.action === 'DescribeInstances') {
    if (p.RegionId === 'cn-beijing') return { ok: false, error: '[Forbidden] RAM 无 ECS 权限 (403)' };
    if (p.RegionId === 'cn-guangzhou') return { ok: true, data: { Instances: { Instance: [
      { InstanceId: 'i-gz-001', InstanceName: '广州推流机', Status: 'Running', PublicIpAddress: { IpAddress: ['5.6.7.8'] }, InnerIpAddress: { IpAddress: ['10.0.2.1'] } }
    ] } } };
    if (p.RegionId === 'cn-hangzhou') return { ok: true, data: { Instances: { Instance: [
      { InstanceId: 'i-hz-001', InstanceName: '杭州录制机', Status: 'Running', PublicIpAddress: { IpAddress: ['1.2.3.4'] }, InnerIpAddress: { IpAddress: ['10.0.0.1'] } }
    ] } } };
    return { ok: true, data: { Instances: { Instance: [] } } };
  }
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

  await ex("state.cfg = { secretId: 'x', secretKey: 'y', region: 'ap-guangzhou', domainAuth: {}, domainKeys: {}, aliId: 'a', aliKey: 'b', alDomainAuth: {}, alDomainKeys: {}, users: [], genHistory: [] }; state.connected = true; 'ok';");
  await ex("window._ovDomains = []; window._alDomains = []; window._monList = undefined; window._taskList = []; 'ok';");
  await ex("enterApp(false); 'ok';");

  // ---------- A. ECS 动态地域扫描（r62 起双云同页，无页签；ECS 表格为 srvBodyAl） ----------
  acHosts = [];
  await ex(`$('srvQueryBtn').click(); 'ok';`);
  await new Promise(r => setTimeout(r, 3000));
  const a1 = await ex(`$('srvBodyAl').textContent`);
  const gzHost = acHosts.filter(h => h.indexOf('DescribeInstances@ecs.cn-guangzhou.aliyuncs.com') >= 0);
  check('A1 先 DescribeRegions 动态取地域并按地域 endpoint 扫描（含广州 ecs.cn-guangzhou）',
    acHosts.some(h => h.indexOf('DescribeRegions@ecs.aliyuncs.com') >= 0) && gzHost.length > 0,
    JSON.stringify({ hosts: acHosts.slice(0, 8) }));
  check('A2 广州实例被发现（i-gz-001）+ 杭州实例（i-hz-001）双实例合并展示',
    a1.indexOf('i-gz-001') >= 0 && a1.indexOf('i-hz-001') >= 0,
    a1.slice(0, 200));
  const finHosts = acHosts.filter(h => h.indexOf('-finance') >= 0);
  check('A3 金融云地域被过滤不扫描', finHosts.length === 0, JSON.stringify(finHosts));

  // ---------- B. 探测门控修复：恰好 2 条候选也实测 ----------
  const b1 = await ex(`new Promise(function (res) {
    // 拦截异步候选获取，注入 2 条候选（空响应域名在前、有流数据域名在后）——v1.1.4 中 2 条候选不触发实测
    alPlayCandidatesAsync = function (stream, app, pushDomain, hints, cb) {
      cb(['http://127.0.0.1:${EMPTY_PORT}/b1.flv', 'http://127.0.0.1:${DATA_PORT}/b2.flv']);
    };
    var v = document.createElement('video');
    _watchPlayers['k1'] = { live: true,
      s: { _prov: 'aliyun', StreamName: 'csi44444', AppName: 'liveApp', PublishDomain: 'push.gfcnn.com' },
      video: v, status: document.createElement('div'), cands: [], candIdx: 0, retries: 0, player: null };
    watchStartPlay('k1');
    setTimeout(function () {
      var st = _watchPlayers['k1'];
      res({ first: st && st.cands[0] ? (st.cands[0].split('/')[2] || '') : '', n: st ? st.cands.length : 0 });
    }, 6500);
  })`);
  check('B1 恰好 2 条候选也实测排序：有流数据域名排到第一（旧版 > 2 门控直接跳过实测）',
    b1.n === 2 && b1.first === '127.0.0.1:' + DATA_PORT, JSON.stringify(b1));
  await ex(`watchStop('k1'); delete _watchPlayers['k1']; 'ok';`);

  // ---------- C. 看门狗成功只写流级 ----------
  await ex(`(function () {
    state.cfg.alPlayDomOk = {};
    var v = document.createElement('video');
    Object.defineProperty(v, 'buffered', { get: function () { return { length: 1 }; } });
    _watchPlayers['t1'] = { live: true,
      s: { _prov: 'aliyun', StreamName: 'csi33333', AppName: 'liveApp', PublishDomain: 'push.gfcnn.com' },
      video: v, status: document.createElement('div'), cands: ['http://127.0.0.1:${DATA_PORT}/ok.flv'], candIdx: 0, retries: 0, player: null };
    watchPlayCand('t1');
    return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 2500));
  const c1 = await ex(`(function () {
    var m = state.cfg.alPlayDomOk || {};
    var r = { stream: m['liveApp|csi33333'], push: m['push|push.gfcnn.com'] };
    watchStop('t1'); delete _watchPlayers['t1'];
    return r;
  })()`);
  check('C2 看门狗成功只记流级域名（push 级不再被写入，防同推流域名其他流被污染）',
    c1.stream === '127.0.0.1:' + DATA_PORT && !c1.push, JSON.stringify(c1));

  // ---------- 汇总 ----------
  const pass = results.filter(r => r.pass).length;
  console.log('===== E2E r49: ' + pass + '/' + results.length + ' PASS =====');
  results.forEach(r => console.log((r.pass ? '✅' : '❌') + ' ' + r.name + (r.pass ? '' : '  → ' + r.extra)));
  app.exit(pass === results.length ? 0 : 1);
}
app.whenReady().then(main).catch(e => { console.error('FATAL', e); app.exit(2); });
