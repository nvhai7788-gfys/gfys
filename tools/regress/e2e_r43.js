// E2E v1.1.0：①流质量图表数据可见（qCardKey 带域名防 id 冲突 + 样本累积 + echarts 渲染）
// ②单流详细检测多流勾选（每条在线流可单独选择，逐流独立结果卡）③总览可视化（饼图+趋势）
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');

const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
const check = (name, ok, extra) => results.push({ name, pass: !!ok, extra: extra || '' });
const tcCalls = [], alCalls = [];

ipcMain.on('app:version-sync', (e) => { e.returnValue = '1.1.0-test'; });
ipcMain.on('util:md5-sync', (e, s) => { e.returnValue = crypto.createHash('md5').update(s).digest('hex'); });
ipcMain.on('util:sha256-sync', (e, s) => { e.returnValue = crypto.createHash('sha256').update(s).digest('hex'); });
ipcMain.handle('tc:call', async (_e, args) => {
  tcCalls.push(args);
  if (args.action === 'DescribeLiveDomains') {
    return { ok: true, data: { DomainList: [
      { Name: 'push.gfcnn.com', Type: 0 },
      { Name: 'push.gfcnn.cn', Type: 0 },
      { Name: 'play.gfcnn.com', Type: 1 },
      { Name: 'pl.gfcnn.cn', Type: 1 }
    ] } };
  }
  if (args.action === 'DescribeLiveStreamOnlineList') {
    const dn = args.payload && args.payload.DomainName;
    const sn = dn && dn.indexOf('.com') > 0 ? 'comTStr' : 'cnTStr';
    return { ok: true, data: { OnlineInfo: [
      { StreamName: sn, AppName: 'pushapp', DomainName: dn || 'push.gfcnn.com', PublishTimeList: [{ PublishTime: '2026-09-27T07:00:00Z' }] }
    ], TotalNum: 1 } };
  }
  if (args.action === 'DescribeLivePlayAuthKey') {
    return { ok: true, data: { PlayKeyInfo: { Key: 'tk_main', KeyBackup: '' } } };
  }
  // 质量实时/历史查询：按 StreamName 返回 3 个采样点
  if (args.action === 'DescribeStreamPushInfoList') {
    const p = args.payload || {};
    const sn = p.StreamName || 'x';
    const mk = (i) => ({
      Time: '2026-09-27T0' + (7 + Math.floor(i / 60)) + ':' + String(i % 60).padStart(2, '0') + ':00Z',
      VideoFps: 25 + i, AudioFps: 50 + i, VideoRate: 2000000 + i * 100000, AudioRate: 128000,
      VideoTs: 100000 + i, AudioTs: 100000 + i + (i === 2 ? 40 : 2), MateFps: 30, Resolution: '1920x1080', VCodec: 'h264'
    });
    return { ok: true, data: { DataInfoList: [mk(0), mk(1), mk(2)] }, _sn: sn };
  }
  return { ok: false, error: 'unmocked: ' + args.action };
});
ipcMain.handle('ac:call', async (_e, args) => {
  alCalls.push(args);
  const p = args.params || args.payload || {};
  if (args.action === 'DescribeLiveUserDomains') {
    return { ok: true, data: { Domains: { PageData: [
      { DomainName: 'push.gfcnn.com', LiveDomainType: 'liveEdge' },
      { DomainName: 'alyplay.gfcnn.com', LiveDomainType: 'liveVideo' }
    ], TotalCount: 2 } } };
  }
  if (args.action === 'DescribeLiveStreamsOnlineList') {
    return { ok: true, data: { OnlineInfo: { LiveStreamOnlineInfo: [
      { StreamName: 'comTStr', AppName: 'pushapp', DomainName: p.DomainName, PublishDomain: 'push.gfcnn.com',
        PublishUrl: 'rtmp://push.gfcnn.com/pushapp/comTStr', PublishTime: '2026-09-27T07:00:00Z' }
    ] }, TotalNum: 1 } };
  }
  if (args.action === 'DescribeLiveDomainConfigs') {
    return { ok: true, data: { DomainConfigs: { DomainConfig: [] } } };
  }
  if (args.action === 'DescribeLiveDomainFrameRateAndBitRateData') {
    return { ok: true, data: { FrameRateAndBitRateInfos: { FrameRateAndBitRateInfo: [
      { StreamUrl: 'rtmp://' + (p.DomainName || 'push.gfcnn.com') + '/pushapp/comTStr', VideoFrameRate: 24.9, AudioFrameRate: 50, BitRate: 2500000 }
    ] } } };
  }
  return { ok: false, error: 'unmocked: ' + args.action };
});
ipcMain.handle('ff:list', async () => ({ ok: true, list: [] }));
ipcMain.handle('ff:devices', async () => ({ ok: true, devices: [] }));
ipcMain.handle('ff:pickFile', async () => ({ ok: true, path: '/tmp/test.mp4' }));
ipcMain.handle('ff:pickDir', async () => ({ ok: true, path: '/tmp/rectest' }));
ipcMain.handle('app:openPreview', async () => ({ ok: true }));
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

  // ---------- 在线流：腾讯两条同名流（不同域名）+ 阿里一条 ----------
  await ex(`refreshMonitor(false); 'ok';`);
  await new Promise(r => setTimeout(r, 1200));

  // ---------- A. 流质量卡片 ----------
  await ex(`document.querySelector('.nav-item[data-view="quality"]').click(); 'ok';`);
  await new Promise(r => setTimeout(r, 1800));
  const a1 = await ex(`({
    cards: Object.keys(_qCards),
    tcSamp: Object.keys(_qTcSamp || {}).map(function (k) { return { k: k, n: _qTcSamp[k].length }; })
  })`);
  check('A1 同名流不同域名各一张质量卡（qCardKey 带域名）',
    a1.cards.filter(k => k.indexOf('comTStr') >= 0).length === 2, JSON.stringify(a1.cards));
  check('A2 腾讯质量样本累积（每卡 ≥3 点）',
    a1.tcSamp.length >= 2 && a1.tcSamp.every(x => x.n >= 3), JSON.stringify(a1.tcSamp));
  const a3 = await ex(`(function () {
    var ks = Object.keys(_qCards);
    for (var i = 0; i < ks.length; i++) {
      var ch = document.getElementById(ks[i] + ':chart');
      if (ch && ch._chart) return { ok: true, h: ch.offsetHeight };
    }
    return { ok: false };
  })()`);
  check('A3 质量卡图表 echarts 实例已渲染（容器有高度）', a3.ok && a3.h > 100, JSON.stringify(a3));
  const a4 = await ex(`({ shown: document.getElementById('qBarCard').style.display !== 'none', n: Object.keys(_qBrData).length })`);
  check('A4 各流码率对比条形图显示（数据条数 = 卡片数）', a4.shown && a4.n >= 2, JSON.stringify(a4));

  // ---------- B. 单流详细检测多选 ----------
  await ex(`document.getElementById('qLoadStreamsBtn').click(); 'ok';`);
  const b1 = await ex(`({ n: document.querySelectorAll('.q-multi-chk').length, shown: document.getElementById('qMultiBox').style.display !== 'none' })`);
  check('B1 多选列表展示全部在线流（含阿里流标注）', b1.shown && b1.n >= 3, JSON.stringify(b1));
  // 全选含阿里流 → 查询：阿里跳过、腾讯出卡
  await ex(`document.getElementById('qSelAll').checked = true; document.getElementById('qSelAll').dispatchEvent(new Event('change')); 'ok';`);
  const pickedN = await ex(`_qMultiPick.length`);
  await ex(`document.getElementById('qQueryBtn').click(); 'ok';`);
  await new Promise(r => setTimeout(r, 1500));
  const b2 = await ex(`({
    picked: _qMultiPick.length,
    cards: document.querySelectorAll('#qMultiResult .card').length,
    filled: Array.prototype.filter.call(document.querySelectorAll('#qMultiResult tbody'), function (t) { return t.textContent.indexOf('检测中') < 0; }).length,
    hasAlSkip: document.getElementById('qMultiResult').textContent.indexOf('阿里云流已跳过') >= 0
  })`);
  check('B2 全选后逐流查询（腾讯流出独立结果卡且数据填充，阿里流跳过提示）',
    b2.picked >= 3 && b2.filled >= 2 && b2.hasAlSkip, JSON.stringify(b2));
  const b3 = await ex(`(function () {
    var ks = Object.keys(_mqData);
    for (var i = 0; i < ks.length; i++) {
      if (_mqData[ks[i]].length >= 3) return { ok: true, n: _mqData[ks[i]].length };
    }
    return { ok: false };
  })()`);
  check('B3 多流查询结果数据就绪（CSV 导出可用）', b3.ok, JSON.stringify(b3));

  // ---------- C. 总览可视化 ----------
  const c1 = await ex(`({ trend: _ovTrend.length })`);
  check('C1 在线流趋势已采样', c1.trend >= 1, JSON.stringify(c1));
  await ex(`document.querySelector('.nav-item[data-view="overview"]').click(); 'ok';`);
  await new Promise(r => setTimeout(r, 1200));
  const c2 = await ex(`({
    pie: !!(document.getElementById('ovPie') && document.getElementById('ovPie')._chart),
    trend: !!(document.getElementById('ovTrend') && document.getElementById('ovTrend')._chart)
  })`);
  check('C2 总览饼图 + 趋势图 echarts 实例渲染', c2.pie && c2.trend, JSON.stringify(c2));

  // ---------- 汇总 ----------
  const pass = results.filter(r => r.pass).length;
  console.log('===== E2E v1.1.0 结果: ' + pass + '/' + results.length + ' PASS =====');
  results.forEach(r => console.log((r.pass ? '✅' : '❌') + ' ' + r.name + (r.pass ? '' : '  → ' + r.extra)));
  app.exit(pass === results.length ? 0 : 1);
}
app.whenReady().then(main).catch(e => { console.error('FATAL', e); app.exit(2); });
