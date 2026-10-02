// E2E r92（v1.1.48 本机 PGM 输出）：
//   ① 主窗输出 UI 元素与 lpOutSourcePayload 源翻译（场景优先 / 回退推流来源）
//   ② lpOutSyncSource JSON 指纹去重、显示器列表填充、按钮开停切换
//   ③ renderer/output.html 四种源起播（image / file / device / stream）+ 铺放方式 + 信息条
//   ④ main.js out:* IPC 契约（displays / open / source / style / get / close）
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '✅ ' : '❌ ') + name + (ok ? '' : '  → ' + (detail || '')));
}
function summary() {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log('\nr92 本机 PGM 输出: ' + pass + ' 通过 / ' + fail + ' 失败');
  return fail;
}

// =====================================================================
// ④ main.js out:* IPC 契约（先跑，同步、不依赖 jsdom）
// =====================================================================
function partMain() {
  console.log('\n—— ④ main.js out:* IPC ——');
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

  const DISPLAYS = [
    { id: 1, label: '内置显示器', bounds: { x: 0, y: 0, width: 1440, height: 900 } },
    { id: 2, label: 'HDMI 外接屏', bounds: { x: 1440, y: 0, width: 1920, height: 1080 } }
  ];
  let boundsSet = null;
  let createdOpts = null;
  const sent = [];
  const handlers = {};

  function makeWin() {
    return {
      loadFile: () => {},
      once: () => {}, on: () => {},
      show: () => {}, showInactive: () => {}, close: () => {},
      setBounds: (b) => { boundsSet = b; },
      isDestroyed: () => false,
      webContents: { send: (ch, p) => sent.push([ch, p]) }
    };
  }
  const stubElectron = {
    app: { whenReady: () => Promise.resolve(), on: () => {}, commandLine: { appendSwitch: () => {} },
      quit: () => {}, getPath: () => os.tmpdir(), getName: () => 'test', getVersion: () => '0.0.0',
      isPackaged: false, requestSingleInstanceLock: () => true },
    BrowserWindow: function (o) { createdOpts = o; return makeWin(); },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on: () => {}, removeHandler: () => {} },
    shell: { openExternal: () => {}, openPath: () => {}, showItemInFolder: () => {} },
    dialog: { showOpenDialog: () => Promise.resolve({ canceled: true }), showMessageBox: () => {}, showSaveDialog: () => {} },
    Notification: function () { return { show: () => {} }; },
    screen: {
      getAllDisplays: () => DISPLAYS,
      getPrimaryDisplay: () => DISPLAYS[0],
      on: () => {}
    },
    Menu: { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} },
    nativeImage: { createFromPath: () => ({}) },
    Tray: function () { return { on: () => {}, setToolTip: () => {}, setContextMenu: () => {} }; }
  };
  const sandbox = {
    console, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error,
    __dirname: ROOT, __filename: path.join(ROOT, 'main.js'), module: { exports: {} },
    exports: {}, require: (m) => (m === 'electron' ? stubElectron
      : require(m.startsWith('.') ? path.resolve(ROOT, m) : m))
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'main.js' });

  const need = ['out:displays', 'out:state', 'out:get', 'out:open', 'out:close', 'out:source', 'out:style'];
  check('M1 out:* 七个 handler 全部注册', need.every((k) => typeof handlers[k] === 'function'),
    need.filter((k) => typeof handlers[k] !== 'function').join(','));

  const r1 = handlers['out:displays']();
  check('M2 out:displays 返回显示器列表（含主显示器标记）',
    r1.ok && r1.displays.length === 2 && r1.displays[0].primary === true && /1440×900/.test(r1.displays[0].label),
    JSON.stringify(r1.displays && r1.displays.map((d) => d.label)));

  // 注意：ipcMain.handle 的回调签名是 (event, ...args)，此处显式补 null 作为 event
  const r2 = handlers['out:open'](null, 2);
  check('M3 out:open 指定显示器 → open=true 且 displayId=2',
    r2.ok && r2.state.open === true && r2.state.displayId === 2, JSON.stringify(r2));
  check('M4 输出窗关键参数：无边框 / 不可聚焦 / 跳过任务栏 / 不可全屏',
    createdOpts && createdOpts.frame === false && createdOpts.focusable === false
    && createdOpts.skipTaskbar === true && createdOpts.fullscreenable === false,
    JSON.stringify(createdOpts && { frame: createdOpts.frame, focusable: createdOpts.focusable, skipTaskbar: createdOpts.skipTaskbar }));
  check('M5 输出窗铺满目标显示器 bounds（1440,0 1920x1080）',
    boundsSet && boundsSet.x === 1440 && boundsSet.y === 0 && boundsSet.width === 1920 && boundsSet.height === 1080,
    JSON.stringify(boundsSet));

  handlers['out:source'](null, { kind: 'file', cfg: { path: '/tmp/a.mp4' }, name: 'a.mp4' });
  const last1 = sent.filter((s) => s[0] === 'out:source').pop();
  check('M6 out:source 下发到输出窗', last1 && last1[1] && last1[1].kind === 'file', JSON.stringify(last1));

  handlers['out:style'](null, { fit: 'cover', info: true });
  const r3 = handlers['out:get']();
  check('M7 out:style 生效（fit=cover / info=true）',
    r3.cfg && r3.cfg.fit === 'cover' && r3.cfg.info === true, JSON.stringify(r3.cfg));
  check('M8 out:get 回传 open / displayId / source / cfg',
    r3.open === true && r3.displayId === 2 && r3.source && r3.source.kind === 'file', JSON.stringify(r3));

  const r4 = handlers['out:close']();
  check('M9 out:close → open=false', r4.ok && r4.state.open === false, JSON.stringify(r4.state));
  check('M10 out:state 与 close 后一致', handlers['out:state']().state.open === false);
}

// =====================================================================
// ③ renderer/output.html 输出窗页面
// =====================================================================
async function partOutput() {
  console.log('\n—— ③ renderer/output.html ——');
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'output.html'), 'utf8');
  let givenSource = null;
  let givenCfg = null;
  const vc = new VirtualConsole();
  let jsdomErr = null;
  vc.on('jsdomError', (e) => { jsdomErr = e; });

  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'file:///out/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      // 采集设备源：模拟一台名为「HD Webcam」的摄像头
      window.navigator.mediaDevices = {
        enumerateDevices: () => Promise.resolve([
          { kind: 'videoinput', deviceId: 'cam1', label: 'HD Webcam' }
        ]),
        getUserMedia: (c) => {
          const tracks = [{ stop: () => {} }];
          return Promise.resolve({ getTracks: () => tracks });
        }
      };
      window.tcapi = {
        onOutSource: (cb) => { window.__osCb = cb; },
        onOutCfg: (cb) => { window.__ocCb = cb; },
        outGet: () => Promise.resolve({ ok: true, cfg: { fit: 'contain', info: false }, source: null }),
        outClose: () => {}
      };
    }
  });
  const { window } = dom;
  const doc = window.document;
  const ex = (js) => window.eval(js);
  await new Promise((r) => setTimeout(r, 300));

  check('O1 无 jsdomError', !jsdomErr, jsdomErr && jsdomErr.message);
  check('O2 握手三件套已注册（onOutSource / onOutCfg / outGet）',
    typeof window.__osCb === 'function' && typeof window.__ocCb === 'function');
  check('O3 __out 调试入口存在', typeof window.__out === 'object' && typeof window.__out.play === 'function');

  const v = doc.getElementById('media');
  const im = doc.getElementById('img');
  const hint = doc.getElementById('hint');
  const info = doc.getElementById('info');
  check('O4 初始为等待态（提示可见、媒体元素尚未挂源）',
    !hint.classList.contains('off') && !v.getAttribute('src') && !im.getAttribute('src'));

  // 铺放方式 / 信息条
  ex('__out.setCfg({ fit: "cover", info: true })');
  check('O5 setCfg cover → 媒体元素类 fit-cover', v.className === 'fit-cover' && im.className === 'fit-cover', v.className);
  check('O6 setCfg info=true → 信息条显示', !info.classList.contains('off'));
  ex('__out.setCfg({ fit: "contain", info: false })');
  check('O7 setCfg info=false → 信息条隐藏', info.classList.contains('off'));

  // ① 图片源
  ex('__out.play({ kind: "image", cfg: { path: "C:\\\\v\\\\a.png" }, name: "a.png" })');
  check('O8 图片源：img 显示 + Windows 路径转 file://（file:///C:/v/a.png）',
    im.style.display === 'block' && im.getAttribute('src') === 'file:///C:/v/a.png', im.getAttribute('src'));
  check('O9 图片源：信息条写入名称与类型标签',
    doc.getElementById('infoName').textContent === 'a.png' && doc.getElementById('infoTag').textContent === '图片',
    doc.getElementById('infoName').textContent);

  // ② 本地素材
  ex('__out.play({ kind: "file", cfg: { path: "/v/a.mp4", loop: true, start: 0 }, name: "a.mp4" })');
  check('O10 本地素材：video 接 file:// 且 loop=true',
    v.style.display === 'block' && v.loop === true && /^file:\/\/\//.test(v.getAttribute('src') || ''),
    v.getAttribute('src'));
  check('O11 切换源后图片元素被收起（不残留在屏上）', im.style.display === 'none');

  // ③ 采集设备（按设备名匹配 getUserMedia）
  ex('__out.play({ kind: "device", cfg: { deviceName: "HD Webcam" }, name: "摄像头" })');
  await new Promise((r) => setTimeout(r, 200));
  check('O12 采集设备源：srcObject 已挂载（按设备名匹配到 cam1）',
    !!v.srcObject && typeof v.srcObject.getTracks === 'function', String(!!v.srcObject));
  check('O13 采集设备源：类型标签为「采集设备」', doc.getElementById('infoTag').textContent === '采集设备');

  // ④ 网络流（jsdom 无 MSE → 兜底直挂 src）
  ex('__out.play({ kind: "stream", cfg: { url: "http://127.0.0.1:8123/live.flv" }, name: "推流输出" })');
  check('O14 网络流源：兜底直挂 url',
    v.style.display === 'block' && (v.getAttribute('src') || '').indexOf('127.0.0.1:8123') >= 0,
    v.getAttribute('src'));

  // 未知类型
  ex('__out.play({ kind: "weird", cfg: {}, name: "?" })');
  check('O15 未知来源类型 → 提示可见（不白屏）', !hint.classList.contains('off'));

  // 空源（主窗还没下发）
  ex('__out.play(null)');
  check('O16 空源 → 回到等待态', !hint.classList.contains('off'));

  dom.window.close();
}

// =====================================================================
// ①② 主窗输出 UI
// =====================================================================
async function partMainWin() {
  console.log('\n—— ①② 主窗「本机输出」UI ——');
  let html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const seSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'scene-engine.js'), 'utf8');
  html = html.replace('<script src="scene-engine.js"></script>', '<script>\n' + seSrc + '\n</script>');

  let outSourceCalls = 0;
  let outOpenArg = 'NONE';
  const tcHandlers = {
    appVersion: '1.1.48',
    outDisplays: () => Promise.resolve({ ok: true, displays: [
      { id: 1, label: '内置显示器 · 1440×900（主显示器）', primary: true },
      { id: 2, label: 'HDMI 外接屏 · 1920×1080', primary: false }
    ] }),
    outSource: () => { outSourceCalls++; return Promise.resolve({ ok: true }); },
    outOpen: (id) => { outOpenArg = String(id); return Promise.resolve({ ok: true, state: { open: true, displayId: id } }); },
    outClose: () => Promise.resolve({ ok: true, state: { open: false } }),
    outStyle: () => Promise.resolve({ ok: true }),
    outGet: () => Promise.resolve({ ok: true, open: false, source: null, cfg: { fit: 'contain', info: false } })
  };
  const vc = new VirtualConsole();
  let jsdomErr = null;
  vc.on('jsdomError', (e) => { jsdomErr = e; });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://localhost/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.tcapi = new Proxy({}, { get(t, p) { return (p in tcHandlers) ? tcHandlers[p] : (() => Promise.resolve({ ok: true, data: {} })); } });
      window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    }
  });
  const { window } = dom;
  const doc = window.document;
  const ex = (js) => window.eval(js);
  await new Promise((r) => setTimeout(r, 1800));

  check('W1 无 jsdomError', !jsdomErr, jsdomErr && jsdomErr.message);
  // ① UI 元素
  ['lpOutDisplay', 'lpOutFit', 'lpOutInfo', 'lpOutOpenBtn', 'lpOutCloseBtn', 'lpOutRefreshBtn', 'lpOutNote']
    .forEach((id, i) => check('W2.' + (i + 1) + ' UI 元素 #' + id + ' 存在', !!doc.getElementById(id)));

  check('W3 lpOutSourcePayload 已定义', ex('typeof lpOutSourcePayload === "function"'));
  check('W4 lpOutSyncSource 已定义', ex('typeof lpOutSyncSource === "function"'));
  check('W5 lpOutRefresh 已定义', ex('typeof lpOutRefresh === "function"'));

  // ② 源翻译：Program 场景里的媒体来源优先
  const p1 = ex('(function(){ var sc = SE.programScene(); sc.sources.length = 0; SE.addSource("ffmpeg_source"); sc.sources[0].settings.local_file = "C:\\\\v\\\\live.mp4"; sc.sources[0].name = "直播素材"; return lpOutSourcePayload(); })()');
  check('W6 场景 ffmpeg_source → kind=file 且取场景来源名',
    p1 && p1.kind === 'file' && p1.name === '直播素材' && /live\.mp4$/.test(p1.cfg.path), JSON.stringify(p1));

  const p2 = ex('(function(){ var sc = SE.programScene(); sc.sources.length = 0; SE.addSource("image_source"); sc.sources[0].settings.file = "C:\\\\v\\\\logo.png"; return lpOutSourcePayload(); })()');
  check('W7 场景 image_source → kind=image', p2 && p2.kind === 'image', JSON.stringify(p2));

  const p3 = ex('(function(){ var sc = SE.programScene(); sc.sources.length = 0; SE.addSource("av_capture_input"); sc.sources[0].settings.device = "video=HD Webcam:audio=Mic"; return lpOutSourcePayload(); })()');
  check('W8 场景 av_capture_input → kind=device 且剥出设备名（去掉 video= 与 :audio=）',
    p3 && p3.kind === 'device' && p3.cfg.deviceName === 'HD Webcam', JSON.stringify(p3));

  // 无可视来源 → 回退当前推流来源（设备）
  const p4 = ex('(function(){ var sc = SE.programScene(); sc.sources.length = 0; window._lpDevNames = { v0: "采集卡" }; document.querySelector(\'input[name="lpSrcType"][value="device"]\').checked = true; var s=document.getElementById("lpDeviceVideo"); var o=document.createElement("option"); o.value="0"; o.label="采集卡"; s.appendChild(o); s.value="0"; return lpOutSourcePayload(); })()');
  check('W9 场景为空 → 回退当前推流来源（device）', p4 && p4.kind === 'device' && p4.cfg.deviceName === '采集卡', JSON.stringify(p4));

  // ② 指纹去重
  outSourceCalls = 0;
  ex('lpOutFp = ""; lpOutSyncSource(); lpOutSyncSource(); lpOutSyncSource();');
  check('W10 相同来源连续同步只下发一次（JSON 指纹去重）', outSourceCalls === 1, 'outSource 调用 ' + outSourceCalls + ' 次');
  ex('(function(){ var sc = SE.programScene(); sc.sources.length = 0; SE.addSource("ffmpeg_source"); sc.sources[0].settings.local_file = "C:\\\\v\\\\b.mp4"; lpOutSyncSource(); })()');
  check('W11 来源变化后重新下发', outSourceCalls === 2, 'outSource 调用 ' + outSourceCalls + ' 次');

  // ② 显示器列表 + 开停切换
  ex('lpOutRefresh()');
  await new Promise((r) => setTimeout(r, 200));
  const sel = doc.getElementById('lpOutDisplay');
  check('W12 刷新显示器 → 下拉填充 2 项', sel.options.length === 2, sel.options.length + ' 项');
  check('W13 下拉文案含主显示器标记', /主显示器/.test(sel.options[0].textContent), sel.options[0].textContent);

  sel.value = '2';
  ex('lpOutStart()');
  await new Promise((r) => setTimeout(r, 200));
  check('W14 开始输出 → 传出选中的显示器 id', outOpenArg === '2', outOpenArg);
  check('W15 开始输出 → 按钮切为「停止输出」',
    doc.getElementById('lpOutOpenBtn').style.display === 'none' && doc.getElementById('lpOutCloseBtn').style.display === '');
  ex('lpOutStop()');
  await new Promise((r) => setTimeout(r, 200));
  check('W16 停止输出 → 按钮切回「开始输出」',
    doc.getElementById('lpOutOpenBtn').style.display === '' && doc.getElementById('lpOutCloseBtn').style.display === 'none');

  dom.window.close();
}

(async function main() {
  let fails = 0;
  partMain();
  await partOutput();
  await partMainWin();
  fails = summary();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
