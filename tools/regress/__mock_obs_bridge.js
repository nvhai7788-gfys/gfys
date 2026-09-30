// __mock_obs_bridge.js —— 测试用的 mock 原生桥接（模拟 native/obs-bridge 暴露的 N-API 接口）
// 方法全部记录到 __calls，供 test_libobs_engine.js 断言镜像行为。
module.exports = {
  __calls: [],
  startup: function (cfg) { this.__calls.push(['startup', cfg]); return true; },
  shutdown: function () { this.__calls.push(['shutdown']); },
  available: function () { return true; },
  getVersion: function () { return '30.2.0-mock'; },
  createScene: function (n) { this.__calls.push(['createScene', n]); return true; },
  setProgramScene: function (n) { this.__calls.push(['setProgramScene', n]); return true; },
  destroyScene: function (n) { this.__calls.push(['destroyScene', n]); },
  addSource: function (sc, t, n, j) { this.__calls.push(['addSource', sc, t, n, j]); return true; },
  updateSource: function () { return true; },
  setTransform: function (sc, n, x, y, sx, sy, rot, vis, cl, ct, cr, cb) {
    this.__calls.push(['setTransform', sc, n, [x, y, sx, sy, rot, vis, cl, ct, cr, cb]]); return true;
  },
  setEnabled: function (sc, n, e) { this.__calls.push(['setEnabled', sc, n, e]); return true; },
  removeSource: function () { return true; },
  reorderSource: function () { return true; },
  enumDevices: function () { return []; },
  startStream: function (u, k, b, f) { this.__calls.push(['startStream', u, k, b, f]); return true; },
  stopStream: function () { this.__calls.push(['stopStream']); },
  renderPreview: function () { return { ok: false, reason: 'mock' }; }
};
