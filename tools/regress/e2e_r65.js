// E2E r65：断流 / 质量波动报警改造的确定性回归
//  A. 报警弹窗多实例：每一路断流一个独立卡片，纵向堆叠，不再互相覆盖（旧实现单例覆盖 → 只看到最后一路）
//  B. pushAlarm 去重口径：同类同内容「时间窗」去重（旧实现一旦出现过就永久吞掉，恢复后再断不再报）
//  C. 真实断流链路：mock 在线流接口，3 路 → 1 路，应产生 2 条告警 + 2 个独立弹窗且流名各不相同
//  D. 流质量波动判定：稳定不报 / 码率峰谷比超阈值报 warn 弹窗 / 冷却期内不重复 / 开关关闭不报
//  E. 消息中心排版：条目带云商 / 流名 / 指标标签，warn 用橙色
//  F. 报警开关：勾选写入配置，重开应用按配置回填
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  → ' + (detail || '')));
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1500, height: 950, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  const ex = (js) => win.webContents.executeJavaScript(js);
  await wait(500);
  await ex("localStorage.clear(); (function(){ state.cfg={}; enterApp(false); closeAllAlarmModals(); })(); 'ok'");
  await wait(200);

  // ---------- A. 报警弹窗多实例 ----------
  await ex(`(function(){
    closeAllAlarmModals();
    // 模拟同一轮轮询里三路流同时断开
    [['s_alpha','腾讯云'],['s_beta','腾讯云'],['s_gamma','阿里云']].forEach(function(p){
      pushAlarm('在线流断开', '流「'+p[0]+'」（'+p[1]+'）已停止推流',
        { popup:true, toast:true, stream:p[0], cloud:p[1], level:'danger' });
    });
    return 'ok';
  })()`);
  await wait(300);
  const multi = await ex(`(function(){
    var stack=document.getElementById('alarmStack');
    var layer=document.getElementById('alarmModalMask');
    var cards=[].slice.call(stack.querySelectorAll('.alarm-modal'));
    return {
      n: cards.length,
      layerDisplay: getComputedStyle(layer).display,
      bar: (document.getElementById('alarmBarTxt')||{}).textContent,
      barDisplay: getComputedStyle(document.querySelector('.alarm-bar')).display,
      texts: cards.map(function(c){ return (c.querySelector('.alarm-text')||{}).textContent; }),
      widths: cards.map(function(c){ return Math.round(c.getBoundingClientRect().width); }),
      titleFs: cards.map(function(c){ return getComputedStyle(c.querySelector('.alarm-type')).fontSize; }),
      textFs: cards.map(function(c){ return getComputedStyle(c.querySelector('.alarm-text')).fontSize; }),
      chips: cards.map(function(c){ return [].slice.call(c.querySelectorAll('.alarm-chip')).map(function(x){return x.textContent;}).join(','); }),
      // 堆叠：每张卡的 y 依次递增（不是重叠在同一个位置）
      ys: cards.map(function(c){ return Math.round(c.getBoundingClientRect().y); })
    };
  })()`);
  check('A 三路断流 → 3 个独立弹窗（旧实现只有 1 个，后一条覆盖前一条）', multi.n === 3, JSON.stringify(multi));
  check('A 遮罩层可见（display:flex）', multi.layerDisplay === 'flex', JSON.stringify(multi.layerDisplay));
  check('A 三张卡内容各自对应一路流', multi.texts.length === 3 &&
    multi.texts[0].indexOf('s_alpha') >= 0 && multi.texts[1].indexOf('s_beta') >= 0 && multi.texts[2].indexOf('s_gamma') >= 0,
    JSON.stringify(multi.texts));
  check('A 卡片纵向堆叠（y 递增，不是重叠）', multi.ys.length === 3 && multi.ys[1] > multi.ys[0] && multi.ys[2] > multi.ys[1], JSON.stringify(multi.ys));
  check('A 卡片宽度 ≥ 560px（沿用 r62 定下的大尺寸）', multi.widths.every(function (w) { return w >= 560; }), JSON.stringify(multi.widths));
  check('A 字号：标题 ≥ 19px、正文 ≥ 15px', multi.titleFs.every(function (v) { return parseFloat(v) >= 19; }) &&
    multi.textFs.every(function (v) { return parseFloat(v) >= 15; }), JSON.stringify({ t: multi.titleFs, x: multi.textFs }));
  check('A 汇总条显示待处理条数（共 3 条）', multi.barDisplay === 'flex' && (multi.bar || '').indexOf('共 3 条') >= 0, JSON.stringify({ bar: multi.bar, d: multi.barDisplay }));
  check('A 每条卡片带 流名/云商/时间 标签', multi.chips.length === 3 &&
    multi.chips[0].indexOf('流名 s_alpha') >= 0 && multi.chips[0].indexOf('云商 腾讯云') >= 0 && multi.chips[0].indexOf('时间 ') >= 0,
    JSON.stringify(multi.chips));

  // 关闭行为：单独关一条只关自己；「全部关闭」清空
  const closeOne = await ex(`(function(){
    var stack=document.getElementById('alarmStack');
    stack.children[1].querySelector('.alarm-ok').click();
    return { n: document.querySelectorAll('#alarmStack .alarm-modal').length,
      bar: document.getElementById('alarmBarTxt').textContent,
      left: [].slice.call(document.querySelectorAll('#alarmStack .alarm-text')).map(function(x){return x.textContent;}) };
  })()`);
  check('A 单独关闭一条：只关掉被点的那条（剩 2）', closeOne.n === 2 && /共\s*2\s*条/.test(closeOne.bar) &&
    closeOne.left.join('|').indexOf('s_beta') < 0, JSON.stringify(closeOne));
  const closeAll = await ex(`(function(){
    closeAllAlarmModals();
    var l=document.getElementById('alarmModalMask');
    return { n: document.querySelectorAll('#alarmStack .alarm-modal').length, d: getComputedStyle(l).display };
  })()`);
  check('A 全部关闭：清空且遮罩隐藏', closeAll.n === 0 && closeAll.d === 'none', JSON.stringify(closeAll));

  // ---------- B. pushAlarm 时间窗去重（旧实现永久去重） ----------
  const dedupe = await ex(`(function(){
    state.cfg.alarms=[];
    var t='流「dup1」（腾讯云）已停止推流';
    var a1=pushAlarm('在线流断开', t, {});                       // 首次应入列
    var a2=pushAlarm('在线流断开', t, {});                       // 窗口内重复应被吞
    // 把该条的时间戳改到 10 分钟前（等价于「恢复后又断了一次」），再报应重新入列
    state.cfg.alarms[0].ts = Date.now() - 10*60*1000;
    var a3=pushAlarm('在线流断开', t, {});
    return { n: state.cfg.alarms.length, a1:a1, a2:a2, a3:a3 };
  })()`);
  check('B 时间窗去重：窗口内重复不入列（第二次返回 false，n 不变）',
    dedupe.n === 2 && dedupe.a1 === true && dedupe.a2 === false, JSON.stringify(dedupe));
  check('B 超出时间窗后可再次报警（旧实现会永久吞掉，现可重新入列）', dedupe.n === 2 && dedupe.a3 === true, JSON.stringify(dedupe));

  // ---------- C. 真实断流链路：mock 在线流接口 ----------
  await ex(`(function(){
    state.cfg.alarms=[]; state.cfg.monAlarm=true; state.cfg.aliId=''; state.cfg.aliKey='';
    state.connected=true; window._ovDomains=[]; window._ovOnlineCount=0;
    window._monPrevNames=null; window._monVanished=null; window._monBaselineKey=null;
    closeAllAlarmModals();
    window.__monOnline=[
      {StreamName:'live_a',AppName:'live',DomainName:'push1.com',PublishTime:'2026-09-29 10:00:00'},
      {StreamName:'live_b',AppName:'live',DomainName:'push1.com',PublishTime:'2026-09-29 10:00:00'},
      {StreamName:'live_c',AppName:'live',DomainName:'push1.com',PublishTime:'2026-09-29 10:00:00'}
    ];
    window.api=function(action,payload){
      if(action==='DescribeLiveStreamOnlineList')
        return Promise.resolve({ok:true,data:{OnlineInfo:(window.__monOnline||[]).slice(),TotalNum:(window.__monOnline||[]).length}});
      return Promise.resolve({ok:true,data:{}});
    };
    refreshMonitor(false);
    return 'ok';
  })()`);
  await wait(500);
  await ex(`(function(){
    // 第二轮：只剩 live_a，另外两路应各自弹一个窗
    window.__monOnline=[{StreamName:'live_a',AppName:'live',DomainName:'push1.com',PublishTime:'2026-09-29 10:00:00'}];
    refreshMonitor(false);
    return 'ok';
  })()`);
  await wait(600);
  const disc = await ex(`(function(){
    return {
      alarms: (state.cfg.alarms||[]).map(function(a){ return {type:a.type, text:a.text, stream:a.stream, cloud:a.cloud}; }),
      popups: [].slice.call(document.querySelectorAll('#alarmStack .alarm-modal')).map(function(c){
        return (c.querySelector('.alarm-text')||{}).textContent;
      }),
      layer: getComputedStyle(document.getElementById('alarmModalMask')).display
    };
  })()`);
  check('C 3 路 → 1 路：产生 2 条断流告警（live_b / live_c）',
    disc.alarms.length === 2 && disc.alarms.every(function (a) { return a.type === '在线流断开'; }) &&
    disc.alarms.map(function (a) { return a.stream; }).sort().join(',') === 'live_b,live_c', JSON.stringify(disc.alarms));
  check('C 两路断流各弹一个独立弹窗（共 2 个，内容不同）',
    disc.popups.length === 2 && disc.popups[0] !== disc.popups[1] &&
    disc.popups.join('|').indexOf('live_b') >= 0 && disc.popups.join('|').indexOf('live_c') >= 0, JSON.stringify(disc.popups));
  check('C 告警带流名与云商字段', disc.alarms.every(function (a) { return !!a.stream && !!a.cloud; }), JSON.stringify(disc.alarms));

  // ---------- D. 流质量波动判定 ----------
  const fluct = await ex(`(function(){
    closeAllAlarmModals(); state.cfg.alarms=[]; state.cfg.qFluctAlarm=true;
    var base=Date.now();
    // ① 稳定：6 次采样都是 2000kbps / 30fps → 不告警
    var stable=null;
    for(var i=0;i<6;i++) stable = qFluctCheck('k:stable','st','腾讯云',2000,30, base-(6-i)*10000);
    var nStable=state.cfg.alarms.length;
    // ② 码率剧烈波动：900 → 2700（峰谷比 3 倍，差 1800kbps）→ 告警
    var vals=[1000,1050,1100,2600,2700,900];
    var hit=null;
    for(var j=0;j<6;j++) hit = qFluctCheck('k:up','up','腾讯云',vals[j],30, base+ (j+1)*10000);
    var nHit=state.cfg.alarms.length;
    var last=state.cfg.alarms[0]||{};
    var popups=[].slice.call(document.querySelectorAll('#alarmStack .alarm-modal'));
    var warnCls = popups.length ? popups[0].className : '';
    var warnColor = popups.length ? getComputedStyle(popups[0].querySelector('.alarm-type')).color : '';
    // ③ 冷却期内再喂一波同样的数据 → 不新增
    for(var k=0;k<6;k++) qFluctCheck('k:up','up','腾讯云',vals[k],30, base+ 100000 + k*10000);
    var nCool=state.cfg.alarms.length;
    // ④ 帧率波动（码率稳定、帧率 8 → 30）→ 告警
    state.cfg.alarms=[];
    for(var m=0;m<6;m++) qFluctCheck('k:fps','fps','阿里云',2000,[30,30,30,8,9,30][m], base+ 300000 + m*10000);
    var nFps=state.cfg.alarms.length;
    var fpsAlarm=state.cfg.alarms[0]||{};
    // ⑤ 开关关闭 → 不告警
    state.cfg.alarms=[]; state.cfg.qFluctAlarm=false;
    for(var q=0;q<6;q++) qFluctCheck('k:off','off','腾讯云',vals[q],30, base+ 500000 + q*10000);
    var nOff=state.cfg.alarms.length;
    state.cfg.qFluctAlarm=true;
    return { stable:stable, nStable:nStable, hit:hit, nHit:nHit,
      lastType:last.type, lastLevel:last.level, lastMetric:last.metric, lastText:last.text,
      warnCls:warnCls, warnColor:warnColor, nCool:nCool, nFps:nFps, fpsMetric:fpsAlarm.metric, nOff:nOff };
  })()`);
  check('D 稳定采样不告警（6×2000kbps / 30fps）', fluct.stable === null && fluct.nStable === 0, JSON.stringify(fluct));
  check('D 码率峰谷比 3 倍 → 命中波动并弹窗', fluct.nHit === 1 && fluct.lastType === '流质量波动' &&
    fluct.lastMetric === '码率' && fluct.lastText.indexOf('up') >= 0, JSON.stringify(fluct));
  check('D 波动弹窗为 warn 橙色样式（区别于断流红色）',
    /warn/.test(fluct.warnCls) && fluct.warnColor !== 'rgb(248, 113, 113)', JSON.stringify({ c: fluct.warnCls, col: fluct.warnColor }));
  check('D 冷却期内不重复告警（同一路流 3 分钟一次）', fluct.nCool === 1, JSON.stringify(fluct.nCool));
  check('D 帧率剧烈波动也能命中', fluct.nFps === 1 && fluct.fpsMetric === '视频帧率', JSON.stringify(fluct));
  check('D 关闭「质量波动报警」后不再告警', fluct.nOff === 0, JSON.stringify(fluct.nOff));

  // ---------- E. 消息中心排版 ----------
  const ntf = await ex(`(function(){
    closeAllAlarmModals();
    state.cfg.alarms=[];
    pushAlarm('在线流断开','流「e1」（腾讯云）已停止推流',{stream:'e1',cloud:'腾讯云',level:'danger'});
    pushAlarm('流质量波动','流「e2」（阿里云）码率波动过大：900 → 2700 kbps',{stream:'e2',cloud:'阿里云',metric:'码率',level:'warn'});
    renderNotify();
    var items=[].slice.call(document.querySelectorAll('#ntfList .ntf-item'));
    return items.map(function(it){
      return { txt: (it.querySelector('div div:last-child')||{}).textContent,
        tags: [].slice.call(it.querySelectorAll('.tag')).map(function(t){return t.textContent;}),
        typeColor: getComputedStyle(it.querySelector('b')).color };
    });
  })()`);
  check('E 消息条目带云商 / 流名 / 指标标签',
    ntf.length === 2 &&
    (ntf[0].tags||[]).join('|').indexOf('腾讯云') >= 0 && (ntf[0].tags||[]).join('|').indexOf('e1') >= 0 &&
    (ntf[1].tags||[]).join('|').indexOf('阿里云') >= 0 && (ntf[1].tags||[]).join('|').indexOf('码率') >= 0, JSON.stringify(ntf));
  check('E 断流红 / 波动橙（warning 色）区分',
    (ntf[0].typeColor||'').indexOf('113') > 0 && (ntf[1].typeColor||'').indexOf('191, 36') > 0,
    JSON.stringify(ntf.map(function (x) { return x.typeColor; })));

  // ---------- F. 报警开关持久化 + 回填 ----------
  const sw = await ex(`(function(){
    var a=document.getElementById('monAlarmChk'), b=document.getElementById('qFluctChk');
    return { hasA: !!a, hasB: !!b, aVal: a?a.checked:null, bVal: b?b.checked:null,
      sizeA: a?Math.round(a.getBoundingClientRect().width):0 };
  })()`);
  check('F 在线流工具栏有「断流报警」与「质量波动报警」两个开关', sw.hasA && sw.hasB, JSON.stringify(sw));
  check('F 复选框不被 input{width:100%} 拉伸（元素存在且非异常大宽）', sw.hasA && sw.sizeA < 200, JSON.stringify(sw.sizeA));
  const persist = await ex(`(function(){
    var b=document.getElementById('qFluctChk'); b.checked=false; b.dispatchEvent(new Event('change'));
    return { cfg: state.cfg.qFluctAlarm };
  })()`);
  check('F 取消勾选写入配置（qFluctAlarm=false）', persist.cfg === false, JSON.stringify(persist));
  // 重载页面：应按配置回填为未勾选
  await ex(`localStorage.setItem(CFG_KEY, JSON.stringify({monAlarm:false, qFluctAlarm:false})); 'ok'`);
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await wait(600);
  const restored = await ex(`(function(){
    var a=document.getElementById('monAlarmChk'), b=document.getElementById('qFluctChk');
    return { a: a?a.checked:null, b: b?b.checked:null };
  })()`);
  check('F 重开应用按配置回填勾选状态（此前只写不读会丢）',
    restored.a === false && restored.b === false, JSON.stringify(restored));

  // ---------- 汇总 ----------
  const bad = results.filter(r => !r.ok);
  console.log('========================================');
  console.log('E2E r65：' + (results.length - bad.length) + '/' + results.length + (bad.length ? '  FAILED' : '  ALL PASS'));
  await app.quit();
  process.exit(bad.length ? 1 : 0);
}
main().catch(e => { console.error(e); app.quit(); process.exit(1); });
