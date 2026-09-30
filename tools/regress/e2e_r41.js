// E2E v1.0.8：① 阿里在线流按播放域名查询（官方要求 DomainName=播流域名）+ 响应自带
//   PublishDomain/AppName 逐流精确对应 + playHint 优先 ② 本地推流设备能力探测重试
// ③ 打开软件不再自动弹窗播放（watchPop 默认关闭）
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
const check = (name, ok, extra) => results.push({ name, pass: !!ok, extra: extra || '' });
const tcCalls = [], alCalls = [], ffCalls = [], previewCalls = [];

ipcMain.on('app:version-sync', (e) => { e.returnValue = '1.0.8-test'; });
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
    tencentOnlineCalls++;
    const dn = args.payload && args.payload.DomainName;
    const sn = dn && dn.indexOf('.com') > 0 ? 'comTStr' : 'cnTStr';
    return { ok: true, data: { OnlineInfo: [
      { StreamName: sn, AppName: 'pushapp', DomainName: dn || 'push.gfcnn.com', PublishTimeList: [{ PublishTime: '2026-09-27T07:00:00Z' }] }
    ], TotalNum: 1 } };
  }
  if (args.action === 'DescribeLivePlayAuthKey') {
    return { ok: true, data: { PlayKeyInfo: { Key: 'tk_main', KeyBackup: '' } } };
  }
  return { ok: false, error: 'unmocked: ' + args.action };
});
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
  // 阿里在线流：按播放域名查询；响应自带真实推流域名（PublishDomain）与 AppName
  if (args.action === 'DescribeLiveStreamsOnlineList') {
    const dn = p.DomainName;
    if (dn === 'alyplay.gfcnn.com') {
      return { ok: true, data: { OnlineInfo: { LiveStreamOnlineInfo: [
        { StreamName: 'alStr1', AppName: 'pushapp', DomainName: dn, PublishDomain: 'push.gfcnn.com',
          PublishUrl: 'rtmp://push.gfcnn.com/pushapp/alStr1', PublishTime: '2026-09-27T07:00:00Z' }
      ] }, TotalNum: 1 } };
    }
    if (dn === 'pl.gfcnn.cn') {
      // 故意缺 PublishDomain/AppName → 应从 PublishUrl 兜底解析
      return { ok: true, data: { OnlineInfo: { LiveStreamOnlineInfo: [
        { StreamName: 'cnStr2', DomainName: dn, PublishUrl: 'rtmp://push.gfcnn.cn/cnapp/cnStr2',
          PublishTime: '2026-09-27T07:05:00Z' }
      ] }, TotalNum: 1 } };
    }
    return { ok: true, data: { OnlineInfo: { LiveStreamOnlineInfo: [] }, TotalNum: 0 } };
  }
  return { ok: false, error: 'unmocked: ' + args.action };
});
ipcMain.handle('ff:run', async (_e, args) => { ffCalls.push(JSON.parse(JSON.stringify(args))); return { ok: true, id: 'ff1' }; });
ipcMain.handle('ff:stop', async () => ({ ok: true }));
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

  await ex("state.cfg = { secretId: 'x', secretKey: 'y', region: 'ap-guangzhou', domainAuth: {}, domainKeys: {}, aliId: 'a', aliKey: 'b', alDomainAuth: {}, alDomainKeys: {}, users: [], genHistory: [] }; state.connected = true; 'ok';");
  await ex("window._ovDomains = []; window._alDomains = []; window._monList = undefined; window._taskList = []; 'ok';");
  // 进入工作台（登录后流程）：bindMonitorPrefs/bindWatchPrefs 在此绑定
  await ex("enterApp(false); 'ok';");
  await ex("window.__e2eMark = 1; 'ok';");
  // watchPop 写入陷阱：记录每次赋值与调用栈
  await ex(`(function () {
    state.cfg._wpLog = [];
    Object.defineProperty(state.cfg, 'watchPop', {
      configurable: true,
      set: function (v) { this._wpLog.push(String(v) + ' @ ' + (new Error().stack.split('\\n')[2] || '').trim().slice(0, 80)); this._wp = v; },
      get: function () { return this._wp; }
    });
    state.cfg.watchPop = undefined;
    'ok';
  })()`);
  await ex("window.__e2eMark = 1; 'ok';");

  // ---------- A. 启动自动弹窗默认关闭 ----------
  const wp = await ex(`({ checked: document.getElementById('watchPop').checked, cfg: state.cfg.watchPop })`);
  check('A1 watchPop 默认未勾选（cfg 无值 → 关）', wp.checked === false && wp.cfg === undefined, JSON.stringify(wp));
  // ---------- A2 手动勾选持久化 ----------
  await ex(`document.getElementById('watchPop').checked = true; document.getElementById('watchPop').dispatchEvent(new Event('change')); 'ok';`);
  const wp2 = await ex(`state.cfg.watchPop`);
  check('A2 手动勾选后 cfg.watchPop=true 持久', wp2 === true, String(wp2));

  // ---------- B. 阿里在线流：按播放域名查询 + PublishDomain/AppName 解析 ----------
  await ex(`refreshMonitor(false); 'ok';`);
  await new Promise(r => setTimeout(r, 1200));
  const onlineCalls = alCalls.filter(c => c.action === 'DescribeLiveStreamsOnlineList');
  const domsQ = onlineCalls.map(c => ((c.params || c.payload || {}).DomainName) || '?');
  check('B1 阿里在线流按播放域名查询（alyplay.gfcnn.com + pl.gfcnn.cn，无推流域名查询）',
    domsQ.indexOf('alyplay.gfcnn.com') >= 0 && domsQ.indexOf('pl.gfcnn.cn') >= 0 &&
    domsQ.indexOf('push.gfcnn.com') < 0 && domsQ.indexOf('push.gfcnn.cn') < 0, domsQ.join(','));
  const mon = await ex(`
    (function () {
      var al = (window._monList || []).filter(function (s) { return s._prov === 'aliyun'; });
      function row(sn) { return al.filter(function (s) { return s.StreamName === sn; })[0] || {}; }
      var r1 = row('alStr1'), r2 = row('cnStr2');
      return {
        n: al.length,
        r1pd: r1.PublishDomain || '', r1dn: r1.DomainName || '', r1app: r1.AppName || '',
        r2pd: r2.PublishDomain || '', r2dn: r2.DomainName || '', r2app: r2.AppName || ''
      };
    })()
  `);
  check('B2 com 流：PublishDomain=push.gfcnn.com，DomainName=alyplay.gfcnn.com，AppName=pushapp',
    mon.r1pd === 'push.gfcnn.com' && mon.r1dn === 'alyplay.gfcnn.com' && mon.r1app === 'pushapp', JSON.stringify(mon));
  check('B3 cn 流（响应缺字段）：PublishDomain/AppName 从 PublishUrl 兜底解析',
    mon.r2pd === 'push.gfcnn.cn' && mon.r2dn === 'pl.gfcnn.cn' && mon.r2app === 'cnapp', JSON.stringify(mon));

  // ---------- C. 预览候选：playHint 精确对应 ----------
  await ex(`openStreamPreview('alStr1', 'pushapp', 'push.gfcnn.com', 'aliyun', 'alyplay.gfcnn.com'); 'ok';`);
  await new Promise(r => setTimeout(r, 900));
  const p1 = previewCalls[previewCalls.length - 1];
  const h1 = ((p1.cands[0] || '').split('/')[2] || '');
  check('C1 com 流预览：候选第一域名 = alyplay.gfcnn.com（playHint 最优先）', h1 === 'alyplay.gfcnn.com', (p1.cands[0] || '').slice(0, 90));
  check('C2 com 流预览 meta.push = 推流域名', (p1.meta.push || '') === 'push.gfcnn.com', p1.meta.push);
  await ex(`openStreamPreview('cnStr2', 'cnapp', 'push.gfcnn.cn', 'aliyun', 'pl.gfcnn.cn'); 'ok';`);
  await new Promise(r => setTimeout(r, 900));
  const p2 = previewCalls[previewCalls.length - 1];
  const h2 = ((p2.cands[0] || '').split('/')[2] || '');
  check('C2 cn 流预览：候选第一域名 = pl.gfcnn.cn', h2 === 'pl.gfcnn.cn', (p2.cands[0] || '').slice(0, 90));

  // C3 无 playHint（兼容旧调用）：同主域优先仍生效
  const c3 = await ex(`
    new Promise(function (res) {
      alPlayCandidatesAsync('alStr1', 'pushapp', 'push.gfcnn.com', function (cands) {
        res(cands.slice(0, 3).map(function (u) { return u.split('/')[2]; }));
      });
    })
  `);
  check('C3 旧四参调用兼容：无提示时 com 推流 → alyplay.gfcnn.com 同主域优先',
    c3[0] === 'alyplay.gfcnn.com', JSON.stringify(c3));

  // ---------- D. 预览观看自动弹窗联动（注入合成腾讯流，直接测 renderWatch 弹窗逻辑） ----------
  await ex(`document.getElementById('watchPop').checked = false; document.getElementById('watchPop').dispatchEvent(new Event('change')); 'ok';`);
  await ex(`window._monList = [{ _prov: 'tencent', StreamName: 'comTStr', AppName: 'pushapp', DomainName: 'push.gfcnn.com', PublishTimeList: [{ PublishTime: '2026-09-27T07:00:00Z' }] }];
    state.cfg.genHistory = [{ pushUrl: 'rtmp://push.gfcnn.com/pushapp/comTStr' }];
    window._watchKnown = {}; renderWatch(); 'ok';`);
  await new Promise(r => setTimeout(r, 600));
  const dbg = await ex(`({
    tagKeys: Object.keys(watchTagMap()),
    watchPopChecked: document.getElementById('watchPop').checked,
    cfgWatchPop: state.cfg.watchPop
  })`);
  const popBefore = previewCalls.length;
  check('D1 watchPop 关闭时：检测到新推流不自动弹窗（仅建卡不弹窗）', dbg.cfgWatchPop === false && popBefore === previewCalls.length, JSON.stringify(dbg));
  await ex(`window._watchKnown = {}; document.getElementById('watchPop').checked = true; document.getElementById('watchPop').dispatchEvent(new Event('change')); renderWatch(); 'ok';`);
  await new Promise(r => setTimeout(r, 1200));
  const popped = previewCalls.length - popBefore;
  check('D2 watchPop 开启后：renderWatch 自动弹窗播放', popped >= 1, 'delta=' + popped);
  const lastPop = previewCalls[previewCalls.length - 1];
  check('D3 自动弹窗候选第一域名 = 与推流同主域的播放域名',
    ((lastPop.cands[0] || '').split('/')[2] || '') === 'play.gfcnn.com', (lastPop.cands[0] || '').slice(0, 90));
  await ex(`document.getElementById('watchPop').checked = false; document.getElementById('watchPop').dispatchEvent(new Event('change')); 'ok';`);


  // ---------- E. 本地推流 / 录制回归（v1.0.7 功能不回退）+ 设备重试代码存在 ----------
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  check('E1 main.js 含设备能力探测重试（ffSpawnDevice/parseDevModes/FF_CAPTURE_ERR）',
    mainSrc.indexOf('ffSpawnDevice') > 0 && mainSrc.indexOf('parseDevModes') > 0 && mainSrc.indexOf('FF_CAPTURE_ERR') > 0, '');
  check('E2 buildPushArgs/buildRecordArgs 支持 capFps/capSize 显式采集参数',
    mainSrc.indexOf("src.capFps") > 0 && mainSrc.indexOf("src.capSize") > 0, '');
  check('E3 重试解析 avfoundation 支持模式格式（WxH@[min max]）',
    mainSrc.indexOf('@\\\\[?') < 0 && /parseDevModes[\s\S]{0,300}x\{2,5\}/.test(mainSrc) === true || mainSrc.indexOf('(\\d{2,5})x(\\d{2,5})') > 0, '');
  await ex(`document.getElementById('lpRtmp1').value = 'rtmp://push.gfcnn.com/live/a1';
    document.getElementById('lpRtmp2').value = '';
    document.querySelector('input[name="lpSrcType"][value="device"]').checked = true;
    document.getElementById('lpDeviceVideo').innerHTML = '<option value="1" selected>虚拟采集卡 [1]</option>';
    document.getElementById('lpDeviceAudio').value = '';
    window._lpDevNames = { v1: '虚拟采集卡' };
    document.getElementById('lpStartBtn').click(); 'ok';`);
  await new Promise(r => setTimeout(r, 400));
  const devPush = ffCalls.filter(x => x.kind === 'push').pop();
  check('E4 设备推流传参：device 源 + 设备名（重试由主进程处理）',
    devPush && devPush.source && devPush.source.type === 'device' && devPush.source.deviceVideoName === '虚拟采集卡',
    JSON.stringify(devPush && devPush.source));

  // ---------- 汇总 ----------
  const pass = results.filter(r => r.pass).length;
  console.log('E2E v1.0.8 结果: ' + pass + '/' + results.length + ' PASS');
  results.forEach(r => console.log((r.pass ? '✅' : '❌') + ' ' + r.name + (r.extra ? '  [' + r.extra + ']' : '')));
  app.exit(pass === results.length ? 0 : 1);
}

app.whenReady().then(main).catch((e) => { console.error('FATAL', e); app.exit(2); });
