// E2E v1.1.4：
// ①云服务器·阿里云 ECS：地域专属 endpoint（ecs-cn-hangzhou / ecs.<region>）+ 扫描模式真实报错透出
// ②在线流播放前域名实测排序（probeCandHosts：有流数据的域名排最前，200 空响应域名排后）
// ③自学习升级：推流域名级记忆（push|pushDomain）优先于流级
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
const check = (name, ok, extra) => results.push({ name, pass: !!ok, extra: extra || '' });

let dataSrv, emptySrv, DATA_PORT, EMPTY_PORT;
let acHosts = [];      // 记录每次 ac:call 的 host
let ecsAllFail = false;

ipcMain.on('app:version-sync', (e) => { e.returnValue = '1.1.4-test'; });
ipcMain.on('util:md5-sync', (e, s) => { e.returnValue = crypto.createHash('md5').update(s).digest('hex'); });
ipcMain.on('util:sha256-sync', (e, s) => { e.returnValue = crypto.createHash('sha256').update(s).digest('hex'); });
ipcMain.handle('tc:call', async () => ({ ok: false, error: 'unmocked tc' }));

ipcMain.handle('ac:call', async (_e, args) => {
  const p = (args && (args.params || args.payload)) || {};
  acHosts.push(args.action + '@' + (args.host || ''));
  if (args.action === 'DescribeLiveUserDomains') {
    return { ok: true, data: { Domains: { PageData: [
      { DomainName: 'push.gfcnn.com', LiveDomainType: 'liveEdge', LiveDomainStatus: 'online' },
      { DomainName: 'alyplay.gfcnn.com', LiveDomainType: 'liveVideo', LiveDomainStatus: 'online' },
      { DomainName: 'pl.gfcnn.cn', LiveDomainType: 'liveVideo', LiveDomainStatus: 'online' }
    ], TotalCount: 3 } } };
  }
  if (args.action === 'DescribeLiveDomainConfigs') return { ok: true, data: { DomainConfigs: { DomainConfig: [] } } };
  if (args.action === 'DescribeInstances') {
    if (ecsAllFail) return { ok: false, error: '[Forbidden] The user must be authorized to operate on the specified resource (403)' };
    if (p.RegionId === 'cn-hangzhou') return { ok: true, data: { Instances: { Instance: [
      { InstanceId: 'i-hz-001', InstanceName: '推流服务器', Status: 'Running', PublicIpAddress: { IpAddress: ['1.2.3.4'] }, InnerIpAddress: { IpAddress: ['10.0.0.1'] } }
    ] } } };
    if (p.RegionId === 'cn-beijing') return { ok: false, error: '[Forbidden] RAM 无 ECS 权限' };
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
  await new Promise(r => { dataSrv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'video/x-flv' }); res.write('FLVhead01'); /* 保持连接 */ }); dataSrv.listen(0, '127.0.0.1', r); });
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
  await ex(`state.cfg.alDomainAuth = {
    'alyplay.gfcnn.com': { on: true, type: 'type_a', main: 'key_aly' },
    'pl.gfcnn.cn': { on: true, type: 'type_a', main: 'key_pl' }
  }; 'ok';`);

  // ---------- A. 云服务器·阿里云 ECS（r62 起双云同页，无页签；ECS 表格为 srvBodyAl） ----------
  await ex(`$('srvQueryBtn').click(); 'ok';`);
  await new Promise(r => setTimeout(r, 2500));
  const a1 = await ex(`({ rows: $('srvBodyAl').textContent, hosts: [] })`);
  const hz = acHosts.filter(h => h.indexOf('cn-hangzhou') >= 0);
  const bj = acHosts.filter(h => h.indexOf('cn-beijing') >= 0);
  check('A1 ECS 查询改用地域专属 endpoint（杭州 ecs-cn-hangzhou / 北京 ecs.cn-beijing）',
    hz.some(h => h.indexOf('ecs-cn-hangzhou.aliyuncs.com') >= 0) &&
    bj.some(h => h.indexOf('ecs.cn-beijing.aliyuncs.com') >= 0), JSON.stringify({ hz: hz[0], bj: bj[0] }));
  check('A1b 杭州 403 地域之外实例正常列出（i-hz-001 出现）',
    a1.rows.indexOf('i-hz-001') >= 0, a1.rows.slice(0, 150));

  // 全地域失败 → 真实报错透出
  ecsAllFail = true;
  acHosts = [];
  await ex(`$('srvQueryBtn').click(); 'ok';`);
  await new Promise(r => setTimeout(r, 2500));
  const a2 = await ex(`$('srvBodyAl').textContent`);
  check('A2 扫描模式不再吞错：无实例时显示真实 403 报错',
    a2.indexOf('Forbidden') >= 0, a2.slice(0, 200));
  ecsAllFail = false;

  // ---------- B. 播放前域名实测排序 ----------
  const b1 = await ex(`new Promise(function (res) {
    var cands = ['http://127.0.0.1:${EMPTY_PORT}/b1.flv', 'http://127.0.0.1:${DATA_PORT}/b2.flv', 'http://127.0.0.1:${EMPTY_PORT}/b3.flv', 'http://127.0.0.1:${DATA_PORT}/b4.flv'];
    probeCandHosts(cands, function (ordered) {
      res(ordered.map(function (u) { return (u.split('/')[2] || ''); }));
    });
  })`);
  check('B1 域名实测：有流数据的域名候选整体排最前、空响应域名排后',
    b1.slice(0, 2).every(h => h === '127.0.0.1:' + DATA_PORT) &&
    b1.slice(2).every(h => h === '127.0.0.1:' + EMPTY_PORT), JSON.stringify(b1));
  const b2 = await ex(`new Promise(function (res) {
    var cands = ['http://127.0.0.1:${EMPTY_PORT}/c1.flv', 'http://127.0.0.1:${EMPTY_PORT}/c2.flv'];
    probeCandHosts(cands, function (ordered) { res(ordered.length); });   // 单域名跳过探测
  })`);
  check('B2 单域名无需探测（直接返回原候选）', b2 === 2, String(b2));

  // ---------- C. 自学习：只用流级（v1.1.6 行为变更：push 级记忆会串流污染，已移除） ----------
  const c1 = await ex(`(function () {
    state.cfg.alPlayDomOk = { 'push|push.gfcnn.com': 'pl.gfcnn.cn' };
    var c = alPlayCandidates('x99999', 'liveApp', 'push.gfcnn.com', ['alyplay.gfcnn.com', 'pl.gfcnn.cn']);
    var f1 = c[0].split('/')[2] || '';
    state.cfg.alPlayDomOk = { 'push|push.gfcnn.com': 'pl.gfcnn.cn', 'liveApp|x99999': 'alyplay.gfcnn.com' };
    var c2 = alPlayCandidates('x99999', 'liveApp', 'push.gfcnn.com', ['alyplay.gfcnn.com', 'pl.gfcnn.cn']);
    return { pushOnly: f1, withStream: (c2[0].split('/')[2] || '') };
  })()`);
  check('C1 只用流级记忆：push 级残留不再影响排序；流级存在时流级优先',
    c1.pushOnly === 'alyplay.gfcnn.com' && c1.withStream === 'alyplay.gfcnn.com', JSON.stringify(c1));
  // 看门狗成功 → 只记录流级
  await ex(`(function () {
    state.cfg.alPlayDomOk = {};
    var v = document.createElement('video');
    Object.defineProperty(v, 'buffered', { get: function () { return { length: 1 }; } });
    _watchPlayers['t9'] = { live: true,
      s: { _prov: 'aliyun', StreamName: 'csiwd9', AppName: 'liveApp', PublishDomain: 'push.gfcnn.com' },
      video: v, status: document.createElement('div'), cands: ['http://127.0.0.1:${DATA_PORT}/ok.flv'], candIdx: 0, retries: 0, player: null };
    watchPlayCand('t9');
    return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 2500));
  const c2 = await ex(`({ push: (state.cfg.alPlayDomOk || {})['push|push.gfcnn.com'], stream: (state.cfg.alPlayDomOk || {})['liveApp|csiwd9'] })`);
  check('C2 看门狗成功 → 只记流级（不再写 push 级，防串流污染）',
    c2.stream === '127.0.0.1:' + DATA_PORT && !c2.push, JSON.stringify(c2));
  await ex(`watchStop('t9'); delete _watchPlayers['t9']; state.cfg.alPlayDomOk = {}; 'ok';`);

  // ---------- D. 独立预览窗口：起播前实测排序 ----------
  const pv = new BrowserWindow({ width: 900, height: 640, show: false, webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true } });
  const pvUrl = 'file://' + path.join(ROOT, 'renderer/preview.html') +
    '?urls=' + encodeURIComponent(JSON.stringify([
      'http://127.0.0.1:' + EMPTY_PORT + '/p1.flv',
      'http://127.0.0.1:' + DATA_PORT + '/p2.flv',
      'http://127.0.0.1:' + EMPTY_PORT + '/p3.flv',
      'http://127.0.0.1:' + DATA_PORT + '/p4.flv'
    ])) +
    '&title=' + encodeURIComponent('E2E 实测') +
    '&meta=' + encodeURIComponent(JSON.stringify({ push: '', plays: [], auth: {} }));
  await pv.loadURL(pvUrl);
  await new Promise(r => setTimeout(r, 5000));   // 探测最多 3.5s，在 8s 看门狗前断言
  const d1 = await pv.webContents.executeJavaScript(`document.getElementById('urlbox').textContent`);
  check('D1 预览窗口起播前实测：优先播放有流数据的域名',
    (d1.split('/')[2] || '') === '127.0.0.1:' + DATA_PORT, d1);
  pv.destroy();

  // ---------- 汇总 ----------
  const pass = results.filter(r => r.pass).length;
  console.log('===== E2E r47: ' + pass + '/' + results.length + ' PASS =====');
  results.forEach(r => console.log((r.pass ? '✅' : '❌') + ' ' + r.name + (r.pass ? '' : '  → ' + r.extra)));
  app.exit(pass === results.length ? 0 : 1);
}

app.whenReady().then(main).catch(e => { console.error('FATAL', e); app.exit(2); });
