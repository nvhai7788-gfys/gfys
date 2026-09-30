// 打包产物冒烟：CDP 连真实打包 App，校验版本号 / 预加载接口 / 本轮修复函数 / 运行时报错
//
// 用途：源码层 E2E 通过 ≠ 打包产物能跑。本脚本直接启动 dist 下的 .app，用 CDP 在真实
//       app.asar/renderer/index.html 页面上下文里取值，验证「打进包里的代码」确实生效。
//
// 用法（必须清掉会话注入的 NODE_OPTIONS / ELECTRON_RUN_AS_NODE，并允许非沙箱运行）：
//   env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE node tools/smoke-packaged.js \
//       "dist/mac-arm64/港丰影视直播工作台.app" 9334
//   # 退出码 0 = PASS，1 = FAIL
//
// 判定口径：只有 console.error / console.assert / 未捕获异常 / Log error 计为硬错误；
//   console.warning 单列输出（mpegts.js 的 "[MSEPlayer] Playback seems stuck" 属正常提示，
//   早期版本把它误判为错误 → 假阳性，已修正）。
// Windows 包无法在 macOS 上启动，故 .exe 只能做「架构 file 校验 + asar 字符串抽查 +
//   makensis 是否消费 nsis.include」三项静态验证。
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP = process.argv[2];
const PORT = Number(process.argv[3] || 9333);
const BIN = APP + '/Contents/MacOS/港丰影视直播工作台';
// 期望版本从 package.json 读，避免每次发版都要改脚本
const EXPECT_VER = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

function getJson(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(BIN)) { console.log('FAIL: 可执行文件不存在 ' + BIN); process.exit(1); }
  const child = spawn(BIN, ['--remote-debugging-port=' + PORT], {
    env: Object.assign({}, process.env, { ELECTRON_DISABLE_SANDBOX: '1', NODE_OPTIONS: '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let appLog = '';
  child.stdout.on('data', d => appLog += d);
  child.stderr.on('data', d => appLog += d);

  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const list = await getJson('/json/list');
      const page = (list || []).find(t => t.type === 'page' && /index\.html/.test(t.url || ''));
      if (page && page.webSocketDebuggerUrl) { targets = page; break; }
    } catch (e) {}
  }
  if (!targets) {
    console.log('FAIL: 60s 内未取到页面调试目标');
    console.log('--- app log ---\n' + appLog.slice(-2000));
    try { child.kill('SIGKILL'); } catch (e) {}
    process.exit(1);
  }

  const ws = new WebSocket(targets.webSocketDebuggerUrl);
  const errs = [];
  const warns = [];
  let id = 0; const pend = new Map();
  const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning' || m.params.type === 'assert')) {
      const line = '[console.' + m.params.type + '] ' + (m.params.args || []).map(a => a.value || a.description || a.type).join(' ');
      // 只有 error / assert 计为硬错误；warning 单列（mpegts.js 的 MSE 提示属正常信息）
      (m.params.type === 'warning' ? warns : errs).push(line);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errs.push('[exception] ' + (m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push('[log] ' + m.params.entry.text);
  });
  await send('Runtime.enable');
  await send('Log.enable');

  // 等渲染器初始化
  await sleep(4000);

  const probe = `(function(){
    var out = {};
    out.readyState = document.readyState;
    out.title = document.title;
    var sv = document.getElementById('stVer');
    out.stVer = sv ? sv.textContent.trim() : null;
    out.acall = typeof window.acall;
    out.fns = {
      alPushDom: typeof alPushDom,
      alBitRateToKbps: typeof alBitRateToKbps,
      alPlayDomsOf: typeof alPlayDomsOf,
      alBitRateToKbpsSample: (typeof alBitRateToKbps === 'function') ? alBitRateToKbps(895958.4) : null,
      // r57 外部地址流：函数是否进包 + 行为是否可用
      extAdd: typeof extAdd, extRemove: typeof extRemove, extMonList: typeof extMonList,
      extHistLoad: typeof extHistLoad, extRenderHistory: typeof extRenderHistory,
      extMeasure: typeof extMeasure, qRenderExt: typeof qRenderExt, extHistOwn: typeof extHistOwn
    };
    // 行为校验：地址校验规则 + 外部流条目注入形态 + 历史归属幂等（纯内存操作，不落盘）
    try {
      out.extUrlCheck = { rtmp: /http/.test(extUrlOk('rtmp://x/live/a') || ''), bad: !!extUrlOk('http://cdn/a.ts'), ok: extUrlOk('http://cdn/live/a.flv') === '' };
    } catch (e) { out.extUrlCheck = 'ERR ' + e.message; }
    try {
      var before = (window._monList || []).length;
      // _monList 未初始化时 extSync 无对象可同步（真实应用首次 refreshMonitor 后必然存在，
      // 且 refreshMonitor 自身就 concat 了 extMonList）；冒烟里补一个空数组模拟刷新后的状态
      if (window._monList === undefined) window._monList = [];
      extList().push({ id: 'smokeExt', url: 'http://127.0.0.1:1/smoke.flv', name: '冒烟流', addedAt: new Date().toISOString(), down: false });
      var ml = extMonList().filter(function (e) { return e._extId === 'smokeExt'; })[0] || {};
      out.extShape = { prov: ml._prov, app: ml.AppName, stream: ml.StreamName, dom: ml.DomainName, extId: ml._extId };
      extSync();
      out.injected = (window._monList || []).filter(function (s) { return s._prov === 'external'; }).length;
      // 幂等：同一次会话两次收尾应更新同一条历史（r57 缺陷回归）
      extSessPush('smokeExt', 1000, 25, '1280×720');
      extHistFinalize('smokeExt', '断流');
      var n1 = extHistLoad().length;
      extHistFinalize('smokeExt', '手动关闭');
      out.histIdem = { grew: extHistLoad().length - n1, reason: (extHistLoad().filter(function (h) { return h.id === 'smokeExt'; })[0] || {}).reason };
      // 清场
      state.cfg.extStreams = extList().filter(function (x) { return x.id !== 'smokeExt'; });
      delete _extSess['smokeExt'];
      localStorage.removeItem('wb_tclive_exthist');
      extSync();
      out.restored = (window._monList || []).filter(function (s) { return s._prov === 'external'; }).length;
      out.before = before;
    } catch (e) { out.extBehavior = 'ERR ' + e.message; }
    out.views = document.querySelectorAll('[data-view]').length;
    out.scripts = document.querySelectorAll('script').length;
    return JSON.stringify(out);
  })()`;

  const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: false });
  const raw = r.result && r.result.result && r.result.result.value;
  let info = null; try { info = JSON.parse(raw); } catch (e) {}

  console.log('=== 打包 App 冒烟 ===');
  console.log('app     :', APP);
  console.log('target  :', targets.url);
  console.log('info    :', JSON.stringify(info, null, 2));
  console.log('errors  :', errs.length ? JSON.stringify(errs.slice(0, 8), null, 2) : '（无）');
  console.log('warns   :', warns.length ? JSON.stringify(warns.slice(0, 5), null, 2) : '（无）');

  let pass = true;
  if (!info) { console.log('FAIL: 无法解析探针结果'); pass = false; }
  else {
    const need = (cond, msg) => { if (!cond) { console.log('FAIL: ' + msg); pass = false; } };
    need(info.readyState === 'complete', 'readyState=' + info.readyState);
    need(!!info.stVer && info.stVer.indexOf(EXPECT_VER) >= 0, 'stVer=' + info.stVer + ' 不含 ' + EXPECT_VER);
    need(info.acall === 'function', 'window.acall 不是函数');
    need(info.fns.alPushDom === 'function', 'alPushDom 未定义');
    need(info.fns.alPlayDomsOf === 'function', 'alPlayDomsOf 未定义');
    need(info.fns.alBitRateToKbpsSample === 7168, 'alBitRateToKbps(895958.4)=' + info.fns.alBitRateToKbpsSample + ' 期望 7168');
    // r57 外部地址流：函数进包
    ['extAdd', 'extRemove', 'extMonList', 'extHistLoad', 'extRenderHistory', 'extMeasure', 'qRenderExt', 'extHistOwn']
      .forEach(k => need(info.fns[k] === 'function', '外部地址流函数缺失：' + k));
    // r57 行为校验（在打包产物上下文中真跑一遍）
    const uc = info.extUrlCheck || {};
    need(uc.rtmp === true, 'extUrlOk 未拦截 rtmp://（' + JSON.stringify(uc) + '）');
    need(uc.bad === true, 'extUrlOk 未拦截非 .flv/.m3u8 地址');
    need(uc.ok === true, 'extUrlOk 未接受合法 http-flv 地址');
    const es = info.extShape || {};
    need(es.prov === 'external' && es.app === 'ext' && es.stream === 'smokeExt' && !!es.dom,
      '外部流注入形态异常：' + JSON.stringify(es));
    need(info.injected === 1, '_monList 未注入外部流（injected=' + info.injected + '）');
    need(info.restored === 0, '清场后外部流未从 _monList 移除（restored=' + info.restored + '）');
    const hi = info.histIdem || {};
    need(hi.grew === 0, '历史收尾不幂等：同一次会话重复收尾多出 ' + hi.grew + ' 条（r57 缺陷回归）');
    need(hi.reason === '断流', '历史结束原因未保留首次值：' + hi.reason);
    // 过滤无害告警：无 GPU / 权限 / 自动填充
    const fatal = errs.filter(e => !/GPU|gpu|Autofill|autofill|permission|Permissions|DevTools|沙箱|sandbox|Electron Security/i.test(e));
    need(fatal.length === 0, '存在运行时报错 ' + fatal.length + ' 条');
  }
  console.log(pass ? '=== SMOKE PASS ===' : '=== SMOKE FAIL ===');
  try { child.kill('SIGKILL'); } catch (e) {}
  await sleep(600);
  try { child.kill('SIGKILL'); } catch (e) {}
  process.exit(pass ? 0 : 1);
})();
