// E2E v1.1.2：①流质量「无质量数据」根因（toUtcTime 双重转换→查询窗口偏移 8h）——mock 按时间窗校验，
// 过期窗口返回空以复现旧 bug；②带宽监控在线流自动分组（腾讯+阿里，无需手动选择）；
// ③直播概述双云合并（域名表带云商列、统计合并、在线流总数合并）
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');

const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
const check = (name, ok, extra) => results.push({ name, pass: !!ok, extra: extra || '' });

ipcMain.on('app:version-sync', (e) => { e.returnValue = '1.1.2-test'; });
ipcMain.on('util:md5-sync', (e, s) => { e.returnValue = crypto.createHash('md5').update(s).digest('hex'); });
ipcMain.on('util:sha256-sync', (e, s) => { e.returnValue = crypto.createHash('sha256').update(s).digest('hex'); });
ipcMain.handle('tc:call', async (_e, args) => {
  if (args.action === 'DescribeLiveDomains') {
    return { ok: true, data: { DomainList: [
      { Name: 'live.gfcnn.cn', Type: 0 },
      { Name: 'play.gfcnn.com', Type: 1 }
    ] } };
  }
  if (args.action === 'DescribeLiveStreamOnlineList') {
    const dn = args.payload && args.payload.DomainName;
    return { ok: true, data: { OnlineInfo: ['ces1', 'ces2'].map(sn => (
      { StreamName: sn, AppName: 'live', DomainName: dn || 'live.gfcnn.cn', PublishTimeList: [{ PublishTime: '2026-09-27T07:00:00Z' }] }
    )), TotalNum: 2 } };
  }
  if (args.action === 'DescribeLivePlayAuthKey') {
    return { ok: true, data: { PlayKeyInfo: { Key: 'tk_main', KeyBackup: '' } } };
  }
  if (args.action === 'DescribeStreamPushInfoList') {
    const p = args.payload || {};
    // 时间窗校验：EndTime 距今超过 30 分钟视为过期窗口 → 返回空（复现旧 toUtcTime 双重转换 bug）
    const endMs = Date.parse(p.EndTime || '');
    if (!endMs || Date.now() - endMs > 30 * 60 * 1000) return { ok: true, data: { DataInfoList: [] } };
    const startMs = Date.parse(p.StartTime || '');
    if (!startMs || endMs - startMs > 3 * 3600 * 1000 || endMs - startMs < 60 * 1000) return { ok: true, data: { DataInfoList: [] } };
    const mk = (i) => ({
      Time: new Date(endMs - (2 - i) * 60000).toISOString(),
      VideoFps: 25, AudioFps: 50, VideoRate: 2000000, AudioRate: 128000,
      VideoTs: 100000 + i, AudioTs: 100002 + i, MateFps: 30, Resolution: '1920x1080', VCodec: 'h264'
    });
    return { ok: true, data: { DataInfoList: [mk(0), mk(1), mk(2)] } };
  }
  if (args.action === 'DescribePushBandwidthAndFluxList' || args.action === 'DescribeBillBandwidthAndFluxList') {
    return { ok: true, data: { DataInfoList: [
      { Time: '2026-09-27T10:00:00Z', Bandwidth: 50000000, Flux: 123456789000 },
      { Time: '2026-09-27T10:05:00Z', Bandwidth: 52000000, Flux: 130000000000 }
    ] } };
  }
  if (args.action === 'DescribeLiveDomainPlayInfoList') {
    return { ok: true, data: { Time: '2026-09-27T12:00:00Z', TotalBandwidth: 48000000, TotalOnline: 66, TotalRequest: 1000 } };
  }
  if (args.action === 'DescribeLivePullStreamTasks') return { ok: true, data: { TaskInfos: [] } };
  return { ok: false, error: 'unmocked tc: ' + args.action };
});
ipcMain.handle('ac:call', async (_e, args) => {
  const p = args.params || args.payload || {};
  if (args.action === 'DescribeLiveUserDomains') {
    return { ok: true, data: { Domains: { PageData: [
      { DomainName: 'push.gfcnn.com', LiveDomainType: 'liveEdge', LiveDomainStatus: 'online', GmtCreated: '2026-01-01T00:00:00Z' },
      { DomainName: 'alyplay.gfcnn.com', LiveDomainType: 'liveVideo', LiveDomainStatus: 'online', GmtCreated: '2026-01-02T00:00:00Z' },
      { DomainName: 'pl.gfcnn.cn', LiveDomainType: 'liveVideo', LiveDomainStatus: 'online', GmtCreated: '2026-01-03T00:00:00Z' }
    ], TotalCount: 3 } } };
  }
  if (args.action === 'DescribeLiveStreamsOnlineList') {
    const arr = [{ StreamName: 'csi44444', AppName: 'live', DomainName: p.DomainName, PublishDomain: 'push.gfcnn.com',
      PublishUrl: 'rtmp://push.gfcnn.com/live/csi44444', PublishTime: '2026-09-27T07:00:00Z' }];
    if (p.DomainName === 'pl.gfcnn.cn') {
      arr.push({ StreamName: 'csi88888', AppName: 'live', DomainName: 'pl.gfcnn.cn', PublishDomain: 'push2.gfcnn.com',
        PublishUrl: 'rtmp://push2.gfcnn.com/live/csi88888', PublishTime: '2026-09-27T07:05:00Z' });
    }
    return { ok: true, data: { OnlineInfo: { LiveStreamOnlineInfo: arr }, TotalNum: arr.length } };
  }
  if (args.action === 'DescribeLiveDomainConfigs') return { ok: true, data: { DomainConfigs: { DomainConfig: [] } } };
  if (args.action === 'DescribeLiveDomainFrameRateAndBitRateData') {
    // 时间窗校验：QueryTime 距今超过 30 分钟 → 空（复现旧 bug）
    const qms = Date.parse(p.QueryTime || '');
    if (!qms || Date.now() - qms > 30 * 60 * 1000) return { ok: true, data: { FrameRateAndBitRateInfos: { FrameRateAndBitRateInfo: [] } } };
    return { ok: true, data: { FrameRateAndBitRateInfos: { FrameRateAndBitRateInfo: [
      { StreamUrl: 'rtmp://push.gfcnn.com/live/csi44444', VideoFrameRate: 25, AudioFrameRate: 50, BitRate: 2500000 },
      { StreamUrl: 'rtmp://push2.gfcnn.com/live/csi88888', VideoFrameRate: 24, AudioFrameRate: 48, BitRate: 1800000 }
    ] } } };
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

  // ---------- A. 流质量时间窗修复 ----------
  await ex(`refreshMonitor(false); 'ok';`);
  await new Promise(r => setTimeout(r, 1500));
  await ex(`document.querySelector('.nav-item[data-view="quality"]').click(); 'ok';`);
  await new Promise(r => setTimeout(r, 2500));
  const a1 = await ex(`(function () {
    var ks = Object.keys(_qCards).filter(function (k) { return k.indexOf('|ces') >= 0; });
    var oks = 0, empty = 0;
    ks.forEach(function (k) {
      var st = document.getElementById(k + ':st');
      if (!st) return;
      if (st.textContent === '正常') oks++;
      if (st.textContent.indexOf('无质量数据') >= 0) empty++;
    });
    return { cards: ks.length, oks: oks, empty: empty };
  })()`);
  check('A1 腾讯流质量卡时间窗修复后状态「正常」（不再无质量数据）', a1.cards === 2 && a1.oks === 2 && a1.empty === 0, JSON.stringify(a1));
  const a2 = await ex(`(function () {
    var ks = Object.keys(_qCards).filter(function (k) { return k.indexOf('aliyun|') === 0; });
    var oks = 0, empty = 0;
    ks.forEach(function (k) {
      var st = document.getElementById(k + ':st');
      if (!st) return;
      if (st.textContent === '正常') oks++;
      if (st.textContent.indexOf('无质量数据') >= 0) empty++;
    });
    return { cards: ks.length, oks: oks, empty: empty };
  })()`);
  check('A2 阿里流质量批量查询时间窗修复后状态「正常」', a2.cards >= 1 && a2.oks >= 1 && a2.empty === 0, JSON.stringify(a2));

  // ---------- B. 带宽监控自动分组 ----------
  await ex(`document.querySelector('.nav-item[data-view="charts"]').click(); 'ok';`);
  await new Promise(r => setTimeout(r, 2500));
  const b1 = await ex(`({
    sum: document.getElementById('bwGrpSum').textContent,
    tc: Object.keys(_bwGrp).filter(function (k) { return _bwGrp[k].prov === 'tencent'; }).length,
    al: Object.keys(_bwGrp).filter(function (k) { return _bwGrp[k].prov === 'aliyun'; }).length,
    chart: !!(document.getElementById('bwGrpChart')._chart)
  })`);
  check('B1 在线流实时带宽自动分组：无需手动选择即展示全部在线流（含数量标注）',
    b1.tc === 2 && b1.al >= 1 && b1.sum.indexOf('腾讯云 2') >= 0 && b1.sum.indexOf('阿里云') >= 0, JSON.stringify(b1));
  check('B2 分组条形图 echarts 实例渲染', b1.chart, JSON.stringify(b1));
  const b3 = await ex(`(function () {
    var t = document.getElementById('bwGrpBody').textContent;
    return { tcGrp: t.indexOf('腾讯云') >= 0 && t.indexOf('live.gfcnn.cn') >= 0,
             alGrp: t.indexOf('阿里云') >= 0 && t.indexOf('push.gfcnn.com') >= 0,
             ces1: t.indexOf('ces1') >= 0, kbps: t.indexOf('kbps') >= 0 };
  })()`);
  check('B3 分组明细表按云商+推流域名分组展示（阿里云在线流已加入）',
    b3.tcGrp && b3.alGrp && b3.ces1 && b3.kbps, JSON.stringify(b3));

  // ---------- C. 概述双云合并 ----------
  await ex(`document.querySelector('.nav-item[data-view="overview"]').click(); 'ok';`);
  await new Promise(r => setTimeout(r, 2000));
  const c1 = await ex(`(function () {
    var rows = document.querySelectorAll('#ovDomainBody tr');
    var t = document.getElementById('ovDomainBody').textContent;
    return { rows: rows.length, tc: t.indexOf('腾讯云') >= 0, al: t.indexOf('阿里云') >= 0,
             alDom: t.indexOf('pl.gfcnn.cn') >= 0,
             stPush: document.getElementById('stPush').textContent,
             stPlay: document.getElementById('stPlay').textContent,
             stOnline: document.getElementById('stOnline').textContent,
             pushSub: document.getElementById('stPush').nextElementSibling.textContent };
  })()`);
  check('C1 概述域名表双云合并展示（5 行 = 腾讯 2 + 阿里 3，云商列区分）', c1.rows === 5 && c1.tc && c1.al && c1.alDom, JSON.stringify(c1));
  check('C2 概览统计合并（推流 1+1=2、播放 1+2=3，副标题带分云明细）',
    c1.stPush === '2' && c1.stPlay === '3' && c1.pushSub.indexOf('阿里') >= 0, JSON.stringify(c1));
  check('C3 在线流总数双云合并（腾讯 2 + 阿里 2 合并后 4）', c1.stOnline === '4', JSON.stringify(c1));

  // ---------- 汇总 ----------
  const pass = results.filter(r => r.pass).length;
  console.log('===== E2E v1.1.2 结果: ' + pass + '/' + results.length + ' PASS =====');
  results.forEach(r => console.log((r.pass ? '✅' : '❌') + ' ' + r.name + (r.pass ? '' : '  → ' + r.extra)));
  app.exit(pass === results.length ? 0 : 1);
}
app.whenReady().then(main).catch(e => { console.error('FATAL', e); app.exit(2); });
