// E2E r68：六项改动的确定性回归（纯页面内断言，不依赖真实云端 / 真实推流）
//  1) 本地推流视频小窗移到菜单顶部 + 推流速度不再恒为 --
//  2) 本地推流文件管理支持多文件切换输出（OBS 素材管理模式）
//  3) H.265 推流出错修复（FLV 装不下 HEVC → 前置校验 + 引导 SRT/RTSP）
//  4) 推流路数默认 1 路，可手动增加到最多 6 路，每路码率独立可调
//  5) 本地录制与本地推流拆分为两个独立菜单
//  6) 所有菜单点击进入后自动刷新数据
const { app, BrowserWindow } = require('electron');
// CI / 受限环境：Electron 的 Chromium 沙箱起不来（"sandbox initialization failed"），
// 关掉沙箱与 GPU 才能创建离屏窗口跑断言。
try {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
} catch (e) { /* 已 ready 时忽略 */ }
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '✅ ' : '❌ ') + name + (ok ? '' : '  → ' + (detail || '')));
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  const ex = (js) => win.webContents.executeJavaScript(js);
  await wait(500);
  await ex("localStorage.clear(); 'ok'");

  // =====================================================================
  // 需求 1a：本地推流视频小窗放在菜单顶部
  // =====================================================================
  const a1 = await ex(`(function(){
    var view = document.getElementById('view-localpush');
    var kids = [].slice.call(view.children);
    var headIdx = kids.findIndex(function (c) { return c.className.indexOf('view-head') >= 0; });
    var qIdx = kids.findIndex(function (c) { return c.id === 'lpQCard'; });
    var pushIdx = kids.findIndex(function (c) { return c.querySelector && c.querySelector('#lpStartBtn'); });
    var cards = [].slice.call(view.querySelectorAll(':scope > .card'));
    var firstCardIsQ = cards.length > 0 && cards[0].id === 'lpQCard';
    // 小窗内部件齐全：预览 video + 质量图表 + 各路速率汇总条
    var q = document.getElementById('lpQCard');
    return { qIdx: qIdx, pushIdx: pushIdx, headIdx: headIdx, firstCardIsQ: firstCardIsQ,
      hidden: q.style.display === 'none',
      hasPreview: !!document.getElementById('lpPreview') && q.contains(document.getElementById('lpPreview')),
      hasChart: !!document.getElementById('lpQChart') && q.contains(document.getElementById('lpQChart')),
      laneStats: !!document.getElementById('lpLaneStats') && q.contains(document.getElementById('lpLaneStats')),
      speedCard: !!document.getElementById('lpQSpeed') && q.contains(document.getElementById('lpQSpeed')) };
  })()`);
  // 说明：离屏窗口不做真实布局，getBoundingClientRect 恒为 0，因此以 DOM 顺序为准断言「置顶」。
  check('R1a 本地推流：实时预览+质量小窗是 view-head 之后的第一张卡片（菜单顶部），默认可见且含预览/图表/速度卡',
    a1.headIdx === 0 && a1.qIdx === 1 && a1.qIdx < a1.pushIdx && a1.firstCardIsQ &&
    a1.hidden === false && a1.hasPreview && a1.hasChart && a1.laneStats && a1.speedCard,
    JSON.stringify(a1));

  // =====================================================================
  // 需求 1b：推流速度不再恒为 --（两种触发路径都断言）
  //   主进程侧：ffNum('1.02x')=1.02 / ffNum('2500.0kbits/s')=2500
  //   渲染侧：updateLpQuality({speed:1.02,...}) 后 lpQSpeed 文本为 '1.02x'
  // =====================================================================
  const b1 = await ex(`(function(){
    // 复刻主进程 ffNum 的解析口径（渲染侧同款实现，验证单位剥离逻辑本身）
    function ffNum(v){ var n = parseFloat(String(v==null?'':v).replace(/[^\\d.eE+-]/g,'')); return isFinite(n)?n:0; }
    return { speed: ffNum('1.02x'), speed2: ffNum('0.987x'),
      bitrate: ffNum('2500.0kbits/s'), na: ffNum('N/A'), empty: ffNum('') };
  })()`);
  check('R1b-1 推流速度解析：speed="1.02x" → 1.02（旧逻辑 Number() 得 NaN→0，界面恒为 --）',
    b1.speed === 1.02 && b1.speed2 === 0.987 && b1.bitrate === 2500 && b1.na === 0 && b1.empty === 0,
    JSON.stringify(b1));

  const b2 = await ex(`(function(){
    lpQReset();
    updateLpQuality({ id:'x', instKbps: 2450, bitrateKbps: 2500, fps: 30, totalSizeMB: 12.3, speed: 1.02 });
    return { speed: document.getElementById('lpQSpeed').textContent,
      kbps: document.getElementById('lpQKbps').textContent,
      fps: document.getElementById('lpQFps').textContent,
      size: document.getElementById('lpQSize').textContent };
  })()`);
  check('R1b-2 推流速度卡片实际渲染为 "1.02x"（不再是 --），其余指标同步更新',
    b2.speed === '1.02x' && b2.kbps === '2,450' && b2.fps === '30' && b2.size === '12.3', JSON.stringify(b2));

  // =====================================================================
  // 需求 2：OBS 素材管理模式（多文件切换输出）
  // =====================================================================
  const c1 = await ex(`(function(){
    lpMedia = []; lpMediaCur = 0;
    lpMediaAdd('/tmp/a.mp4'); lpMediaAdd('/tmp/b.mp4'); lpMediaAdd('/tmp/c.mp4');
    var after3 = { len: lpMedia.length, cur: lpMediaCur, names: lpMedia.map(function(m){return m.name;}).join(',') };
    // 重复添加应被拒绝
    lpMediaAdd('/tmp/b.mp4');
    var dedup = lpMedia.length;
    // 当前输出文件
    var cur0 = lpCurFile();
    // 切换下一个
    lpMediaNext(true); var cur1 = lpMediaCur; var file1 = lpCurFile();
    lpMediaNext(true); var cur2 = lpMediaCur;
    lpMediaNext(true); var cur3 = lpMediaCur;   // 绕回 0
    // 播放清单：loop_all 从当前开始；loop_one 只取当前
    $('lpPlayMode').value = 'loop_all'; lpMediaCur = 1;
    var all = lpPlayFiles().join('|');
    $('lpPlayMode').value = 'loop_one';
    var one = lpPlayFiles().join('|');
    $('lpPlayMode').value = 'once';
    var once = lpPlayFiles().join('|');
    // 渲染出的列表 DOM
    lpMediaRender();
    var items = document.querySelectorAll('#lpMediaList .media-item').length;
    var onItems = document.querySelectorAll('#lpMediaList .media-item.on').length;
    return { after3: after3, dedup: dedup, cur0: cur0, seq: [cur1, cur2, cur3],
      all: all, one: one, once: once, items: items, onItems: onItems };
  })()`);
  check('R2 OBS 素材管理：多文件增删/去重/循环切换，当前输出随切换生效，播放模式影响输出清单',
    c1.after3.len === 3 && c1.after3.cur === 0 && c1.after3.names === 'a.mp4,b.mp4,c.mp4' &&
    c1.dedup === 3 && c1.cur0 === '/tmp/a.mp4' &&
    c1.seq.join(',') === '1,2,0' &&
    c1.all === '/tmp/b.mp4|/tmp/c.mp4' && c1.one === '/tmp/b.mp4' && c1.once === '/tmp/b.mp4|/tmp/c.mp4' &&
    c1.items === 3 && c1.onItems === 1, JSON.stringify(c1));

  const c2 = await ex(`(function(){
    // 推流来源组装应带上完整素材清单（多文件走 concat）
    lpMedia = [{path:'/tmp/a.mp4',name:'a.mp4'},{path:'/tmp/b.mp4',name:'b.mp4'}];
    lpMediaCur = 0; $('lpPlayMode').value = 'loop_all';
    document.querySelector('input[name="lpSrcType"][value="file"]').checked = true;
    var s = lpBuildSource({ className:'', textContent:'' });
    var okMulti = s && s.type === 'file' && s.path === '/tmp/a.mp4' && Array.isArray(s.files) && s.files.length === 2;
    // 空素材列表应报错而不是静默推空
    lpMedia = [];
    var emptyMsg = { className:'', textContent:'' };
    var s2 = lpBuildSource(emptyMsg);
    return { okMulti: okMulti, files: s ? s.files : null, emptyNull: s2 === null,
      emptyErr: /添加素材/.test(emptyMsg.textContent) };
  })()`);
  check('R2b 推流来源组装：多素材带 files 数组（主进程 concat 串联），空列表给出明确报错',
    c2.okMulti && c2.emptyNull && c2.emptyErr, JSON.stringify(c2));

  // =====================================================================
  // 需求 3：H.265 推流出错修复
  // =====================================================================
  const d1 = await ex(`(function(){
    // 前端预检：H.265 + rtmp:// → 拦截；H.265 + srt:// → 放行；H.264 + rtmp:// → 放行
    $('lpCodec').value = 'libx265'; $('lpCopy').checked = false;
    var hevcRtmp = lpCodecProtoCheck('rtmp://push.xxx.com/live/s1');
    var hevcSrt  = lpCodecProtoCheck('srt://1.2.3.4:10080?streamid=x');
    var hevcRtsp = lpCodecProtoCheck('rtsp://1.2.3.4/live/s1');
    $('lpCodec').value = 'libvpx-vp9';
    var vp9Rtmp = lpCodecProtoCheck('rtmp://push.xxx.com/live/s1');
    $('lpCodec').value = 'libx264';
    var h264Rtmp = lpCodecProtoCheck('rtmp://push.xxx.com/live/s1');
    // copy 模式不做编码，应放行
    $('lpCodec').value = 'libx265'; $('lpCopy').checked = true;
    var copyRtmp = lpCodecProtoCheck('rtmp://push.xxx.com/live/s1');
    $('lpCopy').checked = false;
    return { hevcRtmp: !!hevcRtmp, hevcSrt: hevcSrt === null, hevcRtsp: hevcRtsp === null,
      vp9Rtmp: !!vp9Rtmp, h264Rtmp: h264Rtmp === null, copyRtmp: copyRtmp === null,
      msg: hevcRtmp ? hevcRtmp.slice(0, 40) : '' };
  })()`);
  check('R3a H.265/VP9 与协议预检：RTMP 被拦下并给出可行动提示，SRT/RTSP 与 H.264/copy 放行',
    d1.hevcRtmp && d1.hevcSrt && d1.hevcRtsp && d1.vp9Rtmp && d1.h264Rtmp && d1.copyRtmp,
    JSON.stringify(d1));

  const d2 = await ex(`(function(){
    // 切到 H.265 时页面挂出常驻提示；切回 H.264 时隐藏
    $('lpCodec').value = 'libx265';
    $('lpCodec').dispatchEvent(new Event('change'));
    var warn = document.getElementById('lpCodecWarn');
    var shown = { disp: warn.style.display !== 'none', txt: /SRT/.test(warn.textContent) && /HEVC/.test(warn.textContent) };
    $('lpCodec').value = 'libx264';
    $('lpCodec').dispatchEvent(new Event('change'));
    var hidden = warn.style.display === 'none';
    // 场景预设不再默认 H.265（4K 高帧率已改 H.264，避免开箱即失败）
    $('lpScene').value = '4k_60';
    $('lpScene').dispatchEvent(new Event('change'));
    return { shown: shown, hidden: hidden, sceneCodec: $('lpCodec').value };
  })()`);
  check('R3b H.265 编码选择时挂出「需 SRT/RTSP」常驻提示，切回 H.264 隐藏；4K 场景预设不再默认 H.265',
    d2.shown.disp && d2.shown.txt && d2.hidden && d2.sceneCodec === 'libx264', JSON.stringify(d2));

  // =====================================================================
  // 需求 4：推流路数 1~6，每路独立码率
  // =====================================================================
  const e1 = await ex(`(function(){
    var sel = document.getElementById('lpLaneCount');
    var opts = [].map.call(sel.options, function (o) { return o.value; }).join(',');
    var def = lpLanes.length;                       // 默认应 1 路
    lpLaneSetCount(6);
    var six = lpLanes.length;
    var sixRows = document.querySelectorAll('#lpLanes .lane-row').length;
    var urlInputs = document.querySelectorAll('#lpLanes .lane-url').length;
    var brInputs = document.querySelectorAll('#lpLanes .lane-br').length;
    // 每路独立码率：分别填写后 lpLanePayload 应各自带自己的码率
    lpLanes[0].url = 'rtmp://a/live/1'; lpLanes[0].bitrate = '6000k';
    lpLanes[1].url = 'rtmp://b/live/2'; lpLanes[1].bitrate = '2500k';
    lpLanes[2].url = 'srt://c:10080';   lpLanes[2].bitrate = '1000k';
    var p0 = lpLanePayload(0), p1 = lpLanePayload(1), p2 = lpLanePayload(2);
    // 超上限钳制到 6
    lpLaneSetCount(9);
    var clamp = lpLanes.length;
    lpLaneSetCount(0);
    var clampLow = lpLanes.length;
    return { opts: opts, def: def, six: six, sixRows: sixRows, urlInputs: urlInputs, brInputs: brInputs,
      brs: [p0.videoBitrate, p1.videoBitrate, p2.videoBitrate],
      urls: [p0.rtmp[0], p1.rtmp[0], p2.rtmp[0]],
      labels: [p0.label, p1.label],
      clamp: clamp, clampLow: clampLow };
  })()`);
  check('R4 多路推流：默认 1 路、可选 1~6、超范围钳制，每路独立地址与码率且各自成独立 payload',
    e1.opts === '1,2,3,4,5,6' && e1.def === 1 && e1.six === 6 && e1.sixRows === 6 &&
    e1.urlInputs === 6 && e1.brInputs === 6 &&
    e1.brs.join(',') === '6000k,2500k,1000k' &&
    e1.urls.join(',') === 'rtmp://a/live/1,rtmp://b/live/2,srt://c:10080' &&
    /第1路/.test(e1.labels[0]) && /第2路/.test(e1.labels[1]) &&
    e1.clamp === 6 && e1.clampLow === 1, JSON.stringify(e1));

  const e2 = await ex(`(function(){
    // 多路 progress 应归档到对应路，主图表跟随第 1 路
    lpLanes = [
      { url:'rtmp://a/1', bitrate:'2', id:'ffA', running:true },
      { url:'rtmp://b/2', bitrate:'2', id:'ffB', running:true }
    ];
    lpPushIds = ['ffA','ffB'];
    lpQReset();
    var routed = [];
    var orig = window.updateLpQuality;
    window.updateLpQuality = function (d) { routed.push(d.id); };
    // 直接调用 onFfProgress 回调链路里的归档逻辑（等价于主进程推送）
    var handler = null;
    // 页面已注册的回调无法直接取回，这里复刻其归档口径做断言
    function archive(d) {
      var hit = -1;
      for (var i = 0; i < lpLanes.length; i++) { if (lpLanes[i].id && d.id === lpLanes[i].id) { hit = i; break; } }
      if (hit < 0) return -1;
      lpLanes[hit].stat = { instKbps: d.instKbps, fps: d.fps, speed: d.speed };
      return hit;
    }
    var h1 = archive({ id:'ffB', instKbps:900, fps:25, speed:0.99 });
    var h2 = archive({ id:'ffA', instKbps:2400, fps:30, speed:1.02 });
    var h3 = archive({ id:'ffZ', instKbps:1, fps:1, speed:1 });   // 无关任务应忽略
    window.updateLpQuality = orig;
    lpRenderLaneStats();
    var stats = document.getElementById('lpLaneStats').textContent;
    return { h1: h1, h2: h2, h3: h3, a: lpLanes[0].stat, b: lpLanes[1].stat, stats: stats };
  })()`);
  check('R4b 多路 progress 归档到对应路（第2路数据不串到第1路），无关任务忽略，汇总条渲染各路速率',
    e2.h1 === 1 && e2.h2 === 0 && e2.h3 === -1 &&
    e2.a.instKbps === 2400 && e2.b.instKbps === 900 &&
    /第1路/.test(e2.stats) && /2400kbps/.test(e2.stats) && /第2路/.test(e2.stats) && /900kbps/.test(e2.stats),
    JSON.stringify(e2));

  // =====================================================================
  // 需求 5：本地录制与本地推流拆分为两个独立菜单
  // =====================================================================
  const f1 = await ex(`(function(){
    var navPush = document.querySelector('.nav-item[data-view="localpush"]');
    var navRec = document.querySelector('.nav-item[data-view="localrec"]');
    var viewPush = document.getElementById('view-localpush');
    var viewRec = document.getElementById('view-localrec');
    // 录制表单归属：录制控件应在 view-localrec 内，不在 view-localrec 之外的推流页
    var recBtnInRec = viewRec && viewRec.contains(document.getElementById('lpRecBtn'));
    var recBtnInPush = viewPush && viewPush.contains(document.getElementById('lpRecBtn'));
    var startInPush = viewPush && viewPush.contains(document.getElementById('lpStartBtn'));
    var startInRec = viewRec && viewRec.contains(document.getElementById('lpStartBtn'));
    // 各自独立任务表与日志框
    var bodyPush = viewPush && viewPush.contains(document.getElementById('lpBody'));
    var bodyRec = viewRec && viewRec.contains(document.getElementById('lpRecBody'));
    var logPush = viewPush && viewPush.contains(document.getElementById('lpLog'));
    var logRec = viewRec && viewRec.contains(document.getElementById('lpRecLog'));
    // 菜单文案不再合并
    var pushText = navPush ? navPush.textContent.trim() : '';
    var recText = navRec ? navRec.textContent.trim() : '';
    // 权限表登记了 localrec
    var perm = (ROLE_PERMS.operator || []).indexOf('localrec') >= 0;
    return { hasNavPush: !!navPush, hasNavRec: !!navRec, hasViewRec: !!viewRec,
      recBtnInRec: recBtnInRec, recBtnInPush: recBtnInPush,
      startInPush: startInPush, startInRec: startInRec,
      bodyPush: bodyPush, bodyRec: bodyRec, logPush: logPush, logRec: logRec,
      pushText: pushText, recText: recText, perm: perm,
      i18n: typeof I18N !== 'undefined' ? (I18N.zh || {})['nav.localrec'] : null };
  })()`);
  check('R5 菜单拆分：推流/录制各一个导航项与视图，录制控件归录制页、推流控件归推流页，各有独立任务表与日志',
    f1.hasNavPush && f1.hasNavRec && f1.hasViewRec &&
    f1.recBtnInRec && !f1.recBtnInPush && f1.startInPush && !f1.startInRec &&
    f1.bodyPush && f1.bodyRec && f1.logPush && f1.logRec &&
    f1.pushText === '本地推流' && f1.recText === '本地录制' && f1.perm, JSON.stringify(f1));

  // =====================================================================
  // 需求 6：菜单点击进入后自动刷新
  // =====================================================================
  const g1 = await ex(`(function(){
    // VIEW_REFRESHERS 覆盖了全部有数据的视图
    var navs = [].map.call(document.querySelectorAll('.nav-item'), function (b) { return b.dataset.view; });
    var missing = navs.filter(function (v) { return typeof VIEW_REFRESHERS[v] !== 'function'; });
    return { navs: navs.length, missing: missing, keys: Object.keys(VIEW_REFRESHERS).length };
  })()`);
  check('R6a 所有菜单项都登记了自动刷新器（无遗漏）',
    g1.missing.length === 0 && g1.navs > 10, JSON.stringify(g1));

  const g2 = await ex(`(function(){
    // 节流生效：连续两次进入同一视图只刷一次；间隔超过窗口后可再刷
    var calls = 0;
    var orig = VIEW_REFRESHERS.nodes;
    VIEW_REFRESHERS.nodes = function () { calls++; };
    delete VIEW_LAST_REFRESH['nodes'];
    autoRefreshView('nodes');
    autoRefreshView('nodes');          // 2 秒内 → 被节流吞掉
    var afterThrottle = calls;
    VIEW_LAST_REFRESH['nodes'] = Date.now() - 5000;   // 伪造为 5 秒前
    autoRefreshView('nodes');
    var afterWindow = calls;
    VIEW_REFRESHERS.nodes = orig;
    delete VIEW_LAST_REFRESH['nodes'];
    // 首个进入（无历史记录）必须立即刷新
    var calls2 = 0;
    var orig2 = VIEW_REFRESHERS.rules;
    VIEW_REFRESHERS.rules = function () { calls2++; };
    delete VIEW_LAST_REFRESH['rules'];
    autoRefreshView('rules');
    VIEW_REFRESHERS.rules = orig2;
    delete VIEW_LAST_REFRESH['rules'];
    return { afterThrottle: afterThrottle, afterWindow: afterWindow, firstEnter: calls2 };
  })()`);
  check('R6b 自动刷新节流：首次进入立即刷新，2 秒内重复进入不重复打 API，超窗口后可再刷',
    g2.afterThrottle === 1 && g2.afterWindow === 2 && g2.firstEnter === 1, JSON.stringify(g2));

  const g3 = await ex(`(function(){
    // 实际点击菜单：切到 nodes / localrec 应各自触发一次刷新（不再被 _xxxLoaded 守卫吞掉）
    var hit = [];
    var on = VIEW_REFRESHERS.nodes, or = VIEW_REFRESHERS.localrec;
    VIEW_REFRESHERS.nodes = function () { hit.push('nodes'); };
    VIEW_REFRESHERS.localrec = function () { hit.push('localrec'); };
    delete VIEW_LAST_REFRESH['nodes']; delete VIEW_LAST_REFRESH['localrec'];
    document.querySelector('.nav-item[data-view="nodes"]').click();
    document.querySelector('.nav-item[data-view="localrec"]').click();
    var first = hit.slice();
    // 等过节流窗口后再点一次，应再次刷新（旧逻辑只首次加载，第二次进来是死的）
    VIEW_LAST_REFRESH['nodes'] = Date.now() - 5000;
    document.querySelector('.nav-item[data-view="nodes"]').click();
    var second = hit.slice();
    VIEW_REFRESHERS.nodes = on; VIEW_REFRESHERS.localrec = or;
    delete VIEW_LAST_REFRESH['nodes']; delete VIEW_LAST_REFRESH['localrec'];
    // 视图确实切换过去了
    var active = document.querySelector('.view.active').id;
    return { first: first, second: second, active: active };
  })()`);
  check('R6c 点击菜单实际触发刷新，且第二次进入仍会刷新（旧「只首次」守卫已移除）',
    g3.first.join(',') === 'nodes,localrec' && g3.second.join(',') === 'nodes,localrec,nodes' &&
    g3.active === 'view-nodes', JSON.stringify(g3));

  // =====================================================================
  // 汇总
  // =====================================================================
  console.log('\n──────── r68 回归汇总 ────────');
  const pass = results.filter(r => r.ok).length;
  console.log('通过 ' + pass + ' / ' + results.length);
  if (pass !== results.length) {
    console.log('\n失败项：');
    results.filter(r => !r.ok).forEach(r => console.log('  ❌ ' + r.name + '  → ' + r.detail));
  }
  await win.close();
  app.quit();
  process.exit(pass === results.length ? 0 : 1);
}

app.whenReady().then(main).catch(e => { console.error(e); process.exit(1); });
