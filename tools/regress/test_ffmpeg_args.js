// 离线单测：ffmpeg-args.js 的 composeVideoFilter（旋转 / 文字 / 图片叠加）
const assert = require('assert');
const { composeVideoFilter, compileAudioMix } = require('../../ffmpeg-args');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + ' :: ' + e.message); fail++; }
}

// 1) 无滤镜
check('无来源无旋转 → 无 -vf', function () {
  var r = composeVideoFilter({});
  assert.strictEqual(r.vf, '');
  assert.ok(!r.complex);
});

// 2) 仅缩放
check('仅缩放 → -vf scale', function () {
  var r = composeVideoFilter({ outSize: '1280x720' });
  assert.strictEqual(r.vf, 'scale=1280:720');
});

// 3) 横转竖 90°
check('旋转 90° → rotate 交换宽高', function () {
  var r = composeVideoFilter({ rotate: 90 });
  assert.strictEqual(r.vf, 'rotate=PI/2:ow=ih:oh=iw');
});

// 3b) v1.1.34：竖屏画布 + 横向采集源 → 转置 90° 把采集信号转成竖屏（不再拉伸变形）
check('竖屏画布+横向源 → 转置成 1080x1920', function () {
  var r = composeVideoFilter({ outSize: '1080x1920' });
  assert.strictEqual(r.vf, 'transpose=1,scale=1080:1920', '应为 transpose+scale: ' + r.vf);
});
check('竖屏画布+已知竖屏源 → 不再二次转置', function () {
  var r = composeVideoFilter({ outSize: '1080x1920', inW: 1080, inH: 1920 });
  assert.strictEqual(r.vf, 'scale=1080:1920', '已竖屏源不应再 transpose: ' + r.vf);
});
check('竖屏画布+横向源+翻转 → transpose+scale+hflip', function () {
  var r = composeVideoFilter({ outSize: '1080x1920', flip: 'hflip', inW: 1920, inH: 1080 });
  assert.strictEqual(r.vf, 'transpose=1,scale=1080:1920,hflip', '应为 transpose+scale+hflip: ' + r.vf);
});
check('横屏画布 1920x1080 不触发转置', function () {
  var r = composeVideoFilter({ outSize: '1920x1080' });
  assert.strictEqual(r.vf, 'scale=1920:1080');
});

// 4) 旋转 180°
check('旋转 180°', function () {
  var r = composeVideoFilter({ rotate: 180 });
  assert.strictEqual(r.vf, 'rotate=PI');
});

// 5) 仅文字水印 → -vf 内含 drawtext
check('仅文字 → -vf drawtext', function () {
  var r = composeVideoFilter({ sources: [{ type: 'text', enabled: true, text: '港丰', fontsize: 40, color: 'white', x: '10', y: '10' }] });
  assert.ok(/drawtext=text='港丰'/.test(r.vf), '应包含 drawtext: ' + r.vf);
  assert.ok(!r.complex, '不应走 filter_complex');
});

// 6) 图片叠加 → filter_complex，图片作为输入流 [1:v]
check('图片叠加 → filter_complex + [1:v]', function () {
  var r = composeVideoFilter({ sources: [{ type: 'image', enabled: true, path: '/tmp/logo.png', x: '10', y: '10' }] }, [1]);
  assert.ok(r.complex, '应返回 complex');
  assert.ok(/\[0:v\]scale/.test(r.complex) === false, '无 scale 时不应有 scale');
  assert.ok(/\[1:v\]overlay=10:10/.test(r.complex), '应叠加 [1:v]: ' + r.complex);
  assert.ok(/\[vout\]/.test(r.complex), '末端应标记为 vout');
  assert.strictEqual(r.map, '[vout]');
});

// 7) 图片 + 文字 + 缩放 + 旋转 组合
check('图片+文字+缩放+旋转 组合', function () {
  var r = composeVideoFilter({
    outSize: '1920x1080', rotate: 90,
    sources: [
      { type: 'image', enabled: true, path: '/tmp/logo.png', x: 'W-w-10', y: '10' },
      { type: 'text', enabled: true, text: 'LIVE', fontsize: 48, color: 'yellow', x: '10', y: '10' }
    ]
  }, [1]);
  assert.ok(r.complex, '应走 complex');
  assert.ok(/\[0:v\]scale=1920:1080,rotate=PI\/2:ow=ih:oh=iw\[v0\]/.test(r.complex), '应含缩放+旋转: ' + r.complex);
  assert.ok(/\[v0\]\[1:v\]overlay=W-w-10:10/.test(r.complex), '图片叠加: ' + r.complex);
  assert.ok(/drawtext=text='LIVE'/.test(r.complex), '文字叠加: ' + r.complex);
});

// 8) disabled 来源被忽略
check('disabled 图片不进入滤镜', function () {
  var r = composeVideoFilter({ sources: [{ type: 'image', enabled: false, path: '/tmp/x.png' }] }, [1]);
  assert.ok(!r.complex, 'disabled 不应走 complex');
});

// ================= v1.1.43：多源音频混音 compileAudioMix =================

// 9) 无音频输入 → null
check('compileAudioMix 无音频 → null', function () {
  assert.strictEqual(compileAudioMix([]), null);
  assert.strictEqual(compileAudioMix(null), null);
});

// 10) 单路音频 → null（直通，不做 amix）
check('compileAudioMix 单路 → null 直通', function () {
  assert.strictEqual(compileAudioMix([{ inIdx: 0 }]), null);
});

// 11) 双路音频 → amix + aout
check('compileAudioMix 双路 → amix=inputs=2 + [aout]', function () {
  var r = compileAudioMix([{ inIdx: 0 }, { inIdx: 1 }]);
  assert.ok(r && r.complex, '应返回 complex');
  assert.ok(/\[0:a\].*aformat=sample_rates=44100:channel_layouts=stereo\[a0\]/.test(r.complex), '路 0 格式统一: ' + r.complex);
  assert.ok(/\[1:a\].*\[a1\]/.test(r.complex), '路 1: ' + r.complex);
  assert.ok(/\[a0\]\[a1\]amix=inputs=2:duration=longest:normalize=0\[aout\]/.test(r.complex), 'amix 合并: ' + r.complex);
  assert.strictEqual(r.map, '[aout]');
});

// 12) 三路音频 + 音量/静音预处理
check('compileAudioMix 三路 + 音量/静音', function () {
  var r = compileAudioMix([
    { inIdx: 0, volume: 0.5 },
    { inIdx: 1, muted: true },
    { inIdx: 2 }
  ]);
  assert.ok(r && r.complex);
  assert.ok(/\[0:a\]aformat=sample_rates=44100:channel_layouts=stereo,volume=0\.5\[a0\]/.test(r.complex), '路 0 音量 0.5: ' + r.complex);
  assert.ok(/\[1:a\].*volume=0\[a1\]/.test(r.complex), '路 1 静音 volume=0: ' + r.complex);
  assert.ok(/\[2:a\]aformat=sample_rates=44100:channel_layouts=stereo\[a2\]/.test(r.complex), '路 2 默认音量: ' + r.complex);
  assert.ok(/amix=inputs=3/.test(r.complex), '三路 amix: ' + r.complex);
});

// 13) 无效输入被过滤（inIdx 为 null 的项）
check('compileAudioMix 过滤无效输入项', function () {
  var r = compileAudioMix([{ inIdx: 0 }, { volume: 1 }, { inIdx: 2 }]);
  assert.ok(r && r.complex);
  assert.ok(/amix=inputs=2/.test(r.complex), '应只混 2 路有效输入: ' + r.complex);
});

console.log('\nffmpeg-args 单测: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
