// E2E r57：阿里云三问题修复的确定性回归（mock 云端响应，不依赖真实推流）
//  1) 在线流实时带宽不显示阿里云
//  2) 流质量码率不准（BitRate Bps→kbps 差 8 倍）+ 分辨率不显示
//  3) 直播概览阿里云在线流数只算第一个播放域名
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail || '' }); }
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  const ex = (js) => win.webContents.executeJavaScript(js);
  await ex("localStorage.clear(); (function(){ state.cfg={}; bindWatchPrefs(); bindMonitorPrefs(); })(); 'ok'");

  // ---------- A. 域名语义 + 单位换算 ----------
  const a1 = await ex(`(function(){
    return {
      push: alPushDom({ PushDomain:'tl.gfcnn.cn', PublishDomain:'pl.gfcnn.cn', DomainName:'pl.gfcnn.cn' }),
      fromUrl: alPushDom({ PublishUrl:'rtmp://alylive.gfcnn.com/live/x', PublishDomain:'alyplay.gfcnn.com' }),
      fallback: alPushDom({ PublishDomain:'pl.gfcnn.cn', DomainName:'pl.gfcnn.cn' }),
      kbps: alBitRateToKbps(895958.4),
      zero: alBitRateToKbps(0)
    };
  })()`);
  check('A1 alPushDom 取真推流域名（PushDomain > PublishUrl > 兜底）+ BitRate Bps→kbps ×8',
    a1.push === 'tl.gfcnn.cn' && a1.fromUrl === 'alylive.gfcnn.com' && a1.fallback === 'pl.gfcnn.cn' &&
    a1.kbps === 7168 && a1.zero === 0, JSON.stringify(a1));

  // ---------- B. 在线流合并口径（同推流域名合并 / 不同推流域名不合并）----------
  const b1 = await ex(`(function(){
    var calls = 0;
    window.acall = function (action, params) {
      calls++;
      if (action === 'DescribeLiveUserDomains') return Promise.resolve({ ok:true, data:{ Domains:{ PageData:[
        { DomainName:'pl.gfcnn.cn', LiveDomainType:'liveVideo', LiveDomainStatus:'online' },
        { DomainName:'alyplay.gfcnn.com', LiveDomainType:'liveVideo', LiveDomainStatus:'online' },
        { DomainName:'tl.gfcnn.cn', LiveDomainType:'liveEdge', LiveDomainStatus:'online' },
        { DomainName:'alylive.gfcnn.com', LiveDomainType:'liveEdge', LiveDomainStatus:'online' } ] }, TotalCount:4 } });
      if (action === 'DescribeLiveStreamsOnlineList') {
        // 同一物理流被两个播放域名各返回一次 …… 另一条流只在一个域名下
        if (params.DomainName === 'pl.gfcnn.cn') return Promise.resolve({ ok:true, data:{ OnlineInfo:{ LiveStreamOnlineInfo:[
          { StreamName:'cccc44444', AppName:'live', DomainName:'pl.gfcnn.cn', PlayDomain:'pl.gfcnn.cn', PushDomain:'tl.gfcnn.cn',
            PublishDomain:'pl.gfcnn.cn', PublishUrl:'rtmp://tl.gfcnn.cn/live/cccc44444', Width:1920, Height:1080, FrameRate:50, PublishTime:'2026-09-28T06:35:18Z' } ] } } });
        if (params.DomainName === 'alyplay.gfcnn.com') return Promise.resolve({ ok:true, data:{ OnlineInfo:{ LiveStreamOnlineInfo:[
          { StreamName:'cccc44444', AppName:'live', DomainName:'alyplay.gfcnn.com', PlayDomain:'alyplay.gfcnn.com', PushDomain:'tl.gfcnn.cn',
            PublishDomain:'alyplay.gfcnn.com', PublishUrl:'rtmp://tl.gfcnn.cn/live/cccc44444', Width:1920, Height:1080 },
          { StreamName:'bbbb3333', AppName:'live', DomainName:'alyplay.gfcnn.com', PlayDomain:'alyplay.gfcnn.com', PushDomain:'alylive.gfcnn.com',
            PublishDomain:'alyplay.gfcnn.com', PublishUrl:'rtmp://alylive.gfcnn.com/live/bbbb3333', Width:1920, Height:1080 } ] } } });
        return Promise.resolve({ ok:true, data:{ OnlineInfo:{ LiveStreamOnlineInfo:[] } } });
      }
      return Promise.resolve({ ok:true, data:{} });
    };
    window._ovDomains = [{ Type: 0, Name: 'push.tc.com' }];
    window._ovOnlineCount = 0;
    window._monList = undefined;
    state.connected = true;
    refreshMonitor(true);
    return 'go';
  })()`);
  await wait(3000);
  const b2 = await ex(`(function(){
    var l = window._monList || [];
    return { n: l.length, list: l.map(function(s){ return { S:s.StreamName, push: alPushDom(s), plays:s._alPlayDoms, wh:(s.Width||'')+'x'+(s.Height||'') }; }) };
  })()`);
  check('B1 两条流被两个播放域名重复返回 → 去重后仍是 2 条，且 _alPlayDoms 收齐同域名的两次上报',
    b2.n === 2 && b2.list[0].push === 'tl.gfcnn.cn' && b2.list[0].plays.length === 2 && b2.list[1].push === 'alylive.gfcnn.com',
    JSON.stringify(b2));

  // ---------- C. 带宽页：取真值行 + Bps→kbps + 无数据时仍列流 ----------
  const c1 = await ex(`(function(){
    window.acall = function (action, params) {
      if (action === 'DescribeLiveDomainFrameRateAndBitRateData') {
        if (params.DomainName === 'tl.gfcnn.cn') return Promise.resolve({ ok:true, data:{ FrameRateAndBitRateInfos:{ FrameRateAndBitRateInfo:[
          { VideoFrameRate:0, AudioFrameRate:0, BitRate:0, StreamUrl:'rtmp://tl.gfcnn.cn/live/tl.gfcnn.cn_cccc44444' },
          { VideoFrameRate:0, AudioFrameRate:0, BitRate:0, StreamUrl:'rtmp://tl.gfcnn.cn/live/cccc44444_AliRewrite_1' },
          { VideoFrameRate:49.88, AudioFrameRate:43.05, BitRate:895958.4, StreamUrl:'rtmp://tl.gfcnn.cn/live/cccc44444' } ] } } });
        return Promise.resolve({ ok:true, data:{ FrameRateAndBitRateInfos:{ FrameRateAndBitRateInfo:[] } } });   // 另一路延迟中
      }
      return Promise.resolve({ ok:true, data:{} });
    };
    bwStreamsRefresh();
    return 'go';
  })()`);
  await wait(2500);
  const c2 = await ex(`(function(){
    var out = { keys: Object.keys(_bwGrp), rows: document.getElementById('bwGrpBody').textContent };
    out.grp = Object.keys(_bwGrp).map(function(k){ return _bwGrp[k]; });
    return out;
  })()`);
  const hasReal = !!c2.grp.filter(g => g.name === 'cccc44444' && g.kbps === 7168 && g.fps === 49.9).length;
  const pending = !!c2.grp.filter(g => g.name === 'bbbb3333' && !g.kbps).length;
  check('C1 带宽页：零值占位行被跳过取真值 7168kbps（Bps×8）+ 域名用真推流域名',
    hasReal && c2.grp.filter(g => g.name === 'cccc44444')[0].dom === 'tl.gfcnn.cn', JSON.stringify(c2.grp));
  check('C2 带宽页：统计延迟中的流仍列出（不整片消失）',
    pending && c2.rows.indexOf('统计延迟中') >= 0 && c2.keys.length === 2, c2.rows.slice(0, 160));

  // ---------- D. 质量页：码率 ×8 + 分辨率取云端 Width/Height（不依赖 ffprobe）----------
  const d1 = await ex(`(function(){
    var fl = (window._monList || []).filter(function(s){ return s.StreamName === 'cccc44444'; })[0];
    var key = qCardKey(fl);
    qQueryAliBatch([fl]);
    return key;
  })()`);
  await wait(2500);
  const d2 = await ex(`(function(){
    var key = '${d1}';
    var g = function(sfx){ var el = document.getElementById(key+':'+sfx); return el ? el.textContent : null; };
    return { br: g('br'), vf: g('vf'), res: g('res'), probed: _qAliResProbed[key] || null };
  })()`);
  check('D1 质量卡：码率 7,168（此前 /1000 只有 896）+ 分辨率直接取云端在线流 Width/Height',
    d2.br === '7,168' && d2.res === '1920×1080' && d2.probed === '1920x1080' && d2.vf === '49.9', JSON.stringify(d2));

  // ---------- E. 概览在线流数：逐播放域名查询 + 去重 ----------
  const e1 = await ex(`(function(){ refreshAlOverview(); return 'go'; })()`);
  await wait(2500);
  const e2 = await ex(`(function(){
    return { online: document.getElementById('alStOnline').textContent,
             push: document.getElementById('alStPush').textContent, play: document.getElementById('alStPlay').textContent };
  })()`);
  check('E1 阿里云概览在线流 = 2（逐播放域名查询后按推流域名+流名去重，而非只算第一个域名）',
    e2.online === '2' && e2.play === '2', JSON.stringify(e2));

  const fail = results.filter(r => !r.ok);
  console.log('\n===== E2E r57 结果 =====');
  results.forEach(r => console.log((r.ok ? '✅' : '❌') + ' ' + r.name + (r.ok ? '' : '  → ' + r.detail)));
  console.log(fail.length ? 'FAIL: ' + fail.length + ' 项' : 'ALL PASS: ' + results.length + ' 项');
  app.exit(fail.length ? 1 : 0);
}
app.whenReady().then(main).catch(e => { console.error('FATAL', e); app.exit(2); });
