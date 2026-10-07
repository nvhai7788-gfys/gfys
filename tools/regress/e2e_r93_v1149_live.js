// E2E r93（v1.1.49）：直播主流功能三件套 + 自动重连缺陷修复
//   1) 跑马灯滚动字幕（scrollXExpr / buildDrawtext / compileSceneGraph）
//   2) 音频滤镜落地 ffmpeg（composeAudioFilter 五类 + dB→线性换算 + main.js 接入）
//   3) 自动重连升级（退避阶梯 / 错误分类）+ 录制续录分段 + 僵尸任务清理
// 只做参数构造断言，不真起 ffmpeg 进程。
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..', '..');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '✅ ' : '❌ ') + name + (ok ? '' : '  → ' + (detail || '')));
}

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
    exports: {}, require: (m) => (m === 'electron' ? stubElectron
      : require(m.startsWith('.') ? path.resolve(ROOT, m) : m))
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;__out = { buildPushArgs, recordSegPath, ffReapProcs, ffList, ffProcs,' +
    ' RECONN_BACKOFF, FF_FATAL_ERR, FF_RTMP_ERR };', sandbox, { filename: 'main.js' });
  return sandbox.__out;
}

const M = loadMainFns();
const A = require(path.join(ROOT, 'ffmpeg-args.js'));
const { scrollXExpr, buildDrawtext, composeAudioFilter, compileSceneGraph } = A;

const base = {
  rtmp: ['rtmp://example.com/live/stream'],
  videoBitrate: '2500', outSize: '1280x720', fps: 25,
  copy: false, codec: 'libx264', preset: 'veryfast', gopSec: 2, audioBr: '128k',
  source: { type: 'file', path: '/tmp/main.mp4' }
};
function joined(args) { return args.join(' '); }

console.log('\n──── 1. 跑马灯滚动字幕 ────');

// A1 默认向左滚动
check('A1 scrollXExpr 向左：w-((t*v)%(w+text_w))',
  scrollXExpr(60, 'left') === 'w-((t*60)%(w+text_w))', scrollXExpr(60, 'left'));
// A2 向右滚动
check('A2 scrollXExpr 向右：((t*v)%(w+text_w))-text_w',
  scrollXExpr(60, 'right') === '((t*60)%(w+text_w))-text_w', scrollXExpr(60, 'right'));
// A3 非法速度兜底
check('A3 速度为 0 / 负数 / NaN → 兜底 60',
  scrollXExpr(0).indexOf('t*60') >= 0 && scrollXExpr(-5).indexOf('t*60') >= 0 &&
  scrollXExpr('abc').indexOf('t*60') >= 0);
// A4 用 % 而非 mod()，避免 filtergraph 里的逗号转义
check('A4 表达式不含逗号（filtergraph 安全）',
  scrollXExpr(80, 'left').indexOf(',') < 0 && scrollXExpr(80, 'right').indexOf(',') < 0);
// A5 drawtext 带 scroll → 覆盖静态 x
const dtS = buildDrawtext({ text: '直播中', scroll: true, scrollSpeed: 90, x: '10', y: '10' });
check('A5 buildDrawtext 滚动时 x 被滚动表达式覆盖',
  dtS.indexOf("x=w-((t*90)%(w+text_w))") >= 0 && dtS.indexOf(':y=10') >= 0, dtS);
// A6 不滚动 → 保留静态坐标
const dtN = buildDrawtext({ text: '直播中', x: '10', y: '20' });
check('A6 buildDrawtext 不滚动时保留静态 x', dtN.indexOf(':x=10:') >= 0, dtN);
// A7 文字内容里的冒号/引号仍被正确转义（滚动不破坏转义）
const dtE = buildDrawtext({ text: "a:b'c", scroll: true });
check('A7 滚动时文字转义仍然生效', dtE.indexOf("\\:") >= 0 && dtE.indexOf("\\'") >= 0, dtE);
// A8 compileSceneGraph：OBS 形态 settings.scroll 也能生效（-vf 路径）
const g1 = compileSceneGraph({ outSize: '1280x720' }, [
  { id: 't1', type: 'text_ft2_source', settings: { text: '公告', scroll: true, scroll_speed: 120, scroll_dir: 'right' } }
]);
check('A8 compileSceneGraph 文字带 settings.scroll → 输出滚动表达式',
  (g1.plain ? g1.plain.vf : g1.complex).indexOf('(t*120)%(w+text_w))-text_w') >= 0,
  JSON.stringify(g1));
// A9 compileSceneGraph：filter_complex 路径（有图片叠加时）也要滚动
const g2 = compileSceneGraph({ outSize: '1280x720' }, [
  { id: 'i1', type: 'image_source', settings: { file: '/tmp/logo.png' } },
  { id: 't1', type: 'text_ft2_source', settings: { text: '跑马灯', scroll: true, scroll_speed: 60, scroll_dir: 'left' } }
], { i1: 1 });
check('A9 有叠加源时（filter_complex 路径）文字仍滚动',
  g2.complex.indexOf('w-((t*60)%(w+text_w))') >= 0, JSON.stringify(g2.complex));

console.log('\n──── 2. 音频滤镜（OBS 同款音频链） ────');

// B1 空 / 未启用 → 空链
check('B1 无滤镜或全部未启用 → chain 为空',
  composeAudioFilter(null).chain === '' &&
  composeAudioFilter([{ id: 'gain_filter', enabled: false, settings: { db: 6 } }]).chain === '');
// B2 噪声抑制
check('B2 噪声抑制 → afftdn=nf=<dB>',
  composeAudioFilter([{ id: 'noise_suppress_filter', settings: { amount: -25 } }]).chain === 'afftdn=nf=-25',
  composeAudioFilter([{ id: 'noise_suppress_filter', settings: { amount: -25 } }]).chain);
// B3 增益
check('B3 增益 → volume=<n>dB',
  composeAudioFilter([{ id: 'gain_filter', settings: { db: 6 } }]).chain === 'volume=6dB');
// B4 压缩器：threshold 是线性值不是 dB（最容易踩的坑）—— -18dB → 0.1259
const c4 = composeAudioFilter([{ id: 'compressor_filter', settings: { threshold: -18, ratio: 4 } }]).chain;
check('B4 压缩器 threshold 做 dB→线性换算（默认 -18dB ≈ 0.1259）',
  /acompressor=threshold=0\.12[0-9]*/.test(c4) && c4.indexOf('ratio=4') >= 0, c4);
// B5 限幅器：-3dB → 0.7079，且不超过 1.0（ffmpeg 会拒）
const c5 = composeAudioFilter([{ id: 'limiter_filter', settings: { threshold: -3 } }]).chain;
const limVal = Number((c5.match(/limit=([\d.]+)/) || [])[1]);
check('B5 限幅器 -3dB → 0.7079 线性值', Math.abs(limVal - 0.7079) < 0.001, c5);
const c5b = composeAudioFilter([{ id: 'limiter_filter', settings: { threshold: 20 } }]).chain;
check('B5b 限幅器阈值被钳到 0dB（limit 不超过 1.0）',
  Number((c5b.match(/limit=([\d.]+)/) || [])[1]) <= 1, c5b);
// B6 噪声门
check('B6 噪声门 → agate 且 threshold/range 均做换算',
  /agate=threshold=0\.01/.test(composeAudioFilter([{ id: 'noise_gate_filter', settings: { threshold: -40 } }]).chain),
  composeAudioFilter([{ id: 'noise_gate_filter', settings: { threshold: -40 } }]).chain);
// B7 处理顺序固定（降噪→增益→门→压缩→限幅），与输入顺序无关
const c7 = composeAudioFilter([
  { id: 'limiter_filter', settings: {} },
  { id: 'noise_suppress_filter', settings: {} },
  { id: 'compressor_filter', settings: {} },
  { id: 'gain_filter', settings: {} },
  { id: 'noise_gate_filter', settings: {} }
]);
check('B7 乱序输入仍按 OBS 信号链顺序输出',
  c7.applied.join(',') === 'noise_suppress_filter,gain_filter,noise_gate_filter,compressor_filter,limiter_filter',
  c7.applied.join(','));
// B8 未知滤镜 → skipped 且不进链
const c8 = composeAudioFilter([{ id: 'no_such_filter', settings: {} }]);
check('B8 未知滤镜被跳过（不拼坏命令）',
  c8.chain === '' && c8.skipped.length === 1 && c8.skipped[0].id === 'no_such_filter');
// B9 越界参数钳制
const c9 = composeAudioFilter([{ id: 'gain_filter', settings: { db: 999 } }]).chain;
check('B9 增益 999dB 被钳到 30dB', c9 === 'volume=30dB', c9);
// B10 组合链用逗号连接且无嵌套逗号
const c10 = composeAudioFilter([
  { id: 'noise_suppress_filter', settings: { amount: -25 } },
  { id: 'gain_filter', settings: { db: 3 } },
  { id: 'limiter_filter', settings: { threshold: -3 } }
]);
const segs = c10.chain.split(',');
check('B10 多滤镜组合：段数正确且每段自身无逗号',
  segs.length === 3 && segs[0] === 'afftdn=nf=-25' && segs[1] === 'volume=3dB' && /^alimiter=/.test(segs[2]),
  c10.chain);

console.log('\n──── 3. main.js 接入音频滤镜 ────');

// C1 单路直通（无 filter_complex）→ 用 -af
const a1 = M.buildPushArgs(Object.assign({}, base, {
  audioFilters: [{ id: 'noise_suppress_filter', settings: { amount: -25 } }, { id: 'gain_filter', settings: { db: 5 } }]
}));
check('C1 单路音频 + 滤镜 → 用 -af 挂载（不强行构造 filter_complex）',
  joined(a1).indexOf('-af afftdn=nf=-25,volume=5dB') >= 0, joined(a1).slice(-200));
// C2 多路混音（主画面 + 叠加媒体源都有音频 → amix）→ 滤镜接在混音之后 [afin]→[aout]
const a2 = M.buildPushArgs(Object.assign({}, base, {
  sources: [{ id: 'f1', type: 'ffmpeg_source', settings: { local_file: '/tmp/b.mp4' } }],
  audioFilters: [{ id: 'limiter_filter', settings: { threshold: -3 } }]
}));
const j2 = joined(a2);
check('C2 多路混音时滤镜接在 amix 之后（[afin]→[aout]，且 amix 的 [aout] 被正确改名）',
  j2.indexOf('amix=inputs=2') >= 0 &&
  j2.indexOf('normalize=0[afin];[afin]alimiter=limit=') >= 0 &&
  j2.indexOf('[aout] -map [vout] -map [aout]') >= 0, j2.slice(-300));
// C2b 视频走 filter_complex 但音频单路直通 → 用 -af（不重复处理：音频未经 complex，只处理一次）
const a2b = M.buildPushArgs(Object.assign({}, base, {
  sources: [{ id: 'i1', type: 'image_source', settings: { file: '/tmp/logo.png' } }],
  audioFilters: [{ id: 'limiter_filter', settings: { threshold: -3 } }]
}));
const j2b = joined(a2b);
check('C2b 图片叠加（音频单路直通）→ 用 -af 且只出现一次',
  (j2b.match(/-af /g) || []).length === 1 && j2b.indexOf('-af alimiter=') >= 0 &&
  j2b.indexOf('-map 0:a?') >= 0, j2b.slice(-200));
// C3 独立音频源（device）+ 滤镜 → 滤镜在 amix/独立链之后
const a3 = M.buildPushArgs(Object.assign({}, base, {
  audioPlan: { mode: 'device', deviceName: '麦克风', deviceIndex: '1' },
  audioFilters: [{ id: 'gain_filter', settings: { db: 8 } }]
}));
check('C3 独立音频源 + 滤镜 → 滤镜作用于最终输出音轨',
  joined(a3).indexOf('volume=8dB') >= 0 && joined(a3).indexOf('[aout]') >= 0, joined(a3).slice(-260));
// C4 声音关闭（off）→ 不挂滤镜
const a4 = M.buildPushArgs(Object.assign({}, base, {
  audioPlan: { mode: 'off' },
  audioFilters: [{ id: 'gain_filter', settings: { db: 8 } }]
}));
check('C4 声音关闭时不挂音频滤镜', joined(a4).indexOf('volume=8dB') < 0 && joined(a4).indexOf('-an') >= 0);
// C5 无滤镜 → 不产生 -af（保持旧行为）
const a5 = M.buildPushArgs(Object.assign({}, base));
check('C5 未配置滤镜时不产生 -af（向后兼容）', joined(a5).indexOf('-af') < 0);

console.log('\n──── 4. 自动重连策略修复 ────');

// D1 退避阶梯（旧实现固定 5 秒）
check('D1 重连间隔为指数退避阶梯 [2,4,8,16,30]',
  JSON.stringify(M.RECONN_BACKOFF) === JSON.stringify([2, 4, 8, 16, 30]),
  JSON.stringify(M.RECONN_BACKOFF));
// D2 致命错误不重连
check('D2 致命错误（Unknown encoder）被识别为不可恢复',
  M.FF_FATAL_ERR.test('Unknown encoder \'libx265abc\'') === true);
// D3 网络错误不应被判成致命
check('D3 网络错误（Input/output error）不属于致命错误',
  M.FF_FATAL_ERR.test('Input/output error') === false);
// D4 关键 BUG 修复：ffmpeg 回显命令行含 rtmp:// 地址，不应被误判为网络错误
check('D4 仅含 rtmp:// 地址的日志不再被误判为网络错误（旧正则含裸 rtmp 会误判）',
  M.FF_RTMP_ERR.test('ffmpeg -f flv rtmp://example.com/live/stream') === false,
  '旧正则 /rtmp/ 会命中地址回显 → 任何退出都触发无意义重试');
// D5 真正的传输故障仍能被识别
check('D5 真正的传输故障仍被识别为可重连',
  M.FF_RTMP_ERR.test('Connection reset by peer') === true &&
  M.FF_RTMP_ERR.test('Input/output error') === true &&
  M.FF_RTMP_ERR.test('Connection timed out') === true);
// D6 录制续录分段：第 0 段保持原名
check('D6 recordSegPath(0) → 原文件名',
  M.recordSegPath('/tmp/rec.mp4', 0) === '/tmp/rec.mp4', M.recordSegPath('/tmp/rec.mp4', 0));
// D7 续录切新文件名，避免覆盖已录部分
check('D7 recordSegPath(1) → _part01 分段（不覆盖已录内容）',
  M.recordSegPath('/tmp/rec.mp4', 1) === '/tmp/rec_part01.mp4', M.recordSegPath('/tmp/rec.mp4', 1));
check('D7b recordSegPath(12) → 两位补零',
  M.recordSegPath('/tmp/rec.mp4', 12) === '/tmp/rec_part12.mp4', M.recordSegPath('/tmp/rec.mp4', 12));
// D8 无扩展名也能分段
check('D8 无扩展名路径也能正确分段',
  M.recordSegPath('/tmp/rec', 2) === '/tmp/rec_part02', M.recordSegPath('/tmp/rec', 2));

console.log('\n──── 5. 僵尸任务清理 ────');

// E1 已被接管的旧记录不进列表
M.ffProcs.set('zz_old', { proc: { once: () => {} }, cmd: 'x', kind: 'push', label: 'old',
  startedAt: 'x', logTail: [], exited: true, replacedBy: 'zz_new' });
const l1 = M.ffList().list;
check('E1 ff:list 过滤已被新进程接管的老记录（重连不再堆僵尸任务）',
  !l1.some((x) => x.id === 'zz_old'), JSON.stringify(l1.map((x) => x.id)));
// E2 列表带重连状态字段
M.ffProcs.set('zz_new', { proc: { once: () => {} }, cmd: 'x', kind: 'push', label: 'new',
  startedAt: 'x', logTail: [], exited: false, autoRestart: { tries: 2, gaveUp: false } });
const l2 = M.ffList().list;
const rec2 = l2.filter((x) => x.id === 'zz_new')[0];
check('E2 列表输出重连状态（供界面显示「重连中 x/5」）',
  rec2 && rec2.reconnect && rec2.reconnect.tries === 2, JSON.stringify(rec2));
// E3 回收：已被接管的记录会被 ffReapProcs 真正删除
M.ffReapProcs();
check('E3 ffReapProcs 删除被接管的记录', M.ffProcs.has('zz_old') === false);
// E4 清理后清理自身，不留污染
M.ffProcs.delete('zz_new');
check('E4 测试记录已清理', M.ffProcs.has('zz_new') === false);

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log('\nr93 直播功能与重连修复: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
