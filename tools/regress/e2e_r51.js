// E2E r51：预览观看 v1.1.8 —— 横竖排切换 + 每流实时数据图表 + 卡片重设计
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail || '' }); }

async function main() {
  const win = new BrowserWindow({
    width: 1500, height: 950, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  const ex = (js) => win.webContents.executeJavaScript(js);
  await ex("localStorage.clear(); (function(){ state.cfg={}; bindWatchPrefs(); bindMonitorPrefs(); })(); 'ok'");

  // ---------- A. 布局切换 ----------
  const a1 = await ex(`(function(){
    var seg = document.getElementById('watchLayoutSeg');
    if (!seg) return { ok:false, why:'no seg' };
    var grid = document.getElementById('watchGrid');
    var btns = Array.from(seg.querySelectorAll('button')).map(b=>b.dataset.lay);
    return { ok: btns.indexOf('grid')>=0 && btns.indexOf('list')>=0 && grid.className==='watch-grid'
             && seg.querySelector('[data-lay="grid"]').classList.contains('on'), btns, cls: grid.className };
  })()`);
  check('A1 默认横向网格：watch-grid + grid 按钮 on', a1.ok, JSON.stringify(a1));

  await ex(`(function(){
    document.querySelector('#watchLayoutSeg [data-lay="list"]').click(); return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 250));
  const a2 = await ex(`(function(){
    var grid = document.getElementById('watchGrid');
    var saved = localStorage.getItem('wb_tclive_config') || '';
    return { cls: grid.className, listOn: document.querySelector('#watchLayoutSeg [data-lay="list"]').classList.contains('on'),
             persisted: saved.indexOf('"watchLayout":"list"') >= 0 };
  })()`);
  check('A2 点击竖向排列：watch-list 生效 + 持久化 watchLayout=list', a2.cls === 'watch-list' && a2.listOn && a2.persisted, JSON.stringify(a2));

  await ex(`document.querySelector('#watchLayoutSeg [data-lay="grid"]').click(); 'ok'`);
  await new Promise(r => setTimeout(r, 250));
  const a3 = await ex(`(function(){
    var grid = document.getElementById('watchGrid');
    return { cls: grid.className, gridOn: document.querySelector('#watchLayoutSeg [data-lay="grid"]').classList.contains('on'),
             persisted: (localStorage.getItem('wb_tclive_config')||'').indexOf('"watchLayout":"grid"') >= 0 };
  })()`);
  check('A3 切回横向排列：watch-grid + 持久化', a3.cls === 'watch-grid' && a3.gridOn && a3.persisted, JSON.stringify(a3));

  // ---------- B. 卡片重设计 + 实时图表 ----------
  const b1 = await ex(`(function(){
    // 直接建一张 live 卡（不真正拉流：先 stub watchStartPlay 防网络调用）
    window.__realStart = watchStartPlay;
    watchStartPlay = function(){};
    var card = watchBuildCard({ key: 'test|live|ces_demo', live: true, tag: '转推源',
      s: { _prov: 'aliyun', StreamName: 'ces_demo', AppName: 'liveApp', DomainName: 'pl.gfcnn.cn', PublishDomain: 'pl.gfcnn.cn', PublishTime: '' } });
    document.getElementById('watchGrid').appendChild(card);
    return {
      video: !!card.querySelector('video'),
      liveMark: !!card.querySelector('.wlive-mark'),
      dot: !!card.querySelector('.wdot.live'),
      wstats: card.querySelectorAll('.wstat').length,
      chartEl: !!card.querySelector('[data-w="chart"]'),
      btns: ['mute','pop','retry'].every(a => !!card.querySelector('[data-wact="'+a+'"]')),
      dur: !!card.querySelector('[data-w="dur"]'),
      inState: !!_watchPlayers['test|live|ces_demo']
    };
  })()`);
  check('B1 新版 live 卡结构：LIVE 角标/呼吸灯/4 格指标/图表容器/3 按钮/注册播放器',
    b1.video && b1.liveMark && b1.dot && b1.wstats === 4 && b1.chartEl && b1.btns && b1.dur && b1.inState, JSON.stringify(b1));

  // 显示视图容器后跑两次采样（间隔 1.1s），图表懒初始化 + 指标更新不抛错
  await ex(`document.querySelector('[data-view="watch"]') ? 'nav-exists' : 'no-nav'`);
  const b2 = await ex(`(async function(){
    var st = _watchPlayers['test|live|ces_demo'];
    var card = st.card;
    // 让卡片可见（watch 视图可能未激活，直接把卡片临时挂到 body 底部测量）
    card.style.position='fixed'; card.style.left='0'; card.style.bottom='0'; card.style.width='700px'; card.style.zIndex=1;
    document.body.appendChild(card);
    watchStatsTick();
    await new Promise(r=>setTimeout(r,1150));
    watchStatsTick();
    var hasChart = !!st.chart;
    var kbpsTxt = st.el.kbps.textContent, fpsTxt = st.el.fps.textContent, resTxt = st.el.res.textContent, bufTxt = st.el.buf.textContent;
    var durTxt = st.el.dur.textContent;
    card.style.position=''; card.style.left=''; card.style.bottom=''; card.style.width=''; card.style.zIndex='';
    return { hasChart, kbpsTxt, fpsTxt, resTxt, bufTxt, durTxt };
  })()`);
  check('B2 实时采样两次不抛错：图表懒初始化 + 指标格子有值',
    b2.hasChart === true && b2.kbpsTxt && b2.fpsTxt && b2.resTxt && b2.bufTxt, JSON.stringify(b2));

  const b3 = await ex(`(function(){
    var st = _watchPlayers['test|live|ces_demo'];
    var d = st.d;
    return { points: d.t.length, kbpsPts: d.kbps.length, fpsPts: d.fps.length };
  })()`);
  check('B3 滚动数据缓冲：至少 1 个采样点（码率/帧率同步）', b3.points >= 1 && b3.kbpsPts === b3.points && b3.fpsPts === b3.points, JSON.stringify(b3));

  // watchStop：图表销毁不抛错
  const b4 = await ex(`(function(){
    try { watchStop('test|live|ces_demo'); watchStartPlay = window.__realStart; return { ok: !_watchPlayers['test|live|ces_demo'] }; }
    catch (e) { return { ok:false, why: String(e) }; }
  })()`);
  check('B4 watchStop：销毁播放器+图表后无残留', b4.ok, JSON.stringify(b4));

  // ---------- C. 待推流卡片 ----------
  const c1 = await ex(`(function(){
    watchStartPlay = function(){};
    var card = watchBuildCard({ key: 'test|live|pending1', live: false,
      s: { _prov: 'tencent', StreamName: 'pending1', AppName: 'live', DomainName: 'push.example.com' } });
    document.getElementById('watchGrid').appendChild(card);
    var ok = !card.querySelector('video') && !!card.querySelector('.wdot:not(.live)') && card.textContent.indexOf('待推流') >= 0;
    watchStop('test|live|pending1');
    return { ok };
  })()`);
  check('C1 待推流卡：无视频/灰点/待推流文案', c1.ok, JSON.stringify(c1));

  // ---------- D. renderWatch 计数 ----------
  const d1 = await ex(`(function(){
    window._monList = [
      { _prov: 'aliyun', StreamName: 'x1', AppName: 'liveApp', DomainName: 'pl.gfcnn.cn', PublishDomain: 'pl.gfcnn.cn', PublishTime: '' },
      { _prov: 'aliyun', StreamName: 'x2', AppName: 'liveApp', DomainName: 'pl.gfcnn.cn', PublishDomain: 'pl.gfcnn.cn', PublishTime: '' }
    ];
    window._taskList = []; state.cfg.genHistory = [];
    window.__realStart2 = watchStartPlay; watchStartPlay = function(){};
    renderWatch();
    var cnt = document.getElementById('watchCount').textContent;
    var cards = document.querySelectorAll('#watchGrid .wcard').length;
    watchStartPlay = window.__realStart2;
    window._monList = undefined;
    return { cnt, cards };
  })()`);
  check('D1 renderWatch 计数：在线 2 路 · 待推流 0 个，卡片 2 张',
    d1.cnt.indexOf('在线 2 路') >= 0 && d1.cnt.indexOf('待推流 0 个') >= 0 && d1.cards === 2, JSON.stringify(d1));

  const pass = results.filter(r => r.ok).length;
  results.forEach(r => console.log((r.ok ? '✅ PASS' : '❌ FAIL') + ' | ' + r.name + (r.ok ? '' : ' | ' + r.detail)));
  console.log('===== ' + pass + '/' + results.length + ' passed =====');
  app.exit(pass === results.length ? 0 : 1);
}
app.whenReady().then(() => setTimeout(main, 600));
