// E2E r70：编码器能力矩阵按「族」判定 + 码率解析/推荐 + 4K H.265 参数正确性（真跑 ffmpeg 验证）
// 背景（本轮要解决的四个问题）：
//  1. 老代码用 `codec === 'libx265'` 判断 HEVC —— 一旦加入 hevc_videotoolbox / hevc_nvenc
//     等硬件编码器就会漏判，放行 HEVC 进 FLV 直接崩（RTMP 推流启动即退）。
//  2. `-bufsize` 用 parseInt(videoBitrate) 计算 —— 用户填 "8M" 会算成 16k，4K 码率直接崩。
//  3. 没有 4K H.265 预设，也没有码率建议 —— 用户不知道 H.265 该给多少码率。
//  4. 硬件编码器不接受 x264 那套 -preset（nvenc 传 veryfast 直接报 Option not found）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawn } = require('child_process');
const ROOT = require('path').resolve(__dirname, '..', '..');
const FFBIN = path.join(ROOT, 'bin', process.platform === 'darwin'
  ? (process.arch === 'arm64' ? 'ffmpeg-darwin-arm64' : 'ffmpeg-darwin-x64')
  : 'ffmpeg-win32-x64.exe');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '✅ ' : '❌ ') + name + (ok ? '' : '  → ' + (detail || '')));
}

// 用 stub 掉 electron 的沙箱执行 main.js，只取纯函数做断言（不启窗口 / 不注册 IPC）
function loadMainFns() {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const stubElectron = {
    app: { whenReady: () => Promise.resolve(), on: () => {}, commandLine: { appendSwitch: () => {} },
           quit: () => {}, getPath: () => os.tmpdir(), getName: () => 'test', getVersion: () => '0.0.0',
           isPackaged: false, requestSingleInstanceLock: () => true },
    BrowserWindow: function () { return { loadFile: () => {}, on: () => {}, once: () => {},
      webContents: { send: () => {}, on: () => {}, executeJavaScript: () => {} },
      isDestroyed: () => true, show: () => {}, close: () => {}, setTitle: () => {} }; },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
    shell: { openExternal: () => {}, openPath: () => {}, showItemInFolder: () => {} },
    dialog: { showOpenDialog: () => Promise.resolve({ canceled: true }), showMessageBox: () => {}, showSaveDialog: () => {} },
    Notification: function () { return { show: () => {} }; },
    screen: { getPrimaryDisplay: () => ({ id: 1, label: 'primary', bounds: { x: 0, y: 0, width: 1440, height: 900 }, workAreaSize: { width: 1440, height: 900 } }), getAllDisplays: () => [{ id: 1, label: 'primary', bounds: { x: 0, y: 0, width: 1440, height: 900 }, workAreaSize: { width: 1440, height: 900 } }], on: () => {} },
    Menu: { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} },
    nativeImage: { createFromPath: () => ({}) },
    Tray: function () { return { on: () => {}, setToolTip: () => {}, setContextMenu: () => {} }; }
  };
  const sandbox = {
    console, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error,
    __dirname: ROOT, __filename: path.join(ROOT, 'main.js'), module: { exports: {} },
    exports: {}, require: (m) => (m === 'electron' ? stubElectron : require(m.startsWith('.') ? path.resolve(ROOT, m) : m))
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;__out = { encFamily, isHwEncoder, codecMuxProblem, muxForUrl, bitrateK, recommendBitrateK, buildPushArgs, listVideoEncoders };',
    sandbox, { filename: 'main.js' });
  return sandbox.__out;
}
const M = loadMainFns();

// ---------- 1. 编码器族判定：硬件 HEVC 必须被识别为 hevc（老代码只认 libx265，会漏判） ----------
const fam = {
  libx264: M.encFamily('libx264'),
  h264_vt: M.encFamily('h264_videotoolbox'),
  h264_nvenc: M.encFamily('h264_nvenc'),
  h264_qsv: M.encFamily('h264_qsv'),
  libx265: M.encFamily('libx265'),
  hevc_vt: M.encFamily('hevc_videotoolbox'),
  hevc_nvenc: M.encFamily('hevc_nvenc'),
  hevc_qsv: M.encFamily('hevc_qsv'),
  vp9: M.encFamily('libvpx-vp9'),
  unknown: M.encFamily('whatever_thing')      // 未登记编码器按 H.264 兜底（保守，不误放行 HEVC）
};
check('R1 编码器按「族」判定：所有硬件 HEVC（videotoolbox / nvenc / qsv）都归入 hevc 族，' +
  '硬件 H.264 归入 h264 族（老代码只比对 libx265，新增硬件编码器会漏判放行 HEVC 进 FLV）',
  fam.libx264 === 'h264' && fam.h264_vt === 'h264' && fam.h264_nvenc === 'h264' && fam.h264_qsv === 'h264' &&
  fam.libx265 === 'hevc' && fam.hevc_vt === 'hevc' && fam.hevc_nvenc === 'hevc' && fam.hevc_qsv === 'hevc' &&
  fam.vp9 === 'vp9' && fam.unknown === 'h264',
  JSON.stringify(fam));

// ---------- 2. 容器兼容性：硬件 HEVC 同样不能进 FLV ----------
const mux = {
  libx265Flv: M.codecMuxProblem('libx265', 'flv', 'RTMP(FLV)'),
  hevcVtFlv: M.codecMuxProblem('hevc_videotoolbox', 'flv', 'RTMP(FLV)'),
  hevcNvencFlv: M.codecMuxProblem('hevc_nvenc', 'flv', 'RTMP(FLV)'),
  h264VtFlv: M.codecMuxProblem('h264_videotoolbox', 'flv', 'RTMP(FLV)'),
  h264NvencFlv: M.codecMuxProblem('h264_nvenc', 'flv', 'RTMP(FLV)'),
  hevcVtTs: M.codecMuxProblem('hevc_videotoolbox', 'mpegts', 'SRT(MPEG-TS)'),
  copyFlv: M.codecMuxProblem('copy', 'flv', 'RTMP(FLV)')
};
check('R2 容器兼容性按族判定：硬件 HEVC 进 FLV 同样被拦下（含 SRT/RTSP 补救指引），' +
  '硬件 H.264 与 copy 放行',
  !!mux.libx265Flv && !!mux.hevcVtFlv && !!mux.hevcNvencFlv &&
  /SRT/.test(mux.hevcVtFlv) && /RTSP/.test(mux.hevcVtFlv) &&
  mux.h264VtFlv === null && mux.h264NvencFlv === null && mux.hevcVtTs === null && mux.copyFlv === null,
  JSON.stringify({ hevcVtFlv: (mux.hevcVtFlv || '').slice(0, 40), h264VtFlv: mux.h264VtFlv, copyFlv: mux.copyFlv }));

// ---------- 3. 码率解析：修掉 "8M" → bufsize 16k 的老 bug ----------
const br = {
  k: M.bitrateK('8000k', 0), m: M.bitrateK('8M', 0), mDec: M.bitrateK('1.5M', 0),
  bare: M.bitrateK('5000', 0), upper: M.bitrateK('12000K', 0), space: M.bitrateK('8000 k', 0),
  junk: M.bitrateK('abc', 2500), empty: M.bitrateK('', 2500)
};
check('R3 码率解析：支持 8000k / 8M / 1.5M / 裸数字，非法值回落到默认（旧代码 parseInt("8M")=8 → bufsize 16k）',
  br.k === 8000 && br.m === 8000 && br.mDec === 1500 && br.bare === 5000 &&
  br.upper === 12000 && br.space === 8000 && br.junk === 2500 && br.empty === 2500,
  JSON.stringify(br));

// ---------- 4. 推荐码率：次线性模型，H.265 明显低于 H.264，且与既有场景预设对齐 ----------
const rec = {
  p1080_30: M.recommendBitrateK(1920, 1080, 30, 'h264'),
  p1080_60: M.recommendBitrateK(1920, 1080, 60, 'h264'),
  k4_30: M.recommendBitrateK(3840, 2160, 30, 'h264'),
  k4_60: M.recommendBitrateK(3840, 2160, 60, 'h264'),
  k4_30_hevc: M.recommendBitrateK(3840, 2160, 30, 'hevc'),
  k4_60_hevc: M.recommendBitrateK(3840, 2160, 60, 'hevc'),
  p720_30: M.recommendBitrateK(1280, 720, 30, 'h264')
};
// 断言要点：① 4K30 推荐值落在 7000~11000（线性外推会算出 18000k 这种离谱值）
//          ② H.265 约为 H.264 的 60~65%（这就是省带宽的价值）
//          ③ 与既有预设同量级：1080p60≈6000、4K60≈12000、720p30≈2500
check('R4 推荐码率：4K30≈8~9M/4K60≈12~13M（与既有预设同量级，排除线性外推的 18M 离谱值），' +
  'H.265 约为 H.264 的 62%',
  rec.p1080_30 === 4500 &&
  Math.abs(rec.p1080_60 - 6000) <= 800 &&
  rec.k4_30 >= 7000 && rec.k4_30 <= 11000 &&
  rec.k4_60 >= 11000 && rec.k4_60 <= 14000 &&
  Math.abs(rec.k4_30_hevc / rec.k4_30 - 0.62) < 0.05 &&
  Math.abs(rec.k4_60_hevc / rec.k4_60 - 0.62) < 0.05 &&
  rec.p720_30 >= 2200 && rec.p720_30 <= 3600,
  JSON.stringify(rec));

// ---------- 5. 推流参数：硬件编码器不得传 -preset/-tune；4K 大码率 bufsize 正确 ----------
const srcFile = path.join(os.tmpdir(), 'r70_src.mp4');
if (!fs.existsSync(srcFile)) {
  execFileSync(FFBIN, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc=size=320x240:rate=25', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', srcFile]);
}
const base = { source: { type: 'file', path: srcFile }, fps: 30, preset: 'veryfast', gopSec: 2,
  audioBr: '128k', outSize: '', flip: '', zoom: '', profile: '', loop: false, copy: false };

// 5a. 硬件 H.264（videotoolbox）：不带 -preset/-tune，带 -realtime/-allow_sw
const aHw = M.buildPushArgs(Object.assign({}, base,
  { rtmp: ['rtmp://a/live/1'], codec: 'h264_videotoolbox', videoBitrate: '8000k' }));
const t5a = {
  joined: aHw.join(' '),
  noPreset: aHw.indexOf('-preset') < 0,
  noTune: aHw.indexOf('-tune') < 0,
  realtime: aHw.indexOf('-realtime') >= 0,
  allowSw: aHw.indexOf('-allow_sw') >= 0,
  bufsize: aHw[aHw.indexOf('-bufsize') + 1],
  maxrate: aHw[aHw.indexOf('-maxrate') + 1]
};
check('R5a 硬件编码器参数：不传 -preset/-tune（nvenc 传 veryfast 会报 Option not found），' +
  'videotoolbox 带 -realtime/-allow_sw，4K 大码率 bufsize=2×目标',
  t5a.noPreset && t5a.noTune && t5a.realtime && t5a.allowSw &&
  t5a.bufsize === '16000k' && t5a.maxrate === '8400k',
  JSON.stringify(t5a));

// 5b. "8M" 写法：bufsize 必须是 16000k 而不是老逻辑的 16k
const aM = M.buildPushArgs(Object.assign({}, base,
  { rtmp: ['rtmp://a/live/1'], codec: 'libx264', videoBitrate: '8M' }));
const t5b = { bv: aM[aM.indexOf('-b:v') + 1], bufsize: aM[aM.indexOf('-bufsize') + 1] };
check('R5b 码率写法 "8M"：解析为 8000k，bufsize=16000k（旧代码 parseInt("8M")=8 → bufsize 16k，4K 必崩）',
  t5b.bv === '8000k' && t5b.bufsize === '16000k', JSON.stringify(t5b));

// 5c. 软件 HEVC：带 -preset/-tune，不带 -profile:v（HEVC 无此选项）
const aHevc = M.buildPushArgs(Object.assign({}, base,
  { rtmp: ['srt://b:10080?streamid=x'], codec: 'libx265', videoBitrate: '5000k', profile: 'high' }));
const t5c = {
  joined: aHevc.join(' '),
  preset: aHevc[aHevc.indexOf('-preset') + 1],
  tune: aHevc[aHevc.indexOf('-tune') + 1],
  noProfile: aHevc.indexOf('-profile:v') < 0,
  mpegts: aHevc.indexOf('mpegts') >= 0
};
check('R5c 软件 H.265 参数：保留 -preset/-tune zerolatency，不传 -profile:v（HEVC 无此选项），SRT 走 mpegts',
  t5c.preset === 'veryfast' && t5c.tune === 'zerolatency' && t5c.noProfile && t5c.mpegts,
  JSON.stringify(t5c));

// ---------- 6. 真跑 ffmpeg：验证生成的参数确实能编码（不只看字符串） ----------
function runFf(args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(FFBIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} resolve({ code: 'timeout', err }); }, timeoutMs || 60000);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, err }); });
  });
}
(async () => {
  // 取 5c 的参数，把输出地址换成本地文件（mpegts）真跑一次
  const outTs = path.join(os.tmpdir(), 'r70_hevc.ts');
  const runArgs = aHevc.slice();
  // 去掉 -progress/-nostats/-stats_period 与输出段（末尾 -f mpegts <url>），换成落盘
  const at = runArgs.indexOf('-progress');
  if (at >= 0) runArgs.splice(at, runArgs.length - at);
  runArgs.push('-t', '1', '-f', 'mpegts', '-y', outTs);
  const r6a = await runFf(runArgs, 90000);
  const ok6a = r6a.code === 0 && fs.existsSync(outTs) && fs.statSync(outTs).size > 1000;
  check('R6a 真跑 ffmpeg：H.265 → MPEG-TS 编码成功落盘（SRT/RTSP 推 H.265 的通道确实可用）',
    ok6a, JSON.stringify({ code: r6a.code, size: fs.existsSync(outTs) ? fs.statSync(outTs).size : 0, err: r6a.err.slice(-160) }));

  // HEVC → FLV 必须失败（这是 r68 已确认的硬约束，此处确认识别逻辑没被改坏）
  const outFlv = path.join(os.tmpdir(), 'r70_hevc.flv');
  try { fs.unlinkSync(outFlv); } catch (e) {}
  const r6b = await runFf(['-hide_banner', '-loglevel', 'error', '-y', '-i', srcFile,
    '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-t', '1', '-f', 'flv', outFlv], 90000);
  check('R6b 反例确认：H.265 → FLV 必然失败（故必须前置拦截 + 引导 SRT/RTSP）',
    r6b.code !== 0 && /not compatible with flv|hev/i.test(r6b.err),
    JSON.stringify({ code: r6b.code, err: r6b.err.slice(-160) }));

  // ---------- 7. 运行时编码器探测：只返回本机真正存在的编码器 ----------
  const encs = M.listVideoEncoders();
  const ids = (encs || []).map((e) => e.id);
  const h264VtHere = ids.indexOf('h264_videotoolbox') >= 0;
  // 本机（macOS）不应出现 nvenc/qsv/amf —— 写死菜单就会让用户点到本机没有的编码器
  const noForeign = ids.every((x) => !/nvenc|qsv|amf/.test(x)) || process.platform !== 'darwin';
  check('R7 运行时编码器探测：只列出本机 ffmpeg 真实具备的编码器' +
    '（macOS 实测含 videotoolbox、不含 nvenc —— 避免菜单里点了报 Unknown encoder）',
    Array.isArray(encs) && encs.length > 0 && ids.indexOf('libx264') >= 0 &&
    (process.platform !== 'darwin' || h264VtHere) && noForeign,
    JSON.stringify({ count: ids.length, ids: ids }));

  console.log('\n──────── r70 编码器/码率回归汇总 ────────');
  const pass = results.filter((r) => r.ok).length;
  console.log('通过 ' + pass + ' / ' + results.length);
  if (pass !== results.length) {
    console.log('\n失败项：');
    results.filter((r) => !r.ok).forEach((r) => console.log('  ❌ ' + r.name + '  → ' + r.detail));
  }
  process.exit(pass === results.length ? 0 : 1);
})();
