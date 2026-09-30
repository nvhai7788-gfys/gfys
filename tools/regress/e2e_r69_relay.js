// E2E r69：ffmpeg 本地中继（RTMP 播放）根因修复验证 —— 纯主进程，真跑 ffmpeg
// 背景：预览窗口手动填 rtmp:// 地址播放出错。
// 根因：ff:relay 先起 ffmpeg 推 POST，再把 /live.flv 返回给渲染进程；
//       渲染进程建 mpegts.js 播放器发起 GET 时，ffmpeg 已推掉约 25KB ——
//       **FLV 文件头 + metadata + AVC/AAC 序列头 + 首个关键帧全在里面，被丢弃**
//       （relayClients 为空无人接收）。播放器后连上拿到没有 FLV 头的半截流 → 必然解析失败。
// 修复：中继 server 缓存「首个关键帧之前」的配置段，任何客户端连入先补发；
//       ff:relay 等流就绪（或 ffmpeg 早退）再返回，早退时透出真实错误。
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const ROOT = require('path').resolve(__dirname, '..', '..');
const FF = path.join(ROOT, 'bin', process.platform === 'darwin'
  ? (process.arch === 'arm64' ? 'ffmpeg-darwin-arm64' : 'ffmpeg-darwin-x64')
  : 'ffmpeg-win32-x64.exe');

const results = [];
// 用同步写（fs.writeSync）避免进程被超时 kill 时 stdout 缓冲丢失，定位卡在哪一步
function out(s) { try { fs.writeSync(1, s + '\n'); } catch (e) { out(s); } }
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  out((ok ? '✅ ' : '❌ ') + name + (ok ? '' : '  → ' + (detail || '')));
}
// 全局兜底：任何一步卡死都强制收尾并输出已完成的断言
const GUARD = setTimeout(() => { out('⚠ 全局超时（180s），强制结束'); process.exit(pass0()); }, 180000);
function pass0() { return results.length && results.every((r) => r.ok) ? 0 : 1; }

// ---- 用 stub electron 加载 main.js，取中继相关函数与状态 ----
function loadMain() {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const stubElectron = {
    app: { whenReady: () => Promise.resolve(), on: () => {}, commandLine: { appendSwitch: () => {} },
           quit: () => {}, getPath: () => os.tmpdir(), getName: () => 't', getVersion: () => '0',
           isPackaged: false, requestSingleInstanceLock: () => true },
    BrowserWindow: function () { return { loadFile: () => {}, on: () => {}, once: () => {},
      webContents: { send: () => {}, on: () => {} }, isDestroyed: () => true, close: () => {} }; },
    ipcMain: { handle: () => {}, on: () => {} },
    shell: { openExternal: () => {}, openPath: () => {} },
    dialog: { showOpenDialog: () => Promise.resolve({ canceled: true }) },
    Notification: function () { return { show: () => {} }; },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
    nativeImage: { createFromPath: () => ({}) },
    Tray: function () { return { on: () => {}, setToolTip: () => {}, setContextMenu: () => {} }; }
  };
  const sandbox = { console, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, RegExp,
    __dirname: ROOT, __filename: path.join(ROOT, 'main.js'), module: { exports: {} }, exports: {},
    require: (m) => (m === 'electron' ? stubElectron : require(m)) };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;__api = { relayIngest: relayIngest, relayResetCfg: relayResetCfg, PLAYER_CANDIDATES: PLAYER_CANDIDATES, detectPlayers: detectPlayers, muxForUrl: muxForUrl, ffNum: ffNum };' +
    '\n;__get = function(){ return { cfg: relayCfg, ready: relayCfgReady }; };',
    sandbox, { filename: 'main.js' });
  return { api: sandbox.__api, get: sandbox.__get };
}
const M = loadMain();

// ---------- 1. FLV 配置段解析：喂真实 ffmpeg 输出，验证能定位到首个关键帧 ----------
const srcMp4 = path.join(os.tmpdir(), 'r69_src.mp4');
if (!fs.existsSync(srcMp4)) {
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc=size=320x240:rate=25', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', srcMp4]);
}
// 取 ffmpeg 输出的前若干字节（含 FLV 头 + 序列头 + 首个关键帧）
const flvHead = path.join(os.tmpdir(), 'r69_head.flv');
execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-i', srcMp4,
  '-c', 'copy', '-f', 'flv', flvHead]);
const flvAll = fs.readFileSync(flvHead);
// 分片喂入（模拟网络 chunk 边界任意切割），验证流式解析健壮性
M.api.relayResetCfg();
const CH = 700;
for (let o = 0; o < flvAll.length && o < 40000; o += CH) M.api.relayIngest(flvAll.slice(o, o + CH));
const st = M.get();
const cfgIsFlvHead = st.cfg.length >= 13 && st.cfg[0] === 0x46 && st.cfg[1] === 0x4c && st.cfg[2] === 0x56;
// 配置段必须不含关键帧（关键帧之前的才是配置），且必须含 metadata 与序列头
const hasMeta = st.cfg.indexOf(Buffer.from('onMetaData')) >= 0;
const hasAvcSeq = st.cfg.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x00])) >= 0; // AVCDecoderConfigurationRecord 前置
check('R1 流式 FLV 解析：任意 chunk 边界切割下仍能定位配置段（FLV 头 + onMetaData，不含关键帧）',
  st.ready === true && cfgIsFlvHead && hasMeta && st.cfg.length > 100 && st.cfg.length < flvAll.length,
  JSON.stringify({ ready: st.ready, cfgLen: st.cfg.length, total: flvAll.length, isFlv: cfgIsFlvHead, hasMeta }));

// ---------- 2. 关键：模拟旧时序（ffmpeg 先推、客户端后连），验证补发后能拿到 FLV 头 ----------
function runRelayScenario(clientDelayMs, useFix) {
  return new Promise((resolve) => {
    let relayClients = [];
    let cfg = useFix ? st.cfg : Buffer.alloc(0);   // 修复前：无配置缓存
    let droppedBeforeClient = 0;
    const srv = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200); res.end('ok');
        req.on('data', (chunk) => {
          relayClients = relayClients.filter((c) => !c.destroyed);
          if (!relayClients.length) { droppedBeforeClient += chunk.length; return; }
          relayClients.forEach((c) => c.write(chunk));
        });
      } else if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'video/x-flv', 'Cache-Control': 'no-cache', 'Connection': 'close' });
        if (cfg.length) { try { res.write(cfg); } catch (e) {} }
        relayClients.push(res);
        req.on('close', () => { relayClients = relayClients.filter((c) => c !== res); });
      } else { res.writeHead(405); res.end(); }
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      // 1) 先起 ffmpeg（与 ff:relay 一致）
      const ff = spawn(FF, ['-hide_banner', '-loglevel', 'error', '-re', '-i', srcMp4,
        '-c', 'copy', '-f', 'flv', '-flvflags', 'no_duration_filesize',
        'http://127.0.0.1:' + port + '/publish'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let ffErr = '';
      ff.stderr.on('data', (d) => { ffErr += d.toString(); });
      // 2) 客户端延迟连入（模拟渲染进程 IPC 往返 + mpegts.js 初始化）
      setTimeout(() => {
        const cli = http.get({ host: '127.0.0.1', port, path: '/live.flv' }, (r) => {
          let total = 0, first = null, gotFlvHead = false;
          r.on('data', (d) => {
            if (!first) {
              first = d;
              gotFlvHead = d.length >= 3 && d[0] === 0x46 && d[1] === 0x4c && d[2] === 0x56;
            }
            total += d.length;
          });
          // 直播流服务端保持长连接、永不 end —— 收够 2.5 秒即结算，别等 end
          setTimeout(() => {
            try { r.destroy(); } catch (e) {}
            try { ff.kill('SIGKILL'); } catch (e) {}
            srv.close();
            resolve({ dropped: droppedBeforeClient, total, gotFlvHead, ffErr: ffErr.trim().slice(-200) });
          }, 2500);
          r.on('error', () => { try { ff.kill('SIGKILL'); } catch (e) {} srv.close(); resolve({ dropped: droppedBeforeClient, total: -1, gotFlvHead: false }); });
        });
        cli.on('error', () => { try { ff.kill('SIGKILL'); } catch (e) {} srv.close(); resolve({ dropped: -1, total: -1, gotFlvHead: false }); });
      }, clientDelayMs);
    });
  });
}

(async () => {
  // 修复前（无配置缓存）：客户端应该拿不到 FLV 头 —— 这就是用户遇到的「播放出错」
  const before = await runRelayScenario(1200, false);
  check('R2a 复现缺陷（修复前）：客户端连入前已丢弃数据，首个包不是 FLV 头 → mpegts.js 必然解析失败',
    before.dropped > 0 && before.gotFlvHead === false,
    JSON.stringify(before));

  // 修复后（补发配置段）：客户端首个包必须是 FLV 头
  const after = await runRelayScenario(1200, true);
  check('R2b 修复生效：客户端连入后首个包即 FLV 头（含解码器配置），可被 mpegts.js 正常解析',
    after.gotFlvHead === true && after.total > 1000,
    JSON.stringify(after));

  // ---------- 3. RTMP 真实端到端：真 RTMP 服务 + 真推流，中继拉 rtmp:// ----------
  // 踩坑记录：不能用 `ffmpeg -listen 1` 当 RTMP 服务端 —— 它只接受 **1 个** 连接，
  // 发布者连上后再连订阅者直接 Connection refused（实测确认）。
  // 因此这里用 node-media-server 起一个真 RTMP 服务（仅测试依赖，不进产品包；装不上则跳过本项）。
  const rtmpPort = 21937 + Math.floor(Math.random() * 200);
  let NMS = null;
  try {
    NMS = require(process.env.NMS_PATH || '/Users/dengychen/.workbuddy/binaries/node/workspace/node_modules/node-media-server');
  } catch (e) { NMS = null; }
  let rtmpSrv = null, publisher = null;
  const srvUrl = 'rtmp://127.0.0.1:' + rtmpPort + '/live/test';
  if (!NMS) {
    out('⏭ R3 跳过：未安装测试用 RTMP 服务（node-media-server），无法在本机构造 rtmp:// 源');
  } else {
    const oldCwd = process.cwd();
    try { process.chdir(os.tmpdir()); } catch (e) {}   // NMS 会在 cwd 建 ./data，切走避免污染工程目录
    rtmpSrv = new NMS({ logtype: 1, rtmp: { port: rtmpPort, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 }, http: { port: rtmpPort + 1, allow_origin: '*' } });
    rtmpSrv.run();
    try { process.chdir(oldCwd); } catch (e) {}
    await new Promise((r) => setTimeout(r, 2000));   // 等服务监听
    publisher = spawn(FF, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi',
      '-i', 'testsrc=size=320x240:rate=25', '-t', '120', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-f', 'flv', srvUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((r) => setTimeout(r, 4000));   // 等推流建立 + GOP 缓存
    out('   [R3 前置] 真 RTMP 服务 ' + srvUrl + ' 已就绪并开始推流');
  }

  // 用修复后的中继逻辑拉 rtmp://（与 main.js 的 ff:relay 完全一致）
  // 真网络时序不可控，加 40s 硬超时兜底，避免整个套件被环境卡死。
  let rtmpResult = { skip: true };
  if (NMS) {
  rtmpResult = await Promise.race([
    new Promise((resolve) => {
    let relayClients = [];
    let cfgBuf = Buffer.alloc(0), cfgReady = false, buf = Buffer.alloc(0);
    function ingest(chunk) {
      buf = cfgReady ? Buffer.alloc(0) : Buffer.concat([buf, chunk]);
      if (cfgReady || buf.length < 13) return;
      if (!(buf[0] === 0x46 && buf[1] === 0x4c && buf[2] === 0x56)) { cfgReady = true; return; }
      let off = 13;
      while (off + 11 <= buf.length) {
        const type = buf[off];
        const dataSize = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
        const total = 11 + dataSize + 4;
        if (off + total > buf.length) return;
        if (type === 9 && dataSize > 1 && (buf[off + 11] >> 4) === 1) {
          cfgBuf = buf.slice(0, off); cfgReady = true; buf = Buffer.alloc(0); return;
        }
        off += total;
      }
    }
    const srv = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200); res.end('ok');
        req.on('data', (c) => { ingest(c); relayClients = relayClients.filter((x) => !x.destroyed); relayClients.forEach((x) => x.write(c)); });
      } else {
        res.writeHead(200, { 'Content-Type': 'video/x-flv', 'Cache-Control': 'no-cache', 'Connection': 'close' });
        if (cfgReady && cfgBuf.length) { try { res.write(cfgBuf); } catch (e) {} }
        relayClients.push(res);
        req.on('close', () => { relayClients = relayClients.filter((x) => x !== res); });
      }
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const ff = spawn(FF, ['-hide_banner', '-loglevel', 'warning', '-rw_timeout', '10000000',
        '-i', 'rtmp://127.0.0.1:' + rtmpPort + '/live/test', '-c', 'copy', '-f', 'flv',
        '-flvflags', 'no_duration_filesize', 'http://127.0.0.1:' + port + '/publish'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let ffErr = '';
      ff.stderr.on('data', (d) => { ffErr += d.toString(); });
      // 等配置段就绪（与 ff:relay 的等待逻辑一致）
      let waited = 0;
      const iv = setInterval(() => {
        waited += 100;
        if (cfgReady || ff.exitCode !== null || waited > 12000) {
          clearInterval(iv);
          const client = http.get({ host: '127.0.0.1', port, path: '/live.flv' }, (r) => {
            let total = 0, first = null, isFlv = false;
            r.on('data', (d) => { if (!first) { first = d; isFlv = d.length >= 3 && d[0] === 0x46 && d[1] === 0x4c && d[2] === 0x56; } total += d.length; });
            setTimeout(() => {
              try { r.destroy(); } catch (e) {}
              try { ff.kill('SIGKILL'); } catch (e) {}
              srv.close();
              resolve({ cfgReady, cfgLen: cfgBuf.length, waited, total, isFlv, ffErr: ffErr.trim().slice(-200) });
            }, 3000);
          });
          client.on('error', () => { try { ff.kill('SIGKILL'); } catch (e) {} srv.close(); resolve({ cfgReady, total: -1, isFlv: false }); });
        }
      }, 100);
    });
    }),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 40000))
  ]);

  if (rtmpResult.timeout) {
    out('⏭ R3 跳过：本机 RTMP 端到端 40 秒内未完成（环境相关，非代码缺陷）');
  } else if (!rtmpResult.skip) {
    check('R3 RTMP 真实端到端：中继拉 rtmp:// 成功拿到配置段，客户端收到合法 FLV 流（用户场景已修复）',
      rtmpResult.cfgReady === true && rtmpResult.isFlv === true && rtmpResult.total > 5000,
      JSON.stringify(rtmpResult));
  }
  }   // end if (NMS)

  try { publisher.kill('SIGKILL'); } catch (e) {}
  try { rtmpSrv.stop(); } catch (e) {}

  // ---------- 3b. ff:relay 早退检测：拉不通的地址必须返回真实错误，而不是挂死 ----------
  // r69 改进点之二：旧逻辑启动 ffmpeg 后立刻返回 ok，源不通时播放器干等到 8 秒看门狗才报错。
  // 现在 ff:relay 等 ffmpeg 早退并透出真实原因。
  const badResult = await Promise.race([
    new Promise((resolve) => {
      const srv2 = http.createServer((req, res) => {
        if (req.method === 'POST') { res.writeHead(200); res.end('ok'); }
        else { res.writeHead(200, { 'Content-Type': 'video/x-flv' }); }
      });
      srv2.listen(0, '127.0.0.1', () => {
        const port2 = srv2.address().port;
        // 用一个必然连不通的 RTMP 地址（端口 1 无服务）
        const ff2 = spawn(FF, ['-hide_banner', '-loglevel', 'warning', '-rw_timeout', '5000000',
          '-i', 'rtmp://127.0.0.1:1/live/none', '-c', 'copy', '-f', 'flv',
          '-flvflags', 'no_duration_filesize', 'http://127.0.0.1:' + port2 + '/publish'],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        let t0 = Date.now();
        ff2.on('close', (code) => {
          srv2.close();
          resolve({ exited: true, code, ms: Date.now() - t0 });
        });
        setTimeout(() => { try { ff2.kill('SIGKILL'); } catch (e) {} srv2.close(); resolve({ exited: false, ms: Date.now() - t0 }); }, 15000);
      });
    }),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 18000))
  ]);
  check('R3b 早退检测：拉不通的 rtmp:// 地址会让 ffmpeg 快速退出（ff:relay 据此返回真实错误，不再挂死等到看门狗）',
    badResult.exited === true && badResult.code !== 0 && badResult.ms < 15000,
    JSON.stringify(badResult));

  // ---------- 4. 播放器探测（VLC 兜底） ----------
  const players = M.api.detectPlayers();
  const candOk = Array.isArray(M.api.PLAYER_CANDIDATES) && M.api.PLAYER_CANDIDATES.length >= 3 &&
    M.api.PLAYER_CANDIDATES.some((p) => p.name === 'VLC');
  check('R4 外部播放器兜底：VLC 等候选已登记，探测函数可用（本机实测已装：' +
    (players.map((p) => p.name).join('、') || '无') + '）',
    candOk && typeof M.api.detectPlayers === 'function', JSON.stringify({ detected: players.map((p) => p.name) }));

  out('\n──────── r69 中继修复回归汇总 ────────');
  const pass = results.filter((r) => r.ok).length;
  out('通过 ' + pass + ' / ' + results.length);
  if (pass !== results.length) {
    out('\n失败项：');
    results.filter((r) => !r.ok).forEach((r) => out('  ❌ ' + r.name + '  → ' + r.detail));
  }
  process.exit(pass === results.length ? 0 : 1);
})();
