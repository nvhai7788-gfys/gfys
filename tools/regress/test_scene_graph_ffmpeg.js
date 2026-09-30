// 用真实 ffmpeg 校验 compileSceneGraph 产出的 filter_complex 语法
// 做法：用 lavfi 合成源充当各输入流，跑 -f null - 空输出，只看滤镜图能否被解析
const { execFileSync } = require('child_process');
const path = require('path');
const { compileSceneGraph } = require('../../ffmpeg-args');

const FF = process.env.FFMPEG || 'ffmpeg';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + ' :: ' + String(e.message).slice(0, 300)); fail++; }
}

// 跑一次 ffmpeg 空输出，仅校验滤镜图语法；成功返回 true
function ffmpegAccepts(complex, inputCount) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  // 输入 0：主画面 lavfi 测试源
  args.push('-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=25:duration=1');
  // 其余输入：叠加层测试源
  for (let i = 1; i < inputCount; i++) {
    args.push('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=1');
  }
  args.push('-filter_complex', complex, '-map', '[vout]', '-t', '1', '-f', 'null', '-');
  try {
    execFileSync(FF, args, { stdio: 'pipe', timeout: 20000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: (e.stderr ? e.stderr.toString() : e.message) };
  }
}

console.log('=== 滤镜图真实语法校验（ffmpeg） ===');

check('媒体源叠加（含缩放）滤镜图可解析', function () {
  const r = compileSceneGraph({ outSize: '1920x1080' }, [
    { id: 'm1', type: 'ffmpeg_source', enabled: true, settings: { local_file: 'x.mp4' }, transform: { x: '20', y: '30', scale: { x: 0.5, y: 0.5 } } }
  ], { m1: 1 });
  const res = ffmpegAccepts(r.complex, 2);
  if (!res.ok) throw new Error(res.err);
});

check('色源整屏铺底滤镜图可解析', function () {
  const r = compileSceneGraph({ outSize: '1920x1080' }, [
    { id: 'c1', type: 'color_source', enabled: true, settings: { color: '#ff0000' }, transform: { x: '0', y: '0' } }
  ], {});
  const res = ffmpegAccepts(r.complex, 1);
  if (!res.ok) throw new Error(res.err);
});

check('摄像头 + 图片 + 文字 三源叠加滤镜图可解析', function () {
  const r = compileSceneGraph({ outSize: '1280x720' }, [
    { id: 'd1', type: 'av_capture_input', enabled: true, settings: { device: '0' }, transform: { x: '10', y: '10' } },
    { id: 'i1', type: 'image_source', enabled: true, settings: { file: 'logo.png' }, transform: { x: 'W-w-10', y: '10' } },
    { id: 't1', type: 'text_ft2_source', enabled: true, settings: { text: 'LIVE', color: '#ffffff' }, transform: { x: '20', y: '20' } }
  ], { d1: 1, i1: 2 });
  const res = ffmpegAccepts(r.complex, 3);
  if (!res.ok) throw new Error(res.err);
});

check('显示器捕获 + 色源 + 媒体源 混合滤镜图可解析', function () {
  const r = compileSceneGraph({ outSize: '1920x1080' }, [
    { id: 's1', type: 'monitor_capture', enabled: true, settings: { monitor: '0' }, transform: { x: '0', y: '0' } },
    { id: 'c1', type: 'color_source', enabled: true, settings: { color: '0x0000ff' }, transform: { x: '100', y: '100' } },
    { id: 'm1', type: 'ffmpeg_source', enabled: true, settings: { local_file: 'v.mp4' }, transform: { x: '200', y: '200', scale: { x: 0.25, y: 0.25 } } }
  ], { s1: 1, m1: 2 });
  const res = ffmpegAccepts(r.complex, 3);
  if (!res.ok) throw new Error(res.err);
});

check('竖屏画布 + 摄像头 滤镜图可解析', function () {
  const r = compileSceneGraph({ outSize: '1080x1920', inW: 1920, inH: 1080 }, [
    { id: 'd1', type: 'av_capture_input', enabled: true, settings: { device: '0' }, transform: { x: '0', y: '0' } }
  ], { d1: 1 });
  const res = ffmpegAccepts(r.complex, 2);
  if (!res.ok) throw new Error(res.err);
});

check('纯色源无其他来源 → 可解析', function () {
  const r = compileSceneGraph({ outSize: '1280x720' }, [
    { id: 'c1', type: 'color_source', enabled: true, settings: { color: 'green' }, transform: { x: '0', y: '0' } }
  ], {});
  const res = ffmpegAccepts(r.complex, 1);
  if (!res.ok) throw new Error(res.err);
});

console.log('\n滤镜图语法校验: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
