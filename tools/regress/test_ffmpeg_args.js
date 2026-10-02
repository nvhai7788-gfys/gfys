// 离线单测：ffmpeg-args.js 的 composeVideoFilter（旋转 / 文字 / 图片叠加）
const assert = require('assert');
const { composeVideoFilter, compileAudioMix, composeAudioPlan } = require('../../ffmpeg-args');

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

// ================= v1.1.47：独立音频源规划 composeAudioPlan =================

// A1) 默认 source 模式 → 不追加输入，map 0:a?
check('composeAudioPlan source（默认）→ 无输入 + map 0:a?', function () {
  var r = composeAudioPlan({ mode: 'source' });
  assert.deepStrictEqual(r.inputArgs, []);
  assert.strictEqual(r.chain, null);
  assert.strictEqual(r.map, '0:a?');
  assert.strictEqual(r.mode, 'source');
});

// A2) off 模式 → 禁音轨
check('composeAudioPlan off → 无输入 + map 空（禁音）', function () {
  var r = composeAudioPlan({ mode: 'off' });
  assert.deepStrictEqual(r.inputArgs, []);
  assert.strictEqual(r.map, '');
  assert.strictEqual(r.mode, 'off');
});

// A3) device 模式（Windows dshow）→ audio=<名>
check('composeAudioPlan device（win dshow）→ audio=名', function () {
  var r = composeAudioPlan({ mode: 'device', deviceIndex: 2, deviceName: '麦克风', inputIndex: 3, isDarwin: false });
  assert.deepStrictEqual(r.inputArgs, ['-f', 'dshow', '-i', 'audio=麦克风']);
  assert.ok(/\[3:a\]/.test(r.chain), '链应以输入 3 为源: ' + r.chain);
  assert.ok(/aresample=async=1:first_pts=0/.test(r.chain), '跨设备需 aresample 对齐: ' + r.chain);
  assert.ok(/aformat=sample_rates=44100:channel_layouts=stereo/.test(r.chain), '统一格式: ' + r.chain);
});

// A4) device 模式（macOS avfoundation）→ :<idx>
check('composeAudioPlan device（mac avfoundation）→ :索引', function () {
  var r = composeAudioPlan({ mode: 'device', deviceIndex: 1, inputIndex: 2, isDarwin: true });
  assert.deepStrictEqual(r.inputArgs, ['-f', 'avfoundation', '-i', ':1']);
});

// A5) device 未选设备 → 降级 source + warn
check('composeAudioPlan device 未选设备 → 降级 + warn', function () {
  var r = composeAudioPlan({ mode: 'device' });
  assert.strictEqual(r.mode, 'source');
  assert.strictEqual(r.map, '0:a?');
  assert.ok(r.warn, '应有降级说明');
});

// A6) url 模式 → -i 地址（rtsp 加 tcp）
check('composeAudioPlan url → -i 地址', function () {
  var r = composeAudioPlan({ mode: 'url', url: 'http://x/a.mp3', inputIndex: 4 });
  assert.deepStrictEqual(r.inputArgs, ['-i', 'http://x/a.mp3']);
  assert.ok(/\[4:a\]/.test(r.chain), '输入 4: ' + r.chain);
});
check('composeAudioPlan url（rtsp）→ -rtsp_transport tcp', function () {
  var r = composeAudioPlan({ mode: 'url', url: 'rtsp://x/stream' });
  assert.deepStrictEqual(r.inputArgs, ['-rtsp_transport', 'tcp', '-i', 'rtsp://x/stream']);
});

// A7) url 未填地址 → 降级 source + warn
check('composeAudioPlan url 未填地址 → 降级 + warn', function () {
  var r = composeAudioPlan({ mode: 'url' });
  assert.strictEqual(r.mode, 'source');
  assert.ok(r.warn, '应有降级说明');
});

// A8) 增益：+6 dB 进链；钳制到 ±20
check('composeAudioPlan 增益 +6dB → volume=6dB', function () {
  var r = composeAudioPlan({ mode: 'device', deviceIndex: 0, gain: 6, inputIndex: 1 });
  assert.ok(/volume=6dB/.test(r.chain), '应含 volume=6dB: ' + r.chain);
});
check('composeAudioPlan 增益钳制 >20 → 20', function () {
  var r = composeAudioPlan({ mode: 'device', deviceIndex: 0, gain: 99, inputIndex: 1 });
  assert.ok(/volume=20dB/.test(r.chain), '钳制到 20dB: ' + r.chain);
});
check('composeAudioPlan 增益钳制 <-20 → -20', function () {
  var r = composeAudioPlan({ mode: 'device', deviceIndex: 0, gain: -99, inputIndex: 1 });
  assert.ok(/volume=-20dB/.test(r.chain), '钳制到 -20dB: ' + r.chain);
});

// A9) 延迟：1.5s → adelay=1500|1500；钳制 0~5
check('composeAudioPlan 延迟 1.5s → adelay=1500|1500', function () {
  var r = composeAudioPlan({ mode: 'device', deviceIndex: 0, delay: 1.5, inputIndex: 1 });
  assert.ok(/adelay=1500\|1500/.test(r.chain), '应含 adelay=1500|1500: ' + r.chain);
});
check('composeAudioPlan 延迟钳制 >5 → 5000', function () {
  var r = composeAudioPlan({ mode: 'device', deviceIndex: 0, delay: 9, inputIndex: 1 });
  assert.ok(/adelay=5000\|5000/.test(r.chain), '钳制到 5000: ' + r.chain);
});

// A10) 零增益零延迟 → 链不含 volume/adelay
check('composeAudioPlan 零增益零延迟 → 链无 volume/adelay', function () {
  var r = composeAudioPlan({ mode: 'device', deviceIndex: 0, gain: 0, delay: 0, inputIndex: 1 });
  assert.ok(!/volume=/.test(r.chain), '不应含 volume: ' + r.chain);
  assert.ok(!/adelay=/.test(r.chain), '不应含 adelay: ' + r.chain);
});

// A11) 未知模式 → 降级 source
check('composeAudioPlan 未知模式 → source', function () {
  var r = composeAudioPlan({ mode: 'bogus' });
  assert.strictEqual(r.mode, 'source');
  assert.strictEqual(r.map, '0:a?');
});

// A12) 默认 inputIndex = 1（排在图片输入之后）
check('composeAudioPlan 默认 inputIndex=1', function () {
  var r = composeAudioPlan({ mode: 'device', deviceIndex: 0 });
  assert.ok(/\[1:a\]/.test(r.chain), '默认输入 1: ' + r.chain);
});

// A13) device 用 deviceName 兜底（无 index）
check('composeAudioPlan device 仅 deviceName → audio=名', function () {
  var r = composeAudioPlan({ mode: 'device', deviceName: '立体声混音', inputIndex: 1 });
  assert.deepStrictEqual(r.inputArgs, ['-f', 'dshow', '-i', 'audio=立体声混音']);
});

console.log('\nffmpeg-args 单测: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
