/**
 * ffmpeg-args.js —— 纯函数模块：OBS 风格场景滤镜构造（无 Electron 依赖，可单测）
 *
 * 引用来源：FFmpeg（https://ffmpeg.org，LGPL-2.1-or-later 或按编译配置为 GPL）
 * 的 -vf / -filter_complex / lavfi / drawtext / overlay 等滤镜语法，见 THIRD_PARTY_NOTICES.md。
 *
 * 负责把「画布缩放 / 翻转 / 旋转（横竖屏）/ 来源叠加」统一翻译成
 * ffmpeg 的 -vf 或 -filter_complex 参数。主进程 main.js 通过 require 调用，
 * 便于在不启动 Electron 的情况下用 node 做参数构造断言测试。
 *
 * v1.1.37：来源叠加从「仅图片/文字」扩展到 OBS 全部 7 类来源。
 *   - image_source   → 独立 -i 输入 + overlay（原有行为，不变）
 *   - text_ft2_source→ drawtext（原有行为，不变）
 *   - ffmpeg_source  → 独立 -i 输入（媒体文件）+ overlay
 *   - av_capture_input → 独立 -i 输入（摄像头 dshow/avfoundation）+ overlay
 *   - monitor_capture  → 独立 -i 输入（显示器捕获）+ overlay
 *   - color_source    → lavfi color= 源 + overlay（无需外部输入）
 *   - browser_source  → 独立 -i 输入（预渲染帧序列/静帧），能力受限时降级提示
 */
'use strict';

// 需要作为独立 -i 输入流引入的来源类型（由 main.js 负责追加 -i 并给出流序号）
var INPUT_KINDS = {
  image_source: true, ffmpeg_source: true, av_capture_input: true,
  monitor_capture: true, browser_source: true
};

// 所有可进入滤镜合成的来源类型（不含 legacy 别名）
var SYNTH_KINDS = {
  image_source: true, text_ft2_source: true, ffmpeg_source: true,
  av_capture_input: true, monitor_capture: true, color_source: true, browser_source: true
};

// 判断某来源是否需要独立 -i 输入流
function needsInput(type) { return !!INPUT_KINDS[type]; }
// 判断某来源类型是否已被本模块支持合成
function isSupported(type) { return !!SYNTH_KINDS[type]; }

// 把 ffmpeg 颜色值规范化：支持 #rrggbb / #rgb / 颜色名 → ffmpeg 的 0xRRGGBB 或原名
function normColor(c, fallback) {
  var s = String(c == null ? '' : c).trim();
  if (!s) return fallback || 'black';
  var m = s.match(/^#([0-9a-fA-F]{6})$/);
  if (m) return '0x' + m[1];
  var m3 = s.match(/^#([0-9a-fA-F]{3})$/);
  if (m3) {
    var h = m3[1];
    return '0x' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  return s;                                  // 已是 0xRRGGBB 或 white/red 等名称
}

// 构造叠加层自身的预处理链（把叠加源按 transform 缩放/旋转后再叠加）
// 返回滤镜片段数组；无变换时返回空数组
function overlayPrep(s) {
  var prep = [];
  var tf = s.transform || {};
  var sc = tf.scale || {};
  var scx = Number(sc.x), scy = Number(sc.y);
  if (scx && scy && (scx !== 1 || scy !== 1)) {
    prep.push('scale=iw*' + scx + ':ih*' + scy);
  }
  var rot = Number(tf.rotation) || 0;
  if (rot === 90) prep.push('rotate=PI/2:ow=ih:oh=iw');
  else if (rot === 180) prep.push('rotate=PI');
  else if (rot === 270) prep.push('rotate=-PI/2:ow=ih:oh=iw');
  return prep;
}

// 把 transform 的 x/y/pos 解析成 overlay 的像素或表达式坐标
function overlayXY(s) {
  var tf = s.transform || {};
  var x = (tf.x != null && tf.x !== '') ? tf.x : (s.x != null ? s.x : 10);
  var y = (tf.y != null && tf.y !== '') ? tf.y : (s.y != null ? s.y : 10);
  return { x: x, y: y };
}

// 构造视频滤镜链。返回：
//   { vf: 'filter string' }                        —— 单输入，走 -vf
//   { complex: 'filter_complex string', map: 'x' } —— 含叠加来源（多输入），走 -filter_complex
// imgInputs：需要独立输入流的来源对应的输入流序号数组（主画面为 0，第一个叠加源为 1，依次类推），
//            由调用方把该来源作为独立 -i 输入传入，避免 movie 滤镜的文件名转义坑。
function composeVideoFilter(o, imgInputs) {
  o = o || {};
  imgInputs = imgInputs || [];
  // 1) 缩放 + 翻转（与历史行为一致：先缩放 → 再翻转）
  var vf = [];
  var wh = (o.outSize && /^\d{3,5}x\d{3,5}$/.test(o.outSize)) ? o.outSize.split('x') : null;
  var outW = wh ? Number(wh[0]) : 0, outH = wh ? Number(wh[1]) : 0;
  var portrait = (outH > outW);                       // 9:16 竖屏画布
  // v1.1.34：采集信号相应转换成竖屏模式 —— 竖屏画布 + 横向采集源 → 转置 90°（顺时针），
  // 把 1920x1080 的摄像头 / 素材旋转成 1080x1920 的竖屏画面；已为竖屏的源（inH>inW）则不再转置，避免二次旋转。
  var inW = Number(o.inW) || 0, inH = Number(o.inH) || 0;
  var srcLand = (inW && inH) ? (inW >= inH) : true;   // 未探测到尺寸时默认横向采集
  if (portrait && srcLand) vf.push('transpose=1');      // 1920x1080 -> 1080x1920（竖屏）
  var z = parseFloat(o.zoom);
  var hasZoom = o.zoom && o.zoom !== '' && o.zoom !== '1' && o.zoom !== '1.0' && z > 0 && z !== 1;
  if (wh && hasZoom) {
    vf.push('scale=' + Math.round(outW * z) + ':' + Math.round(outH * z) + ':flags=lanczos');
  } else if (wh) {
    vf.push('scale=' + outW + ':' + outH);
  } else if (hasZoom) {
    vf.push('scale=iw*' + z + ':ih*' + z + ':flags=lanczos');
  }
  // r66：翻转
  if (o.flip) {
    if (o.flip.indexOf('hflip') >= 0) vf.push('hflip');
    if (o.flip.indexOf('vflip') >= 0) vf.push('vflip');
  }
  // 2) 旋转（横竖屏切换 / 任意角度）。90/270 需交换输出宽高。
  var rot = Number(o.rotate) || 0;
  if (rot === 90) vf.push('rotate=PI/2:ow=ih:oh=iw');
  else if (rot === 180) vf.push('rotate=PI');
  else if (rot === 270) vf.push('rotate=-PI/2:ow=ih:oh=iw');

  // 3) 来源叠加：图片 overlay + 文字 drawtext（OBS 风格的 logo / 水印 / 题词）
  var sources = Array.isArray(o.sources) ? o.sources.filter(function (s) { return s && s.enabled !== false; }) : [];
  var images = sources.filter(function (s) { return s.type === 'image' && s.path; });
  var texts = sources.filter(function (s) { return s.type === 'text' && s.text; });

  if (images.length) {
    // 图片叠加：图片作为独立输入流 [n:v]，用 filter_complex 叠加
    var chains = [];
    chains.push('[0:v]' + vf.join(',') + '[v0]');
    var last = 'v0';
    images.forEach(function (s, i) {
      var inIdx = (imgInputs[i] != null) ? imgInputs[i] : (i + 1);
      var x = (s.x != null) ? s.x : 10, y = (s.y != null) ? s.y : 10;
      var dims = (s.w ? ':w=' + s.w : '') + (s.h ? ':h=' + s.h : '');
      var endTag = (i === images.length - 1 && texts.length === 0) ? 'vout' : ('v' + i);
      chains.push('[' + last + '][' + inIdx + ':v]overlay=' + x + ':' + y + dims + '[' + endTag + ']');
      last = endTag;
    });
    texts.forEach(function (s) {
      chains.push('[' + last + ']' + buildDrawtext(s) + '[vout]');
      last = 'vout';
    });
    if (last !== 'vout') chains.push('[' + last + ']null[vout]');
    return { complex: chains.join(';'), map: '[vout]' };
  }

  // 仅文字（drawtext 可并入 -vf）
  texts.forEach(function (s) { vf.push(buildDrawtext(s)); });
  return { vf: vf.join(',') };
}

/**
 * v1.1.37：把 OBS 形态的来源数组（SceneEngine.toLegacyProgram 产物）编译成
 * ffmpeg filter_complex 图，支持全部 7 类来源。
 *
 * 与 composeVideoFilter 的分工：
 *   - composeVideoFilter 保留为「基础画布 + 图片/文字」的兼容路径（旧测试与旧调用点不变）
 *   - compileSceneGraph 为多源合成新路径，main.js 在检测到「含需独立输入的叠加源」时优先调用
 *
 * 入参：
 *   o        —— 推流 payload（含 outSize / zoom / flip / rotate / inW / inH）
 *   sources  —— OBS 形态来源数组（scenes[].sources），已在渲染层经 toLegacy 规范化
 *   inputMap —— { [sourceId]: 输入流序号 }，由 main.js 按实际追加 -i 的顺序回填
 * 返回：
 *   { complex, map, consumed:[...], skipped:[...] }
 *   consumed —— 已进入滤镜图的来源 id
 *   skipped  —— 因能力受限未合成、但需向用户提示的来源 { id, type, reason }
 */
function compileSceneGraph(o, sources, inputMap) {
  o = o || {};
  inputMap = inputMap || {};
  var list = (Array.isArray(sources) ? sources : []).filter(function (s) { return s && s.enabled !== false; });
  var consumed = [], skipped = [];

  // 基础画布链（与 composeVideoFilter 保持一致：缩放/翻转/旋转/竖屏转置）
  var base = baseCanvasChain(o);

  // 独立处理三类：文字直接进主线；色源用 lavfi；其余需独立输入叠加
  var overlays = [];   // { s, inIdx | lavfi }
  var lines = [];
  var texts = [];

  list.forEach(function (s) {
    if (s.type === 'text_ft2_source' || s.type === 'text') { texts.push(s); return; }
    if (s.type === 'image_source' || s.type === 'image')        { overlays.push({ s: s, inIdx: inputMap[s.id] }); return; }
    if (s.type === 'color_source')                              { overlays.push({ s: s, lavfi: true }); return; }
    if (s.type === 'ffmpeg_source' || s.type === 'av_capture_input' ||
        s.type === 'monitor_capture' || s.type === 'browser_source') {
      var idx = inputMap[s.id];
      if (idx == null) { skipped.push({ id: s.id, type: s.type, reason: '未获得输入流序号' }); return; }
      overlays.push({ s: s, inIdx: idx });
      return;
    }
    skipped.push({ id: s.id, type: s.type, reason: '未知来源类型' });
  });

  // 无任何叠加（含色源）→ 只有文字或空：走单输入 -vf 路径，与 v1.1.36 行为完全一致
  // （文字可直接并入 -vf 的 drawtext，无需 filter_complex，也避免多一次 null 中转）
  if (!overlays.length) {
    var vfList = base.slice();
    texts.forEach(function (s) {
      var st = s.settings || {};
      var dt = {
        text: st.text != null ? st.text : (s.text || ''),
        fontsize: st.font_size || s.fontsize || 32,
        color: normColor(st.color || s.color || 'white', 'white'),
        box: st.box, boxcolor: st.boxcolor
      };
      var xy = overlayXY(s);
      dt.x = xy.x; dt.y = xy.y;
      vfList.push(buildDrawtext(dt));
      consumed.push(s.id);
    });
    return { complex: '', map: '', plain: { vf: vfList.join(',') }, consumed: consumed, skipped: skipped };
  }

  // 组装 filter_complex
  lines.push('[0:v]' + base.join(',') + '[base]');
  var last = 'base';
  var n = 0;

  overlays.forEach(function (item) {
    var s = item.s, tag = 'ov' + (n++);
    var xy = overlayXY(s);
    if (item.lavfi) {
      // 色源：lavfi color 源，尺寸默认取输出尺寸（整屏铺底）
      var col = normColor((s.settings && s.settings.color) || '#000000');
      var size = (o.outSize && /^\d{3,5}x\d{3,5}$/.test(o.outSize)) ? o.outSize : '1920x1080';
      var ctag = tag + 'src';
      lines.push('color=c=' + col + ':s=' + size + ':d=1,format=rgba[' + ctag + ']');
      lines.push('[' + last + '][' + ctag + ']overlay=' + xy.x + ':' + xy.y + '[' + tag + ']');
    } else {
      // 独立输入流：必要时先对叠加层做自身缩放/旋转
      var prep = overlayPrep(s);
      var srcTag = (item.inIdx) + ':v';
      if (prep.length) {
        lines.push('[' + srcTag + ']' + prep.join(',') + '[' + tag + 'p]');
        lines.push('[' + last + '][' + tag + 'p]overlay=' + xy.x + ':' + xy.y + '[' + tag + ']');
      } else {
        lines.push('[' + last + '][' + srcTag + ']overlay=' + xy.x + ':' + xy.y + '[' + tag + ']');
      }
    }
    last = tag;
    consumed.push(s.id);
  });

  // 文字叠加（走 drawtext，并入当前主线）
  // 注意：OBS 形态来源的文本 / 字号 / 颜色存放在 settings 下，需先映射成 buildDrawtext 认识的字段
  texts.forEach(function (s) {
    var tag = 'tx' + (n++);
    var st = s.settings || {};
    var dt = {
      text: st.text != null ? st.text : (s.text || ''),
      fontsize: st.font_size || s.fontsize || 32,
      color: normColor(st.color || s.color || 'white', 'white'),
      box: st.box, boxcolor: st.boxcolor
    };
    var xy = overlayXY(s);
    dt.x = xy.x; dt.y = xy.y;
    lines.push('[' + last + ']' + buildDrawtext(dt) + '[' + tag + ']');
    last = tag;
    consumed.push(s.id);
  });

  // 末端统一命名 vout
  if (last !== 'vout') lines.push('[' + last + ']null[vout]');

  return { complex: lines.join(';'), map: '[vout]', consumed: consumed, skipped: skipped };
}

// 基础画布链（缩放/翻转/旋转/竖屏转置），与 composeVideoFilter 头部逻辑同源
function baseCanvasChain(o) {
  var vf = [];
  var wh = (o.outSize && /^\d{3,5}x\d{3,5}$/.test(o.outSize)) ? o.outSize.split('x') : null;
  var outW = wh ? Number(wh[0]) : 0, outH = wh ? Number(wh[1]) : 0;
  var portrait = (outH > outW);
  var inW = Number(o.inW) || 0, inH = Number(o.inH) || 0;
  var srcLand = (inW && inH) ? (inW >= inH) : true;
  if (portrait && srcLand) vf.push('transpose=1');
  var z = parseFloat(o.zoom);
  var hasZoom = o.zoom && o.zoom !== '' && o.zoom !== '1' && o.zoom !== '1.0' && z > 0 && z !== 1;
  if (wh && hasZoom) vf.push('scale=' + Math.round(outW * z) + ':' + Math.round(outH * z) + ':flags=lanczos');
  else if (wh) vf.push('scale=' + outW + ':' + outH);
  else if (hasZoom) vf.push('scale=iw*' + z + ':ih*' + z + ':flags=lanczos');
  if (o.flip) {
    if (o.flip.indexOf('hflip') >= 0) vf.push('hflip');
    if (o.flip.indexOf('vflip') >= 0) vf.push('vflip');
  }
  var rot = Number(o.rotate) || 0;
  if (rot === 90) vf.push('rotate=PI/2:ow=ih:oh=iw');
  else if (rot === 180) vf.push('rotate=PI');
  else if (rot === 270) vf.push('rotate=-PI/2:ow=ih:oh=iw');
  return vf;
}

// 构造 drawtext 视频滤镜（水印 / 题词）。坐标支持 ffmpeg 表达式字符串。
// fontFile（可选）：显式字体文件路径；不传时不加 fontfile=（ffmpeg 用内置/系统默认字体）
function buildDrawtext(s, fontFile) {
  var t = String(s.text == null ? '' : s.text).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  var fs = s.fontsize || 32;
  var col = s.color || 'white';
  var x = (s.x != null && s.x !== '') ? s.x : '(w-text_w)/2';
  var y = (s.y != null && s.y !== '') ? s.y : '(h-text_h)-20';
  var p = "text='" + t + "':fontsize=" + fs + ':fontcolor=' + col + ':x=' + x + ':y=' + y;
  if (fontFile) {
    // Windows 路径在 filtergraph 里需转义反斜杠与冒号
    var ff = String(fontFile).replace(/\\/g, '/').replace(/:/g, '\\:');
    p = "fontfile='" + ff + "':" + p;
  }
  if (s.box) p += ':box=1:boxcolor=' + (s.boxcolor || 'black@0.5') + ':boxborderw=6';
  return 'drawtext=' + p;
}

module.exports = {
  composeVideoFilter: composeVideoFilter,
  compileSceneGraph: compileSceneGraph,
  buildDrawtext: buildDrawtext,
  normColor: normColor,
  needsInput: needsInput,
  isSupported: isSupported,
  baseCanvasChain: baseCanvasChain
};
