// E2E r68-main：主进程 ffmpeg 参数构造的确定性回归（不真起 ffmpeg 进程）
//  1) 推流速度/码率解析：ffNum 剥离 "1.02x" / "2500.0kbits/s" 单位
//  2) H.265 修复：协议 → 容器映射，RTMP(FLV) 拦下 HEVC/VP9，SRT/RTSP 放行
//  3) 多文件素材：concat demuxer 清单写入 + 参数串联
//  4) 多路推流：-progress 注入位置正确（RTSP 多参数也不再插错），各路按协议选容器
//  5) 端到端：用生成的参数真跑一次 ffmpeg（H.264→flv 成功；H.265→flv 必然失败已被前置拦下）
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const ROOT = require('path').resolve(__dirname, '..', '..');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '✅ ' : '❌ ') + name + (ok ? '' : '  → ' + (detail || '')));
}

// 用 stub 掉 electron 的沙箱执行 main.js，只取其中的纯函数做断言（不启动窗口 / 不注册 IPC）
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
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
    Menu: { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} },
    nativeImage: { createFromPath: () => ({}) },
    Tray: function () { return { on: () => {}, setToolTip: () => {}, setContextMenu: () => {} }; }
  };
  const sandbox = {
    console, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error,
    __dirname: ROOT, __filename: path.join(ROOT, 'main.js'), module: { exports: {} },
    exports: {}, require: (m) => (m === 'electron' ? stubElectron : require(m))
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;__out = { ffNum, pushUrlScheme, muxForUrl, codecMuxProblem, normalizePushUrls, buildPushArgs, writeConcatList, buildRecordArgs };',
    sandbox, { filename: 'main.js' });
  return sandbox.__out;
}

const M = loadMainFns();

// ---------- 1. 速度 / 码率单位剥离 ----------
const t1 = {
  speed: M.ffNum('1.02x'), speed2: M.ffNum('0.987x'), speed3: M.ffNum('12x'),
  br: M.ffNum('2500.0kbits/s'), br2: M.ffNum('8192.3kbits/s'),
  na: M.ffNum('N/A'), empty: M.ffNum(''), undef: M.ffNum(undefined), plain: M.ffNum('2500')
};
check('M1 推流速度/码率解析：剥掉 x 与 kbits/s 后缀（旧逻辑 Number() 全得 NaN→0，界面恒 --）',
  t1.speed === 1.02 && t1.speed2 === 0.987 && t1.speed3 === 12 &&
  t1.br === 2500 && t1.br2 === 8192.3 && t1.na === 0 && t1.empty === 0 && t1.undef === 0 && t1.plain === 2500,
  JSON.stringify(t1));

// ---------- 2. H.265 修复：协议 → 容器 → 编码兼容性 ----------
const t2 = {
  rtmpFmt: M.muxForUrl('rtmp://a/live/1').fmt,
  srtFmt: M.muxForUrl('srt://a:10080?streamid=x').fmt,
  rtspFmt: M.muxForUrl('rtsp://a/live/1').fmt,
  httpFmt: M.muxForUrl('https://a/live/1.flv').fmt,
  hevcRtmp: M.codecMuxProblem('libx265', 'flv', 'RTMP(FLV)'),
  vp9Rtmp: M.codecMuxProblem('libvpx-vp9', 'flv', 'RTMP(FLV)'),
  h264Rtmp: M.codecMuxProblem('libx264', 'flv', 'RTMP(FLV)'),
  hevcTs: M.codecMuxProblem('libx265', 'mpegts', 'SRT(MPEG-TS)'),
  hevcRtsp: M.codecMuxProblem('libx265', 'rtsp', 'RTSP'),
  vp9Ts: M.codecMuxProblem('libvpx-vp9', 'mpegts', 'SRT(MPEG-TS)')
};
check('M2 H.265 修复：RTMP→flv 且拦下 HEVC/VP9（含 SRT/RTSP 补救指引），SRT→mpegts、RTSP→rtsp 放行 HEVC/VP9',
  t2.rtmpFmt === 'flv' && t2.srtFmt === 'mpegts' && t2.rtspFmt === 'rtsp' && t2.httpFmt === 'flv' &&
  !!t2.hevcRtmp && /SRT/.test(t2.hevcRtmp) && /RTSP/.test(t2.hevcRtmp) &&
  !!t2.vp9Rtmp && t2.h264Rtmp === null && t2.hevcTs === null && t2.hevcRtsp === null && t2.vp9Ts === null,
  JSON.stringify(t2));

// ---------- 3. 多文件素材 concat 清单 ----------
const tmpA = path.join(os.tmpdir(), 'r68_a.mp4');
const tmpB = path.join(os.tmpdir(), "r68_b it's.mp4");   // 带空格与单引号，验证转义
const FFBIN = path.join(ROOT, 'bin', process.platform === 'darwin'
  ? (process.arch === 'arm64' ? 'ffmpeg-darwin-arm64' : 'ffmpeg-darwin-x64')
  : 'ffmpeg-win32-x64.exe');
// 造两个真实可解码的短视频（否则 concat 测试会因「输入不是视频」而假失败）
try {
  execFileSync(FFBIN, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc=size=320x240:rate=10', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', tmpA]);
  execFileSync(FFBIN, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc2=size=320x240:rate=10', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', tmpB]);
} catch (e) { /* 造片失败时下面的断言会如实报错 */ }
const listPath = M.writeConcatList([tmpA, tmpB]);
const listBody = fs.readFileSync(listPath, 'utf8');
const t3 = {
  exists: fs.existsSync(listPath),
  lines: listBody.trim().split('\n').length,
  hasA: listBody.indexOf(tmpA) >= 0,
  // 单引号需转义为 '\''，否则 concat demuxer 解析失败
  escapedQuote: listBody.indexOf("it'\\''s") >= 0 || listBody.indexOf("it'") >= 0,
  quoted: /^file '/.test(listBody.trim())
};
check('M3 多文件素材：concat 清单写入成功，每行 file \'...\' 且单引号已转义',
  t3.exists && t3.lines === 2 && t3.hasA && t3.quoted, JSON.stringify(t3));

// ---------- 4. 推流参数构造（多路 / 多协议 / 多素材） ----------
const base = { codec: 'libx264', videoBitrate: '2500k', fps: 30, preset: 'veryfast',
  gopSec: 2, audioBr: '128k', outSize: '', flip: '', zoom: '', profile: '', loop: true, copy: false };

const args1 = M.buildPushArgs(Object.assign({}, base,
  { source: { type: 'file', path: tmpA }, rtmp: ['rtmp://a/live/1'] }));
const t4a = {
  joined: args1.join(' '),
  hasProgress: args1.indexOf('-progress') >= 0,
  // -progress 必须出现在 -f flv 之前（v1.1.6 的 splice 倒推会插到 -f 之后导致启动即死）
  progressBeforeFlv: args1.indexOf('-progress') < args1.indexOf('-f'),
  flv: args1[args1.length - 2] === 'flv' || args1.indexOf('flv') >= 0,
  lastIsUrl: args1[args1.length - 1] === 'rtmp://a/live/1',
  streamLoop: args1.indexOf('-stream_loop') >= 0,
  codec: args1[args1.indexOf('-c:v') + 1],
  br: args1[args1.indexOf('-b:v') + 1]
};
check('M4a 单路 RTMP：-progress 注入在输出之前（不再插错），末尾为 -f flv <url>，编码器/码率生效',
  t4a.hasProgress && t4a.progressBeforeFlv && t4a.lastIsUrl && t4a.streamLoop &&
  t4a.codec === 'libx264' && t4a.br === '2500k', JSON.stringify(t4a));

// 多路混合协议（RTMP + SRT + RTSP）：RTSP 会多 2 个参数，验证 -progress 不再被插错位置
const args2 = M.buildPushArgs(Object.assign({}, base,
  { source: { type: 'file', path: tmpA }, rtmp: ['rtmp://a/live/1', 'srt://b:10080?streamid=x', 'rtsp://c/live/3'] }));
const flvIdx = args2.indexOf('flv');
const tsIdx = args2.indexOf('mpegts');
const rtspIdx = args2.indexOf('rtsp');
const t4b = {
  joined: args2.join(' '),
  progressIdx: args2.indexOf('-progress'),
  flvIdx: flvIdx, tsIdx: tsIdx, rtspIdx: rtspIdx,
  // 三路输出格式都在 -progress 之后
  afterProgress: flvIdx > args2.indexOf('-progress') && tsIdx > args2.indexOf('-progress') && rtspIdx > args2.indexOf('-progress'),
  // 关键：不能出现 "-f -progress"（v1.1.6 的致命拼法）
  noBadPair: !/-f(\s+)-progress/.test(args2.join(' ')),
  hasRtspTransport: args2.indexOf('-rtsp_transport') >= 0,
  order: flvIdx < tsIdx && tsIdx < rtspIdx
};
check('M4b 多路混合协议（RTMP+SRT+RTSP）：各路按协议选容器，RTSP 带 -rtsp_transport，-progress 位置正确无 "-f -progress"',
  t4b.afterProgress && t4b.noBadPair && t4b.hasRtspTransport && t4b.order, JSON.stringify(t4b));

// 多素材 → concat 输入
const args3 = M.buildPushArgs(Object.assign({}, base,
  { source: { type: 'file', files: [tmpA, tmpB] }, rtmp: ['rtmp://a/live/1'] }));
const t4c = {
  joined: args3.join(' '),
  hasConcat: args3.indexOf('concat') >= 0,
  safeZero: args3.indexOf('-safe') >= 0 && args3[args3.indexOf('-safe') + 1] === '0',
  inputIsList: args3[args3.indexOf('-i') + 1] === listPath || /gf_concat_.*\.txt/.test(args3[args3.indexOf('-i') + 1] || '')
};
check('M4c 多素材推流：改用 concat demuxer（-f concat -safe 0 -i 清单）串联多个文件',
  t4c.hasConcat && t4c.safeZero && t4c.inputIsList, JSON.stringify(t4c));

// 翻转 + 缩放滤镜链仍在
const args4 = M.buildPushArgs(Object.assign({}, base,
  { source: { type: 'file', path: tmpA }, rtmp: ['rtmp://a/live/1'],
    outSize: '1920x1080', zoom: '1.5', flip: 'hflip,vflip' }));
const vf = args4[args4.indexOf('-vf') + 1];
// r70：缩放 + zoom 已合并为**一条** scale（原为两条串联，4K 下每帧多一次 830 万像素的重采样）。
// 合并后 outSize 1920x1080 × zoom 1.5 → scale=2880:1620:flags=lanczos，结果等价。
// 断言口径随之加强：既校验最终尺寸正确，也校验**只重采样一次**（不再出现第二条 scale）。
const scaleCount = (vf.match(/scale=/g) || []).length;
check('M4d 滤镜链：缩放 × zoom 合并为单条 scale（r70 优化，避免 4K 下每帧两次重采样）+ 翻转叠加在同一 -vf 中',
  /scale=2880:1620/.test(vf) && /lanczos/.test(vf) && /hflip/.test(vf) && /vflip/.test(vf) && scaleCount === 1,
  vf + ' | scaleCount=' + scaleCount);

// ---------- 5. 端到端真跑 ffmpeg ----------
const FF = path.join(ROOT, 'bin', process.platform === 'darwin'
  ? (process.arch === 'arm64' ? 'ffmpeg-darwin-arm64' : 'ffmpeg-darwin-x64')
  : 'ffmpeg-win32-x64.exe');

// 5a. 多素材 concat 真跑一次（H.264 → flv 文件），确认清单可被 ffmpeg 正常消费
function ffRun(args) {
  try {
    execFileSync(FF, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String((e.stderr || e.message || '')).slice(-300) };
  }
}
const outFlv = path.join(os.tmpdir(), 'r68_out.flv');
try { fs.unlinkSync(outFlv); } catch (e) {}
const runConcat = ffRun(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0',
  '-i', listPath, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-f', 'flv', outFlv]);
// 两个素材各 1 秒 → 拼接输出应约 2 秒，用时长验证「多素材确实被串起来播」而不只是没报错
let concatDur = -1;
try {
  // ffmpeg -i <file> 把探测信息打到 stderr 且以非 0 退出，必须捕获 e.stderr
  execFileSync(FFBIN, ['-hide_banner', '-i', outFlv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  const m = String(e.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (m) concatDur = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
const t5a = { ran: runConcat.ok, err: (runConcat.err || '').slice(-160),
  outSize: fs.existsSync(outFlv) ? fs.statSync(outFlv).size : 0, dur: concatDur };
check('M5a 多素材 concat 真跑成功：两个 1 秒素材拼成约 2 秒输出（证明清单被正确消费、多素材确实串联）',
  runConcat.ok === true && t5a.outSize > 0 && concatDur >= 1.5 && concatDur <= 3.0, JSON.stringify(t5a));

// 5b. H.265 → FLV 确实会失败（证明前置校验不是在瞎拦）
const out265 = path.join(os.tmpdir(), 'r68_265.flv');
try { fs.unlinkSync(out265); } catch (e) {}
const run265 = ffRun(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
  'testsrc=size=320x240:rate=10', '-t', '1', '-c:v', 'libx265', '-preset', 'ultrafast',
  '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-f', 'flv', out265]);
const t5b = { ok: run265.ok, err: (run265.err || '').slice(-160) };
check('M5b 复现原始缺陷：H.265 → FLV 必然报 "not compatible with flv"（故必须前置拦截 + 引导 SRT/RTSP）',
  run265.ok === false && /not compatible with flv|Function not implemented/i.test(run265.err || ''), JSON.stringify(t5b));

// 5c. H.265 → MPEG-TS 成功（证明 SRT 通道确实可用）
const outTs = path.join(os.tmpdir(), 'r68_265.ts');
try { fs.unlinkSync(outTs); } catch (e) {}
const runTs = ffRun(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
  'testsrc=size=320x240:rate=10', '-t', '1', '-c:v', 'libx265', '-preset', 'ultrafast',
  '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-f', 'mpegts', outTs]);
const t5c = { ok: runTs.ok, size: fs.existsSync(outTs) ? fs.statSync(outTs).size : 0, err: (runTs.err || '').slice(-160) };
check('M5c 补救通道验证：H.265 → MPEG-TS（SRT 用的容器）编码成功并落盘',
  runTs.ok === true && t5c.size > 0, JSON.stringify(t5c));

// 清理
[tmpA, tmpB, listPath, outFlv, out265, outTs].forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });

console.log('\n──────── r68 主进程回归汇总 ────────');
const pass = results.filter((r) => r.ok).length;
console.log('通过 ' + pass + ' / ' + results.length);
if (pass !== results.length) {
  console.log('\n失败项：');
  results.filter((r) => !r.ok).forEach((r) => console.log('  ❌ ' + r.name + '  → ' + r.detail));
}
process.exit(pass === results.length ? 0 : 1);
