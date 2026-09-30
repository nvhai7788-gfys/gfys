// E2E r70-UI：渲染侧断言（真加载 index.html，驱动真实 DOM）
//  1) 编码器下拉是「运行时探测」出来的，只含本机具备的编码器（不再是写死的 3 项）
//  2) 4K H.265 场景预设存在，且会把编码器落到本机可用的 HEVC 编码器上
//  3) 码率建议器：换分辨率/帧率/编码族后推荐值跟着变，H.265 明显低于 H.264，可一键套用
//  4) 字体优化：全局 line-height 生效、控件行高未被撑高、数值列启用等宽数字
//  5) H.265 + RTMP 仍被协议预检拦下（按族判定，硬件 HEVC 同样拦）
const { app, BrowserWindow, ipcMain } = require('electron');
try {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
} catch (e) { /* 已 ready 时忽略 */ }
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '✅ ' : '❌ ') + name + (ok ? '' : '  → ' + (detail || '')));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 模拟主进程：ff:listEncoders 返回「本机真实具备」的编码器（macOS 实测口径）
  ipcMain.handle('ff:listEncoders', () => ({
    ok: true,
    list: [
      { id: 'libx264', fam: 'h264', label: 'H.264 软件编码（libx264，兼容性最好）', hw: false },
      { id: 'h264_videotoolbox', fam: 'h264', label: 'H.264 硬件 · VideoToolbox', hw: true },
      { id: 'libx265', fam: 'hevc', label: 'H.265/HEVC 软件编码（libx265）', hw: false },
      { id: 'hevc_videotoolbox', fam: 'hevc', label: 'H.265/HEVC 硬件 · VideoToolbox', hw: true },
      { id: 'libvpx-vp9', fam: 'vp9', label: 'VP9（libvpx-vp9）', hw: false }
    ]
  }));

  const win = new BrowserWindow({ width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  const ex = (js) => win.webContents.executeJavaScript(js);
  await wait(800);
  await ex("localStorage.clear(); 'ok'");

  // ---------- 1. 编码器下拉：运行时探测重建 ----------
  const a1 = await ex(`(function(){
    var sel = document.getElementById('lpCodec');
    var opts = [].slice.call(sel.options).map(function(o){ return o.value; });
    return { count: opts.length, opts: opts,
             hasVt: opts.indexOf('h264_videotoolbox') >= 0,
             hasHevcVt: opts.indexOf('hevc_videotoolbox') >= 0,
             hasNvenc: opts.some(function(v){ return /nvenc|qsv|amf/.test(v); }),
             encoders: (typeof LP_ENCODERS !== 'undefined') ? LP_ENCODERS.length : -1 };
  })()`);
  check('U1 编码器下拉由运行时探测重建：含本机具备的 videotoolbox（H.264 与 HEVC），' +
    '不含本机没有的 nvenc/qsv/amf（写死菜单会出现点了报 Unknown encoder）',
    a1.hasVt && a1.hasHevcVt && !a1.hasNvenc && a1.count >= 5 && a1.encoders >= 5,
    JSON.stringify(a1));

  // ---------- 2. 4K H.265 场景预设：自动落到硬件 HEVC ----------
  const a2 = await ex(`(function(){
    var sel = document.getElementById('lpScene');
    var vals = [].slice.call(sel.options).map(function(o){ return o.value; });
    sel.value = '4k_hevc_30';
    sel.dispatchEvent(new Event('change'));
    var codec = document.getElementById('lpCodec').value;
    var br = document.getElementById('lpBitrate').value;
    var size = document.getElementById('lpSize').value;
    var warn = document.getElementById('lpCodecWarn');
    return { vals: vals, has4kHevc30: vals.indexOf('4k_hevc_30') >= 0,
             has4kHevc60: vals.indexOf('4k_hevc_60') >= 0,
             codec: codec, br: br, size: size,
             warnShown: warn && warn.style.display !== 'none' && /SRT/.test(warn.innerHTML) };
  })()`);
  check('U2 4K H.265 场景预设：预设存在，套用后编码器自动落到硬件 HEVC（hevc_videotoolbox）、' +
    '码率 5000k、分辨率 4K，并挂出「需 SRT/RTSP」提示',
    a2.has4kHevc30 && a2.has4kHevc60 && a2.codec === 'hevc_videotoolbox' &&
    a2.br === '5000k' && a2.size === '3840x2160' && a2.warnShown,
    JSON.stringify(a2));

  // ---------- 3. 码率建议器 ----------
  const a3 = await ex(`(function(){
    function snap(){ return { hint: (document.getElementById('lpBrHint')||{}).innerHTML || '' }; }
    var out = {};
    // 4K + H.264
    document.getElementById('lpSize').value = '3840x2160';
    document.getElementById('lpFps').value = '30';
    document.getElementById('lpCodec').value = 'libx264';
    document.getElementById('lpCodec').dispatchEvent(new Event('change'));
    out.h264 = snap().hint;
    out.h264K = lpBitrateRecommend().k;
    // 切到 H.265：推荐值应明显下降
    document.getElementById('lpCodec').value = 'hevc_videotoolbox';
    document.getElementById('lpCodec').dispatchEvent(new Event('change'));
    out.hevc = snap().hint;
    out.hevcK = lpBitrateRecommend().k;
    // 一键套用
    document.getElementById('lpBitrate').value = '20000k';
    document.getElementById('lpBitrate').dispatchEvent(new Event('change'));
    out.beforeApply = document.getElementById('lpBitrate').value;
    var a = document.getElementById('lpBrApply');
    out.hasApplyLink = !!a;
    if (a) a.click();
    out.afterApply = document.getElementById('lpBitrate').value;
    return out;
  })()`);
  check('U3 码率建议器：4K30 下 H.264 推荐约 9000k、H.265 推荐约 5600k（低约 38%），' +
    '当前值偏离时给出「套用推荐」并可一键写入',
    a3.h264K === 9000 && a3.hevcK === 5600 &&
    /推荐码率/.test(a3.h264) && /套用推荐/.test(a3.hevc) &&
    a3.hasApplyLink && a3.beforeApply === '20000k' && a3.afterApply === '5600k',
    JSON.stringify(a3));

  // ---------- 4. 字体/排印 ----------
  const a4 = await ex(`(function(){
    var body = getComputedStyle(document.body);
    var btn = document.querySelector('.btn');
    var btnLh = btn ? getComputedStyle(btn).lineHeight : '';
    var btnFs = btn ? getComputedStyle(btn).fontSize : '';
    var td = document.querySelector('td');
    var tdFv = td ? getComputedStyle(td).fontVariantNumeric : '';
    // 注意：不要截断 fontFamily —— 浏览器会把 -apple-system 规范化成 system-ui，
    // 且要校验的 Linux 中文回落字体排在后面，截 60 字符会漏掉导致假失败。
    return { bodyLh: body.lineHeight, bodyFs: body.fontSize,
             fontFamily: body.fontFamily,
             smoothing: body.webkitFontSmoothing || '',
             btnLh: btnLh, btnFs: btnFs, tdFv: tdFv };
  })()`);
  // 14px × 1.6 = 22.4px 行高；按钮被单独压回 1.35（13px × 1.35 ≈ 17.55px）
  const bodyLhOk = Math.abs(parseFloat(a4.bodyLh) - 22.4) < 0.6;
  const btnLhOk = parseFloat(a4.btnLh) > 0 && parseFloat(a4.btnLh) < 20;
  check('U4 字体优化：全局行高 1.6 生效（14px→约 22.4px），控件行高压回不被撑高，' +
    '字体栈含 Noto/思源等 Linux 中文回落，数值列启用等宽数字',
    bodyLhOk && btnLhOk && /Noto Sans SC/.test(a4.fontFamily) && a4.tdFv.indexOf('tabular-nums') >= 0,
    JSON.stringify(a4));

  // ---------- 5. 硬件 HEVC + RTMP 仍被拦（按族判定） ----------
  const a5 = await ex(`(function(){
    document.getElementById('lpCodec').value = 'hevc_videotoolbox';
    document.getElementById('lpCopy').checked = false;
    var hevcRtmp = lpCodecProtoCheck('rtmp://a/live/1');
    document.getElementById('lpCodec').value = 'h264_videotoolbox';
    var h264Rtmp = lpCodecProtoCheck('rtmp://a/live/1');
    var h264Srt = lpCodecProtoCheck('srt://a:10080?streamid=x');
    document.getElementById('lpCodec').value = 'hevc_videotoolbox';
    var hevcSrt = lpCodecProtoCheck('srt://a:10080?streamid=x');
    return { hevcRtmp: !!hevcRtmp, h264Rtmp: h264Rtmp, h264Srt: h264Srt, hevcSrt: hevcSrt };
  })()`);
  check('U5 协议预检按族判定：硬件 HEVC 走 RTMP 仍被拦下，硬件 H.264 放行，' +
    'HEVC 走 SRT 放行（老逻辑只认 libx265，硬件 HEVC 会漏判）',
    a5.hevcRtmp === true && a5.h264Rtmp === null && a5.h264Srt === null && a5.hevcSrt === null,
    JSON.stringify(a5));

  console.log('\n──────── r70 UI 回归汇总 ────────');
  const pass = results.filter((r) => r.ok).length;
  console.log('通过 ' + pass + ' / ' + results.length);
  if (pass !== results.length) {
    console.log('\n失败项：');
    results.filter((r) => !r.ok).forEach((r) => console.log('  ❌ ' + r.name + '  → ' + r.detail));
  }
  app.quit();
  process.exitCode = pass === results.length ? 0 : 1;
}
app.whenReady().then(main).catch((e) => { console.error(e); process.exit(1); });
