// E2E r54：预览观看卡片码率不显示修复 —— mpegts.js statisticsInfo 无 speed 字段，
// 新增 fetch 透传字节统计兜底换算 kbps
const { app, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail || '' }); }

async function main() {
  // 本地 FLV 假源
  const PAYLOAD = Buffer.alloc(40000, 7);
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'video/x-flv');
    res.end(PAYLOAD);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;
  const FLV_PATH = 'http://127.0.0.1:' + PORT + '/live/test.flv';

  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  const ex = (js) => win.webContents.executeJavaScript(js);
  await ex("localStorage.clear(); 'ok'");

  // ---------- A. fetch 拦截器 ----------
  const a1 = await ex(`(function(){
    return { patched: window.__flvFetchCounted === 1, hasMap: typeof _flvByte === 'object' };
  })()`);
  check('A1 fetch 拦截器已安装（__flvFetchCounted + _flvByte 计数表）',
    a1.patched && a1.hasMap, JSON.stringify(a1));

  const a2 = await ex(`(async function(){
    var res = await fetch('${FLV_PATH}?auth_key=abc');
    var buf = await res.arrayBuffer();            // 透传流必须仍可完整读取
    var path = '${FLV_PATH}';
    var rec = _flvByte[path];
    return { status: res.status, len: buf.byteLength, first: new Uint8Array(buf)[0],
             counted: rec ? rec.total : -1 };
  })()`);
  check('A2 FLV 响应透传后内容完整（40000 字节）且字节计数一致',
    a2.status === 200 && a2.len === 40000 && a2.first === 7 && a2.counted === 40000, JSON.stringify(a2));

  const a3 = await ex(`(async function(){
    var before = Object.keys(_flvByte).length;
    await fetch('http://127.0.0.1:${PORT}/other.txt');
    return { before, after: Object.keys(_flvByte).length };
  })()`);
  check('A3 非 .flv 请求不被拦截计数', a3.before === a3.after, JSON.stringify(a3));

  // ---------- B. watchStatsTick 字节统计兜底换算 ----------
  const b1 = await ex(`(function(){
    var fakeVideo = {
      buffered: { length: 0, end: function(){ return 0; } },
      videoWidth: 1920, videoHeight: 1080,
      getVideoPlaybackQuality: function(){ return { totalVideoFrames: 30 }; }
    };
    _watchPlayers['e2e|test|demo'] = {
      live: 1, video: fakeVideo, s: { StreamName: 'demo', AppName: 'live' },
      player: null,   // 模拟 mpegts 路径拿不到 speed（该版本 statisticsInfo 无 speed 字段）
      status: { textContent: '' }, wd: null,
      cands: ['${FLV_PATH}?auth_key=xyz'], candIdx: 0,
      chart: null, chartEl: null,
      d: { t: [], kbps: [], fps: [] },
      el: { kbps: { textContent: '' }, fps: { textContent: '' }, res: { textContent: '' },
            buf: { textContent: '' }, dur: null },
      lastFrames: 0, lastTs: Date.now() - 1100, lastBytes: null
    };
    _flvByte['${FLV_PATH}'] = { total: 1000000, ts: Date.now() };
    var st = _watchPlayers['e2e|test|demo'];
    st.lastBytes = { total: 875000, ts: Date.now() - 1000 };   // 上个采样 875000 → 1 秒收 125000B ≈ 1000kbps
    watchStatsTick();
    return { kbps: st.d.kbps[st.d.kbps.length - 1], fps: st.d.fps[st.d.fps.length - 1],
             el: st.el.kbps.textContent, res: st.el.res.textContent };
  })()`);
  const b1ok = b1.kbps >= 950 && b1.kbps <= 1050 && b1.el.indexOf('1,000') >= 0 && b1.res === '1920×1080';
  check('B1 statisticsInfo 无 speed 时字节统计兜底：Δ125000B/s ≈ 1000kbps 写入图表与指标',
    b1ok, JSON.stringify(b1));

  // B2 连续采样：数据停止增长 → kbps 归 0（不残留旧值）
  const b2 = await ex(`(function(){
    var st = _watchPlayers['e2e|test|demo'];
    st.lastTs = Date.now() - 1100;
    st.lastBytes = { total: 1000000, ts: Date.now() - 1000 };   // 无新增字节
    watchStatsTick();
    return { kbps: st.d.kbps[st.d.kbps.length - 1], el: st.el.kbps.textContent };
  })()`);
  check('B2 无新增字节时码率归 0（显示 --）', b2.kbps === 0 && b2.el === '--', JSON.stringify(b2));

  // B3 hls.js 路径优先用 bandwidthEstimate（回归：原 else-if 导致 mpegts 存在时跳过）
  const b3 = await ex(`(function(){
    var fakeVideo = {
      buffered: { length: 0, end: function(){ return 0; } },
      videoWidth: 1280, videoHeight: 720,
      getVideoPlaybackQuality: function(){ return { totalVideoFrames: 30 }; }
    };
    _watchPlayers['e2e|test|hls'] = {
      live: 1, video: fakeVideo, s: { StreamName: 'hls1', AppName: 'live' },
      player: { bandwidthEstimate: 2500000 },
      cands: [], candIdx: 0, chart: null, chartEl: null,
      d: { t: [], kbps: [], fps: [] },
      el: { kbps: { textContent: '' }, fps: { textContent: '' }, res: { textContent: '' }, buf: { textContent: '' }, dur: null },
      lastFrames: 0, lastTs: Date.now() - 1100, lastBytes: null
    };
    watchStatsTick();
    var st = _watchPlayers['e2e|test|hls'];
    return { kbps: st.d.kbps[st.d.kbps.length - 1], el: st.el.kbps.textContent };
  })()`);
  check('B3 hls.js bandwidthEstimate=2.5Mbps → 2500kbps', b3.kbps === 2500, JSON.stringify(b3));

  // C. 换候选重置基线
  const c1 = await ex(`(function(){
    var st = _watchPlayers['e2e|test|demo'];
    st.lastBytes = { total: 999999, ts: Date.now() };
    watchPlayCandResetTest = st;   // 仅引用
    // 直接验证 watchPlayCand 会重置：调用后 player 销毁路径（cands 为空会 status 报错但 lastBytes 应已重置）
    try { watchPlayCand('e2e|test|demo'); } catch (e) {}
    return { lastBytes: st.lastBytes };
  })()`);
  check('C1 watchPlayCand 换候选后字节基线重置为 null', c1.lastBytes === null, JSON.stringify(c1));

  server.close();
  const fail = results.filter(r => !r.ok);
  console.log('\n===== E2E r54 结果 =====');
  results.forEach(r => console.log((r.ok ? '✅' : '❌') + ' ' + r.name + (r.ok ? '' : '  → ' + r.detail)));
  console.log(fail.length ? 'FAIL: ' + fail.length + ' 项' : 'ALL PASS: ' + results.length + ' 项');
  app.exit(fail.length ? 1 : 0);
}

app.whenReady().then(main).catch(e => { console.error('FATAL', e); app.exit(2); });
