// test_libobs_engine.js —— libobs 真引擎适配器（纯函数 + mock 原生桥接）回归
// 覆盖：
//   1) toObsColor 颜色转 OBS uint32 ABGR
//   2) toObsSourceId 平台化来源 id
//   3) createLibobsEngine() 无 addon 时返回 null（ffmpeg 优雅回退）
//   4) pushScene 把 OBS 形态场景正确镜像为 createScene/addSource(含设置 JSON 颜色转换)/setTransform/setProgramScene
//   5) startStream 透传 url/key/bitrate/fps
const path = require('path');
const le = require('../../libobs-engine');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + (detail || '')));
}

// ---- 1) 颜色转换 ----
check('toObsColor(#ff0000) → 0xFF0000FF（ABGR）', le.toObsColor('#ff0000') === 0xFF0000FF, 'got ' + le.toObsColor('#ff0000'));
check('toObsColor(#00ff00) → 0xFF00FF00', le.toObsColor('#00ff00') === 0xFF00FF00, 'got ' + le.toObsColor('#00ff00'));
check('toObsColor(#abc) 三短码展开', le.toObsColor('#abc') === 0xFFCCBBAA, 'got ' + le.toObsColor('#abc'));
check('toObsColor(非法) → 默认白 0xFFFFFFFF', le.toObsColor('not-a-color') === 0xFFFFFFFF, 'got ' + le.toObsColor('not-a-color'));

// ---- 2) 来源 id 平台化 ----
check('toObsSourceId(image) → image_source', le.toObsSourceId('image') === 'image_source');
check('toObsSourceId(text) → text_ft2_source', le.toObsSourceId('text') === 'text_ft2_source');
check('toObsSourceId(ffmpeg_source) 透传', le.toObsSourceId('ffmpeg_source') === 'ffmpeg_source');
// win32 下 av_capture_input → dshow_input（本沙箱为 win32）
check('toObsSourceId(av_capture_input) win32 → dshow_input', le.toObsSourceId('av_capture_input') === 'dshow_input');

// ---- 3) 无 addon 优雅回退 ----
check('createLibobsEngine() 无 addon → null', le.createLibobsEngine() === null);

// ---- 4) pushScene 镜像（用 mock 原生桥接） ----
const mockPath = path.join(__dirname, '__mock_obs_bridge.js');
const eng = le.createLibobsEngine({ addonPath: mockPath });
check('createLibobsEngine(含 mock addon) 可用', !!eng);

const scene = {
  id: 's1', name: '主场景', orient: 'land', size: '1920x1080',
  sources: [
    { id: 'a', type: 'text_ft2_source', name: '题词', enabled: true,
      settings: { text: '港丰', font_size: 60, color: '#ff0000' },
      transform: { pos: 'tl', x: '10', y: '10', scale: { x: 1, y: 1 }, rotation: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 }, visible: true } },
    { id: 'b', type: 'image_source', name: 'logo', enabled: true,
      settings: { file: '/tmp/logo.png' },
      transform: { pos: 'tl', x: '20', y: '30', scale: { x: 0.5, y: 0.5 }, rotation: 90, crop: { left: 0, top: 0, right: 0, bottom: 0 }, visible: true } },
    { id: 'c', type: 'color_source', name: '底色', enabled: false,
      settings: { color: '#00ff00', width: 1920, height: 1080 },
      transform: { pos: 'tl', x: '0', y: '0', scale: { x: 1, y: 1 }, rotation: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 }, visible: true } }
  ]
};
const res = eng.pushScene(scene, { baseWidth: 1920, baseHeight: 1080, fps: 30 });
check('pushScene 返回 {ok,scene,sources}', res && res.ok && res.sources === 3, JSON.stringify(res));

const calls = require(mockPath).__calls;
const addCalls = calls.filter(function (c) { return c[0] === 'addSource'; });
check('pushScene 触发 3 次 addSource', addCalls.length === 3, 'got ' + addCalls.length);

// 文本源设置 JSON 里颜色已转 ABGR（mock addSource: c=[addSource, scene, type, name, json]）
const textAdd = addCalls.filter(function (c) { return c[3] === '题词'; })[0];
const textSettings = JSON.parse(textAdd[4]);
check('文本源 color 转 ABGR(0xFF0000FF)', textSettings.color === 0xFF0000FF, 'got ' + textSettings.color);
check('文本源 font_size 透传', textSettings.font_size === 60, 'got ' + textSettings.font_size);

// 色源颜色转 ABGR
const colorAdd = addCalls.filter(function (c) { return c[3] === '底色'; })[0];
const colorSettings = JSON.parse(colorAdd[4]);
check('色源 color 转 ABGR(0xFF00FF00)', colorSettings.color === 0xFF00FF00, 'got ' + colorSettings.color);

// 图片源变换（scale 0.5 / rotation 90 / x=20 y=30）（mock setTransform: c=[setTransform, scene, name, [x,y,sx,sy,rot,vis,cl,ct,cr,cb]]）
const tfCalls = calls.filter(function (c) { return c[0] === 'setTransform'; });
const imgTf = tfCalls.filter(function (c) { return c[2] === 'logo'; })[0];
check('图片源 setTransform 缩放 0.5', imgTf && imgTf[3][2] === 0.5 && imgTf[3][3] === 0.5, JSON.stringify(imgTf && imgTf[3]));
check('图片源 setTransform 旋转 90', imgTf && imgTf[3][4] === 90, JSON.stringify(imgTf && imgTf[3]));
check('图片源 setTransform 坐标 20,30', imgTf && imgTf[3][0] === 20 && imgTf[3][1] === 30, JSON.stringify(imgTf && imgTf[3]));

// disabled 来源 setEnabled(false)（mock setEnabled: c=[setEnabled, scene, name, enabled]）
const enCalls = calls.filter(function (c) { return c[0] === 'setEnabled'; });
const colorEn = enCalls.filter(function (c) { return c[2] === '底色'; })[0];
check('disabled 色源 setEnabled=false', colorEn && colorEn[3] === false, JSON.stringify(colorEn));

// setProgramScene 指向场景名
const prog = calls.filter(function (c) { return c[0] === 'setProgramScene'; })[0];
check('setProgramScene 指向「主场景」', prog && prog[1] === '主场景', JSON.stringify(prog));

// ---- 5) startStream 透传 ----
eng.startStream('rtmp://h/app/key', undefined, { videoBitrate: 3000, fps: 30 });
const ss = calls.filter(function (c) { return c[0] === 'startStream'; })[0];
check('startStream url 透传', ss && ss[1] === 'rtmp://h/app/key', JSON.stringify(ss));
check('startStream bitrate=3000', ss && ss[3] === 3000, JSON.stringify(ss));

// ---- 6) v1.1.40：音频控制 ----
eng.setSourceVolume('主场景', '题词', 0.5);
const vol = calls.filter(function (c) { return c[0] === 'setSourceVolume'; })[0];
check('setSourceVolume 透传 0.5', vol && vol[2] === '题词' && vol[3] === 0.5, JSON.stringify(vol));
eng.setSourceMuted('主场景', '题词', true);
const mut = calls.filter(function (c) { return c[0] === 'setSourceMuted'; })[0];
check('setSourceMuted 透传 true', mut && mut[2] === '题词' && mut[3] === true, JSON.stringify(mut));

// ---- 7) v1.1.40：源滤镜 ----
eng.addSourceFilter('主场景', '题词', 'color_filter', '校正', { opacity: 0.8 });
const flt = calls.filter(function (c) { return c[0] === 'addSourceFilter'; })[0];
check('addSourceFilter 透传 filterId/name/settings', flt && flt[3] === 'color_filter' && flt[4] === '校正' && flt[5] === '{"opacity":0.8}', JSON.stringify(flt));
eng.removeSourceFilter('主场景', '题词', '校正');
const rflt = calls.filter(function (c) { return c[0] === 'removeSourceFilter'; })[0];
check('removeSourceFilter 透传 filterName', rflt && rflt[3] === '校正', JSON.stringify(rflt));
// v1.1.42：滤镜属性更新（updateSourceFilter）
eng.updateSourceFilter('主场景', '题词', '校正', { opacity: 0.5, contrast: 0.2 });
const uflt = calls.filter(function (c) { return c[0] === 'updateSourceFilter'; })[0];
check('updateSourceFilter 透传 filterName/settings', uflt && uflt[3] === '校正' && uflt[4] === '{"opacity":0.5,"contrast":0.2}', JSON.stringify(uflt));

// ---- 8) v1.1.40：场景过渡 ----
eng.createTransition('fade_transition', 'gf-transition', 500);
const trn = calls.filter(function (c) { return c[0] === 'createTransition'; })[0];
const trnDur = calls.filter(function (c) { return c[0] === 'setTransitionDuration'; })[0];
check('createTransition 透传 typeId/name', trn && trn[1] === 'fade_transition' && trn[2] === 'gf-transition', JSON.stringify(trn));
check('setTransitionDuration 透传 500', trnDur && trnDur[1] === 500, JSON.stringify(trnDur));
eng.triggerTransition('场景二');
const ttr = calls.filter(function (c) { return c[0] === 'triggerTransition'; })[0];
check('triggerTransition 透传场景名', ttr && ttr[1] === '场景二', JSON.stringify(ttr));

// ---- 9) v1.1.40：预览回读 ----
const pv = eng.renderPreview(640, 360);
check('renderPreview 返回 ok + 尺寸', pv && pv.ok === true && pv.width === 640 && pv.height === 360, JSON.stringify(pv && { ok: pv.ok, width: pv.width, height: pv.height }));
check('renderPreview 返回 Buffer data', pv && pv.data && Buffer.isBuffer(pv.data) && pv.data.length === 640 * 360 * 4, 'len=' + (pv && pv.data && pv.data.length));

// shutdown 触发
eng.shutdown();
const sd = calls.filter(function (c) { return c[0] === 'shutdown'; });
check('shutdown 触发原生 shutdown', sd.length >= 1, 'got ' + sd.length);

const fail = results.filter(function (r) { return !r.ok; });
console.log('\n======== libobs 引擎适配器回归 ========');
console.log('通过 ' + (results.length - fail.length) + ' / ' + results.length);
if (fail.length) process.exit(1);
