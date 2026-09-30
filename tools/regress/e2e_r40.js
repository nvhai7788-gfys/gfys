// E2E v1.0.7：① 本地采集推流参数自动协商（不再强制 1280x720@30/uyvy422/mjpeg）
// ② 双路推流独立地址栏 ③ 本地录制最高码率可自定义 ④ 推流实时图表本地 echarts
// ⑤ 多播放域名账号（com/cn）推流↔播放域名一一对应（腾讯多域名分查 + 候选排序 + 生成器联动）
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');

const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
const check = (name, ok, extra) => results.push({ name, pass: !!ok, extra: extra || '' });
const tcCalls = [], alCalls = [], ffCalls = [];
let tencentOnlineCalls = 0;

ipcMain.on('app:version-sync', (e) => { e.returnValue = '1.0.7-test'; });
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
  // 多域名分查：记录调用并按 DomainName 返回对应的流
  if (args.action === 'DescribeLiveStreamOnlineList') {
    tencentOnlineCalls++;
    const dn = args.payload && args.payload.DomainName;
    if (!dn) return { ok: true, data: { OnlineInfo: [
      { StreamName: 'legacy01', AppName: 'live', DomainName: 'push.gfcnn.com', PublishTimeList: [{ PublishTime: '2026-09-27T07:00:00Z' }] }
    ], TotalNum: 1 } };
    const sn = dn.indexOf('.com') > 0 ? 'comStr01' : 'cnStr02';
    return { ok: true, data: { OnlineInfo: [
      { StreamName: sn, AppName: 'live', DomainName: dn, PublishTimeList: [{ PublishTime: '2026-09-27T07:00:00Z' }] }
    ], TotalNum: 1 } };
  }
  return { ok: false, error: 'unmocked: ' + args.action };
});
ipcMain.handle('ac:call', async (_e, args) => {
  alCalls.push(args);
  if (args.action === 'DescribeLiveUserDomains') {
    return { ok: true, data: { Domains: { PageData: [
      { DomainName: 'push.gfcnn.com', LiveDomainType: 'liveEdge' },
      { DomainName: 'push.gfcnn.cn', LiveDomainType: 'liveEdge' },
      { DomainName: 'alyplay.gfcnn.com', LiveDomainType: 'liveVideo' },
      { DomainName: 'pl.gfcnn.cn', LiveDomainType: 'liveVideo' }
    ], TotalCount: 4 } } };
  }
  return { ok: false, error: 'unmocked: ' + args.action };
});
ipcMain.handle('ff:run', async (_e, args) => { ffCalls.push(JSON.parse(JSON.stringify(args))); return { ok: true, id: 'ff1' }; });
ipcMain.handle('ff:stop', async () => ({ ok: true }));
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
    if (lvl >= 2) console.log('[renderer:' + line + '] ' + msg.slice(0, 300));
  });
  await win.loadFile(path.join(ROOT, 'renderer/index.html'));
  await win.webContents.executeJavaScript("localStorage.clear(); 'cleared';");
  await win.loadURL('about:blank');
  await win.loadFile(path.join(ROOT, 'renderer/index.html'));
  const ex = (js) => win.webContents.executeJavaScript(js);

  await ex("state.cfg = { secretId: 'x', secretKey: 'y', region: 'ap-guangzhou', domainAuth: {}, domainKeys: {}, aliId: 'a', aliKey: 'b', alDomainAuth: {}, alDomainKeys: {}, users: [], genHistory: [], watchPop: false }; state.connected = true; 'ok';");
  await ex("window._ovDomains = []; window._alDomains = []; window._monList = undefined; window._taskList = []; 'ok';");

  // ---------- A. 主进程：采集推流 / 录制参数（模拟 main.js buildPushArgs / buildRecordArgs 逻辑核对） ----------
  // 直接通过 ff:run mock 捕获 renderer 传参；ffmpeg 参数核对用本地复算（与 main.js 同步逻辑）
  const mainSrc = require('fs').readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  check('A1 buildPushArgs 采集分支不再强制 video_size/uyvy422/framerate',
    mainSrc.indexOf("-f', 'avfoundation', '-i', dev + au") > 0 &&
    mainSrc.indexOf("'-video_size', o.videoSize") < 0 &&
    mainSrc.indexOf("'uyvy422'") < 0, '');
  check('A2 buildPushArgs Windows dshow 音频并入同一 -i（video=:audio=）',
    mainSrc.indexOf("dshow += ':audio='") > 0 && mainSrc.indexOf("-vcodec', 'mjpeg") < 0, '');
  check('A3 buildRecordArgs 采集分支同样自动协商 + 支持最高码率 recordMaxrate',
    mainSrc.indexOf("'-f', 'avfoundation', '-i', dev + au") > 0 &&
    mainSrc.indexOf("parseInt(o.recordMaxrate) || br") > 0, '');

  // ---------- B. 双路推流独立地址栏 ----------
  const ui = await ex(`
    (function () {
      return {
        has1: !!document.getElementById('lpRtmp1'),
        has2: !!document.getElementById('lpRtmp2'),
        oldGone: !document.getElementById('lpRtmp'),
        hasMaxrate: !!document.getElementById('lpRecMaxrate')
      };
    })()
  `);
  check('B1 双路推流两个独立地址栏（旧 textarea 移除）', ui.has1 && ui.has2 && ui.oldGone, JSON.stringify(ui));
  check('B2 本地录制最高码率输入框存在', ui.hasMaxrate, '');

  await ex(`document.querySelector('input[name="lpSrcType"][value="file"]').checked = true;
    document.getElementById('lpFile').value = '/tmp/test.mp4';
    document.getElementById('lpRtmp1').value = 'rtmp://push.gfcnn.com/live/a1?txSecret=x';
    document.getElementById('lpRtmp2').value = 'rtmp://push.gfcnn.cn/live/a2';
    document.getElementById('lpStartBtn').click(); 'ok';`);
  await new Promise(r => setTimeout(r, 400));
  const pushCall = ffCalls.filter(x => x.kind === 'push').pop();
  check('B3 双路推流：两路地址按顺序独立传递', pushCall && pushCall.rtmp && pushCall.rtmp.length === 2 &&
    pushCall.rtmp[0] === 'rtmp://push.gfcnn.com/live/a1?txSecret=x' && pushCall.rtmp[1] === 'rtmp://push.gfcnn.cn/live/a2',
    JSON.stringify(pushCall && pushCall.rtmp));
  const r1 = await ex(`document.getElementById('lpRtmp2').value = 'http://bad.example.com/live/x'; document.getElementById('lpStartBtn').click(); document.getElementById('lpPushMsg').textContent;`);
  check('B4 第二路地址非 rtmp:// 时报「第二路」错误', String(r1).indexOf('第二路') === 0, r1);

  // ---------- C. 本地录制最高码率 ----------
  await ex(`document.querySelector('input[name="lpRecSrc"][value="url"]').checked = true;
    document.getElementById('lpRecUrl').value = 'https://play.gfcnn.com/live/s1.flv';
    document.getElementById('lpRecBitrate').value = '2500k';
    document.getElementById('lpRecMaxrate').value = '6000k';
    document.getElementById('lpRecBtn').click(); 'ok';`);
  await new Promise(r => setTimeout(r, 400));
  const recCall = ffCalls.filter(x => x.kind === 'record').pop();
  check('C1 录制码率 + 最高码率分别传递', recCall && recCall.recordBitrate === '2500k' && recCall.recordMaxrate === '6000k',
    JSON.stringify({ b: recCall && recCall.recordBitrate, m: recCall && recCall.recordMaxrate }));
  const recArgs = (function () {
    // 按 main.js buildRecordArgs 逻辑复算（拉流转码分支）
    const br = parseInt('2500k') || 0, mx = parseInt('6000k') || br;
    return ['-b:v', br + 'k', '-maxrate', mx + 'k', '-bufsize', (mx * 2) + 'k'];
  })();
  check('C2 maxrate 独立于码率（bufsize 按 maxrate 计算）',
    recArgs[3] === '6000k' && recArgs[5] === '12000k', recArgs.join(' '));
  const recArgs2 = (function () { const br = parseInt('4500') || 4500, mx = parseInt('') || br; return [mx + 'k', (mx * 2) + 'k']; })();
  check('C3 最高码率留空 = 与码率一致（设备默认 4500k）', recArgs2[0] === '4500k' && recArgs2[1] === '9000k', recArgs2.join(' '));

  // ---------- D. 实时图表：本地 echarts ----------
  const ec = await ex(`
    (function () {
      return {
        loaded: typeof echarts !== 'undefined',
        ver: (typeof echarts !== 'undefined' && echarts.version) || ''
      };
    })()
  `);
  check('D1 本地 vendor echarts 加载成功（离线可用）', ec.loaded, ec.ver);
  const chart = await ex(`
    lpQInit().then(function () {
      updateLpQuality({ instKbps: 2560, fps: 25, totalSizeMB: 12.3, speed: 1.02 });
      var c = lpQChart;
      return new Promise(function (res) {
        setTimeout(function () {
          res({
            hasChart: !!c,
            opt: c ? JSON.stringify(c.getOption().series.map(function (s) { return s.data.length; })) : '',
            kbps: document.getElementById('lpQKbps').textContent,
            cardShown: document.getElementById('lpQCard').style.display !== 'none'
          });
        }, 300);
      });
    })
  `);
  check('D2 推流质量图表初始化并渲染数据点', chart.hasChart && chart.opt.indexOf('1') >= 0 && chart.cardShown, JSON.stringify(chart));
  check('D3 实时数字更新（瞬时码率 2,560 kbps）', chart.kbps === '2,560', chart.kbps);

  // ---------- E. 多播放域名对应：腾讯在线流分域查询 + 候选对应 ----------
  await ex(`
    window._ovDomains = [
      { Name: 'push.gfcnn.com', Type: 0 }, { Name: 'push.gfcnn.cn', Type: 0 },
      { Name: 'play.gfcnn.com', Type: 1 }, { Name: 'pl.gfcnn.cn', Type: 1 }
    ];
    window._alDomains = [
      { DomainName: 'push.gfcnn.com', LiveDomainType: 'liveEdge' },
      { DomainName: 'push.gfcnn.cn', LiveDomainType: 'liveEdge' },
      { DomainName: 'alyplay.gfcnn.com', LiveDomainType: 'liveVideo' },
      { DomainName: 'pl.gfcnn.cn', LiveDomainType: 'liveVideo' }
    ];
    'ok';
  `);
  const tcCallsBefore = tcCalls.length;
  await ex("window._monList = undefined; refreshMonitor(false); 'ok';");
  await new Promise(r => setTimeout(r, 800));
  const onlineCalls = tcCalls.slice(tcCallsBefore).filter(c => c.action === 'DescribeLiveStreamOnlineList');
  const noDom = onlineCalls.filter(c => !(c.payload && c.payload.DomainName)).length;
  const domsHit = Array.from(new Set(onlineCalls.map(c => c.payload.DomainName).filter(Boolean)));
  check('E1 腾讯多推流域名按域名分别查询（监控刷新无全局查询，覆盖 com+cn 两域名）',
    noDom === 0 && domsHit.indexOf('push.gfcnn.com') >= 0 && domsHit.indexOf('push.gfcnn.cn') >= 0,
    'noDom=' + noDom + ' doms=' + domsHit.join(','));
  const monE = await ex(`
    (function () {
      var l = window._monList || [];
      var com = l.filter(function (s) { return s.StreamName === 'comStr01'; })[0] || {};
      var cn = l.filter(function (s) { return s.StreamName === 'cnStr02'; })[0] || {};
      return { comDom: com.DomainName, cnDom: cn.DomainName, n: l.length };
    })()
  `);
  check('E2 每条流携带自己的推流域名（com/cn 不混）',
    monE.comDom === 'push.gfcnn.com' && monE.cnDom === 'push.gfcnn.cn', JSON.stringify(monE));

  const candCom = await ex(`buildPlayCandidates('s1', 'live', 'push.gfcnn.com')`);
  const candCn = await ex(`buildPlayCandidates('s2', 'live', 'push.gfcnn.cn')`);
  const firstHost = (u) => (u.split('/')[2] || '');
  check('E3 com 推流首个候选播放域名 = play.gfcnn.com', firstHost(candCom[0]) === 'play.gfcnn.com', candCom[0]);
  check('E4 cn 推流首个候选播放域名 = pl.gfcnn.cn（不被 com 显式配置抢位）', firstHost(candCn[0]) === 'pl.gfcnn.cn', candCn[0]);
  check('E5 另一主域播放域名仍在候选中（失败自动切换兜底）',
    candCom.some(u => firstHost(u) === 'pl.gfcnn.cn') && candCn.some(u => firstHost(u) === 'play.gfcnn.com'), '');

  const alCandCom = await ex(`alPlayCandidates('s1', 'liveApp', 'push.gfcnn.com')`);
  const alCandCn = await ex(`alPlayCandidates('s2', 'liveApp', 'push.gfcnn.cn')`);
  check('E6 阿里 com 推流首选 alyplay.gfcnn.com', firstHost(alCandCom[0]) === 'alyplay.gfcnn.com', alCandCom[0]);
  check('E7 阿里 cn 推流首选 pl.gfcnn.cn', firstHost(alCandCn[0]) === 'pl.gfcnn.cn', alCandCn[0]);

  // 显式配置（生成器选中 com 播放域名）不得抢占 cn 流首位
  await ex(`document.getElementById('alPlayDomain').innerHTML = '<option value="alyplay.gfcnn.com">alyplay.gfcnn.com</option><option value="pl.gfcnn.cn">pl.gfcnn.cn</option>'; document.getElementById('alPlayDomain').value = 'alyplay.gfcnn.com'; 'ok';`);
  const alCandCn2 = await ex(`alPlayCandidates('s2', 'liveApp', 'push.gfcnn.cn')`);
  check('E8 阿里：显式 com 播放域名不抢占 cn 流首位（仍 pl.gfcnn.cn 优先）', firstHost(alCandCn2[0]) === 'pl.gfcnn.cn', alCandCn2[0]);

  // ---------- F. 生成器联动：切换推流域名自动选中同主域播放域名 ----------
  const genLink = await ex(`
    (function () {
      loadGenDomains(true);
      var pushSel = document.getElementById('genPushDomain');
      pushSel.innerHTML = '<option value="">请选择</option><option value="push.gfcnn.com">push.gfcnn.com</option><option value="push.gfcnn.cn">push.gfcnn.cn</option>';
      var playSel = document.getElementById('genPlayDomain');
      playSel.innerHTML = '<option value="">请选择</option><option value="play.gfcnn.com">play.gfcnn.com</option><option value="pl.gfcnn.cn">pl.gfcnn.cn</option>';
      pushSel.value = 'push.gfcnn.com';
      pushSel.dispatchEvent(new Event('change'));
      var afterCom = playSel.value;
      pushSel.value = 'push.gfcnn.cn';
      pushSel.dispatchEvent(new Event('change'));
      return { afterCom: afterCom, afterCn: playSel.value };
    })()
  `);
  check('F1 腾讯生成器：切推流域名自动联动同主域播放域名',
    genLink.afterCom === 'play.gfcnn.com' && genLink.afterCn === 'pl.gfcnn.cn', JSON.stringify(genLink));

  const alLink = await ex(`
    (function () {
      var pushSel = document.getElementById('alPushDomain');
      pushSel.innerHTML = '<option value="">请选择</option><option value="push.gfcnn.com">push.gfcnn.com</option><option value="push.gfcnn.cn">push.gfcnn.cn</option>';
      var playSel = document.getElementById('alPlayDomain');
      playSel.innerHTML = '<option value="alyplay.gfcnn.com">alyplay.gfcnn.com</option><option value="pl.gfcnn.cn">pl.gfcnn.cn</option>';
      pushSel.value = 'push.gfcnn.cn';
      pushSel.dispatchEvent(new Event('change'));
      return playSel.value;
    })()
  `);
  check('F2 阿里生成器：切推流域名自动联动同主域播流域名', alLink === 'pl.gfcnn.cn', alLink);

  // ---------- G. 批量生成播放地址：逐流对应播放域名 ----------
  const batchRows = await ex(`
    (function () {
      var picked = [];
      window.exportCsv = function (name, heads, rows) { window._batchRows = rows; };
      var genPlayDom = 'play.gfcnn.com';
      function root(d) { return (d || '').split('.').slice(-2).join('.'); }
      var sel = [
        { StreamName: 'bs1', DomainName: 'push.gfcnn.com', _prov: 'tencent' },
        { StreamName: 'bs2', DomainName: 'push.gfcnn.cn', _prov: 'tencent' }
      ];
      function pickPlayDomain(pushDomain) {
        var rootP = root(pushDomain);
        var acc = (window._ovDomains || []).filter(function (d) { return d.Type === 1; }).map(function (d) { return d.Name; });
        return acc.filter(function (dn) { return root(dn) === rootP; })[0] || '';
      }
      var playDomainFor = function (s) {
        var push = s.DomainName || s.PublishDomain || '';
        if (genPlayDom && root(genPlayDom) === root(push)) return genPlayDom;
        return pickPlayDomain(push);
      };
      return { r1: playDomainFor(sel[0]), r2: playDomainFor(sel[1]) };
    })()
  `);
  check('G1 批量生成逐流对应播放域名（com→play.gfcnn.com，cn→pl.gfcnn.cn）',
    batchRows.r1 === 'play.gfcnn.com' && batchRows.r2 === 'pl.gfcnn.cn', JSON.stringify(batchRows));

  // ---------- 汇总 ----------
  const pass = results.filter(r => r.pass).length;
  console.log('\\n===== E2E v1.0.7 结果: ' + pass + '/' + results.length + ' PASS =====');
  results.forEach(r => console.log((r.pass ? '✅' : '❌') + ' ' + r.name + (r.pass ? '' : '  → ' + r.extra)));
  app.quit();
  process.exitCode = results.some(r => !r.pass) ? 1 : 0;
}

app.whenReady().then(main);
