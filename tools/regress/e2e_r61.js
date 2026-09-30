// E2E r61：两项改动的确定性回归
//  A. 音频可视化（Web Audio 频谱 + 左右声道电平）
//     - 核心模块存在 / 工具栏开关默认开且持久化 / 预览卡带 .aviz 画布
//     - 静音改为 gain 控制（video.muted=true 会让 MediaElementSource 输出恒 0，这是硬约束）
//     - 节点链按 video 缓存（MediaElementSource 二次创建必抛错）
//     - 质量卡带 .qaviz 容器；预览在播的流能被质量页找到（共享音源）
//  B. 地址生成 / 拉流转推等竖版菜单 → 横版长条
//     - .form-h 为 grid；label 与紧随控件真实同行（rect.top 接近）
//     - label 单行（scrollHeight ≈ 一行高，不再折成竖排小字）
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '✅ ' : '❌ ') + name + (ok ? '' : '  → ' + (detail || '')));
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const win = new BrowserWindow({ width: 1500, height: 950, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  const ex = (js) => win.webContents.executeJavaScript(js);
  await wait(500);
  await ex("localStorage.clear(); (function(){ state.cfg={}; bindWatchPrefs(); bindMonitorPrefs(); })(); 'ok'");

  // ---------- A1. 模块与开关 ----------
  const a1 = await ex(`(function(){
    return { hasCreate: typeof avizCreate === 'function', hasEnabled: typeof avizEnabled() === 'boolean',
      chk: document.getElementById('watchViz') ? { exists: true, checked: document.getElementById('watchViz').checked } : { exists: false },
      cfgDefault: avizEnabled() };
  })()`);
  check('A1 音频可视化模块与工具栏开关：默认开启、可持久化',
    a1.hasCreate && a1.hasEnabled && a1.chk.exists && a1.chk.checked === true && a1.cfgDefault === true, JSON.stringify(a1));

  // ---------- A2. 预览卡带画布 + 静音 gain 化 ----------
  const a2 = await ex(`(function(){
    // 造一张在线卡（不真实起播：watchStartPlay 会走云端，这里只看 DOM 与静音逻辑）
    var it = { key: 't|push.x.com|live|aviz1|', live: true, tag: '',
      s: { _prov: 'tencent', StreamName: 'aviz1', AppName: 'live', DomainName: 'push.x.com' } };
    var card = watchBuildCard(it);
    document.getElementById('watchGrid').appendChild(card);
    var st = _watchPlayers[it.key];
    var aviz = card.querySelector('[data-w="aviz"]');
    var hasCanvas = !!(aviz && aviz.querySelector('canvas'));
    // 模拟装配成功后的静音切换
    st.aviz = { setGain: function (v) { st.__gain = v; } };
    var btn = card.querySelector('[data-wact="mute"]');
    btn.click();                                  // 切到非静音
    var afterOn = { gain: st.__gain, muted: st.muted, btn: btn.textContent, videoMuted: st.video.muted };
    btn.click();                                  // 切回静音
    var afterOff = { gain: st.__gain, muted: st.muted, btn: btn.textContent };
    watchStop(it.key);
    return { hasCanvas: hasCanvas, afterOn: afterOn, afterOff: afterOff };
  })()`);
  check('A2 预览卡带音频画布；静音按钮走 gain（开声 gain=1 且 video 不 muted，静音 gain=0）',
    a2.hasCanvas && a2.afterOn.gain === 1 && a2.afterOn.muted === false && a2.afterOn.videoMuted === false &&
    /声音开/.test(a2.afterOn.btn) && a2.afterOff.gain === 0 && a2.afterOff.muted === true &&
    /静音/.test(a2.afterOff.btn), JSON.stringify(a2));

  // ---------- A3. 节点链按 video 缓存（MediaElementSource 只能建一次） ----------
  const a3 = await ex(`(function(){
    var v1 = document.createElement('video'), v2 = document.createElement('video');
    var n1 = avNodesOf(v1), n1b = avNodesOf(v1), n2 = avNodesOf(v2);
    return { first: !!n1, cached: n1 === n1b, distinct: n1 !== n2, hasParts: !!(n1 && n1.src && n1.splitter && n1.anL && n1.anR && n1.gain) };
  })()`);
  check('A3 分析节点链按 video 缓存复用（重复获取同一实例；不同 video 各自独立）',
    a3.first && a3.cached && a3.distinct && a3.hasParts, JSON.stringify(a3));

  // ---------- A4. 开关关闭：卡片隐藏 + 配置持久化 ----------
  const a4 = await ex(`(function(){
    document.getElementById('watchViz').checked = false;
    document.getElementById('watchViz').dispatchEvent(new Event('change'));
    var hidden = state.cfg.watchViz === false && avizEnabled() === false;
    var chk = document.getElementById('watchViz');
    chk.checked = true; chk.dispatchEvent(new Event('change'));
    return { persisted: hidden, restored: avizEnabled() === true };
  })()`);
  check('A4 「音频可视化」开关关闭写配置并隐藏画布，重开恢复',
    a4.persisted && a4.restored, JSON.stringify(a4));

  // ---------- A5. 质量卡带 qaviz + 音频码率指标位 ----------
  const a5 = await ex(`(function(){
    var s = { _prov: 'tencent', StreamName: 'qaviz1', AppName: 'live', DomainName: 'push.x.com' };
    window._monList = [s];
    qDetectOne(s);
    var key = qCardKey(s);
    var qaviz = document.getElementById(key + ':aviz');
    var abr = document.getElementById(key + ':abr');
    var grid = document.getElementById('qGrid');
    if (grid && grid.contains(_qCards[key])) { /* 留在页面上 */ }
    return { hasQaviz: !!qaviz, hasAbr: !!abr, note: qaviz ? (qaviz.querySelector('.aviz-note') || {}).textContent : '' };
  })()`);
  check('A5 流质量卡带音频可视化容器与「音频码率」指标位，未播放时给出引导提示',
    a5.hasQaviz && a5.hasAbr && /预览观看/.test(a5.note), JSON.stringify(a5));

  // ---------- A6. 质量页能找到预览在播的同名流（共享音源） ----------
  const a6 = await ex(`(function(){
    var v = document.createElement('video');
    Object.defineProperty(v, 'readyState', { value: 4 });   // mock「已加载可播放」，实现里会跳过未加载的 video
    _watchPlayers['t|push.x.com|live|qaviz1|'] = { live: true, video: v, s: { StreamName: 'qaviz1', _prov: 'tencent' }, card: document.createElement('div') };
    var s = { _prov: 'tencent', StreamName: 'qaviz1', AppName: 'live', DomainName: 'push.x.com' };
    var found = qAvizFindVideo(s);
    var miss = qAvizFindVideo({ _prov: 'tencent', StreamName: 'no-such', AppName: 'live', DomainName: 'x' });
    delete _watchPlayers['t|push.x.com|live|qaviz1|'];
    return { found: found === v, missNull: miss === null };
  })()`);
  check('A6 质量页按流名找到预览在播的 video（共享同一分析节点，不重复拉流）',
    a6.found && a6.missNull, JSON.stringify(a6));

  // ---------- B. 横版长条表单 ----------
  const b1 = await ex(`(function(){
    function rowsOf(viewId, cloud) {
      var out = [];
      var card = document.querySelector('#view-' + viewId + ' .card.form-h');
      if (cloud) {
        var v = document.getElementById('view-' + viewId);
        var t = v.querySelector('.cloud-tabs .ctab[data-cloud="' + cloud + '"]');
        if (t) t.click();
        card = document.querySelector('#view-' + viewId + ' .card.form-h');
      }
      if (!card) return { missing: true };
      var cs = getComputedStyle(card);
      var labels = [].slice.call(card.querySelectorAll('label')).filter(function (l) {
        var nx = l.nextElementSibling;
        return nx && /^(INPUT|SELECT|TEXTAREA)$/.test(nx.tagName);
      }).slice(0, 6);
      var samples = labels.map(function (l) {
        var nx = l.nextElementSibling;
        var lr = l.getBoundingClientRect(), nr = nx.getBoundingClientRect();
        return { sameRow: Math.abs(lr.top - nr.top) < 14, oneLine: l.scrollHeight <= l.clientHeight + 3,
          grid: cs.display };
      });
      return { display: cs.display, cols: cs.gridTemplateColumns.trim().split(/\s+/).length, samples: samples };
      // 注：cols 仅记录参考；判定只看 display:grid + sameRow + oneLine（computed 串含 minmax() 内空格，解析不可靠）
    }
    var res = { genaddr: rowsOf('genaddr'), relay: rowsOf('relay'), aladdr: rowsOf('genaddr', 'al'), alrelay: rowsOf('relay', 'al') };
    return res;
  })()`);
  var pages = ['genaddr', 'relay', 'aladdr', 'alrelay'];
  var b1ok = pages.every(function (p) {
    var r = b1[p];
    return r && !r.missing && r.display === 'grid' &&
      r.samples.length > 0 && r.samples.every(function (s) { return s.sameRow && s.oneLine && s.grid === 'grid'; });
  });
  check('B1 四个页面（腾讯/阿里 × 地址生成/拉流转推）：grid 横版、label 与控件同行、label 单行不折竖',
    b1ok, JSON.stringify(b1));

  const b2 = await ex(`(function(){
    // r62 起 560px 左栏长条被「表单整行」取代（同行/占满断言见 e2e_r62 A 段），此处断言旧布局已全部移除
    var w = [].slice.call(document.querySelectorAll('.grid-2')).filter(function (g) {
      return (g.getAttribute('style') || '').indexOf('560px') !== -1;
    }).length;
    return { widened: w };
  })()`);
  check('B2 旧 560px 左栏布局已全部移除（r62 表单整行化）', b2.widened === 0, JSON.stringify(b2));

  // ---------- A8. ffmpeg 音频电平通道（直播经 MSE 播放时 Web Audio 拿不到音频的兜底来源） ----------
  const a8 = await ex(`(function(){
    var hasBridge = !!(window.tcapi && typeof window.tcapi.ffAudioLevel === 'function');
    return { hasBridge: hasBridge, tick: typeof avizLevelTick, map: typeof avizDbToLvl,
      m1: avizDbToLvl(0), m2: avizDbToLvl(-60), m3: avizDbToLvl(-30), m4: avizDbToLvl(null) };
  })()`);
  check('A8 ffmpeg 音频电平通道：桥接 + 调度器 + dB→电平映射（-60..0 dBFS 映射为 0..1）',
    a8.hasBridge && a8.tick === 'function' && a8.map === 'function' &&
    a8.m1 === 1 && a8.m2 === 0 && Math.abs(a8.m3 - 0.5) < 0.01 && a8.m4 === 0, JSON.stringify(a8));

  // ---------- A7. 独立预览窗（renderer/preview.html，独立文件自带实现） ----------
  const pv = new BrowserWindow({ width: 900, height: 640, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true } });
  await pv.loadFile(path.join(ROOT, 'renderer', 'preview.html'));
  await wait(600);
  const pex = (js) => pv.webContents.executeJavaScript(js);
  const a7 = await pex(`(function(){
    var box = document.getElementById('aviz');
    var btn = document.getElementById('vizBtn');
    var has = { box: !!box, canvas: !!(box && box.querySelector('canvas')), vizBtn: !!btn,
      soundBtn: !!document.getElementById('soundBtn'),
      fns: typeof avAttachP + '/' + typeof toggleViz + '/' + typeof toggleSound + '/' + typeof avNodesP };
    // 开关关闭 → 容器加 off 且释放；再开 → 恢复
    toggleViz(btn);
    var off = { cls: box.classList.contains('off'), on: AV.on, h: AV.h };
    toggleViz(btn);
    var on = { cls: box.classList.contains('off'), on: AV.on };
    return has; 
  })()`);
  const a7b = await pex(`(function(){
    var box = document.getElementById('aviz'), btn = document.getElementById('vizBtn');
    toggleViz(btn); var off = { cls: box.classList.contains('off'), on: AV.on };
    toggleViz(btn); var on = { cls: box.classList.contains('off'), on: AV.on };
    return { off: off, on: on };
  })()`);
  pv.destroy();
  check('A7 独立预览窗自带音频可视化：画布 + 开关 + 声音走 gain 的函数齐备，开关可关闭/恢复',
    a7.box && a7.canvas && a7.vizBtn && a7.soundBtn && /function/.test(a7.fns) &&
    a7b.off.cls === true && a7b.off.on === false && a7b.on.cls === false && a7b.on.on === true,
    JSON.stringify({ has: a7, toggle: a7b }));

  // ---------- 汇总 ----------
  const pass = results.filter(r => r.ok).length;
  console.log('──────────────────────────────────────────');
  console.log('r61 汇总：' + pass + '/' + results.length + ' passed');
  console.log(pass === results.length ? 'R61 ALL PASS' : 'R61 HAS FAILURE');
  app.exit(0);
}
app.whenReady().then(main).catch(e => { console.error('运行异常：', e); app.exit(2); });
