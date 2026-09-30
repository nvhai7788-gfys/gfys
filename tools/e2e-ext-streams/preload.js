// E2E 用的 tcapi 替身：不联网，按 action 返回预置响应，并记录调用轨迹供断言
// 说明：contextIsolation=false 下这里直接赋值 window.tcapi，渲染器侧看到的对象与真实
// preload 经 contextBridge 暴露的完全同形，因此被测代码无需任何改动。
const calls = [];
const state = { saveCsv: [], ffProbe: [], openPreview: [] };
window.__e2e = { calls, state };

const TC_STREAMS = [{
  AppName: 'live', StreamName: 'e2eTc', DomainName: 'push.e2e.test',
  PublishTimeList: [{ PublishTime: new Date(Date.now() - 60000).toISOString().slice(0, 19) + 'Z' }]
}];
const AL_STREAMS = [{
  AppName: 'liveApp', StreamName: 'e2eAli', DomainName: 'play.e2e.test',
  PublishDomain: 'play.e2e.test', PushDomain: 'push.e2e.test',
  PublishUrl: 'rtmp://push.e2e.test/liveApp/e2eAli'
}];
const AL_DOMAINS = {
  Domains: { PageData: [
    { DomainName: 'push.e2e.test', LiveDomainType: 'liveEdge', LiveDomainStatus: 'online' },
    { DomainName: 'play.e2e.test', LiveDomainType: 'liveVideo', LiveDomainStatus: 'online' }
  ] }, TotalCount: 2
};

function tcCall(action) {
  switch (action) {
    case 'DescribeLiveStreamOnlineList': return { ok: true, data: { OnlineInfo: TC_STREAMS, TotalNum: TC_STREAMS.length } };
    case 'DescribeLivePlayAuthKey': return { ok: true, data: { Enable: false, AuthKey: '', MasterAuthKey: '', BackupAuthKey: '' } };
    case 'DescribeLivePullStreamTasks': return { ok: true, data: { TaskInfos: [] } };
    default: return { ok: true, data: {} };
  }
}
function alCall(action) {
  switch (action) {
    case 'DescribeLiveUserDomains': return { ok: true, data: AL_DOMAINS };
    case 'DescribeLiveStreamsOnlineList': return { ok: true, data: { OnlineInfo: { LiveStreamOnlineInfo: AL_STREAMS } } };
    case 'DescribeLiveDomainFrameRateAndBitRateData': return { ok: true, data: { FrameRateAndBitRateInfos: { FrameRateAndBitRateInfo: [] } } };
    default: return { ok: true, data: {} };
  }
}

const noop = () => {};
window.tcapi = {
  appVersion: 'e2e',
  call: (a) => { calls.push({ kind: 'tc', action: a && a.action }); return Promise.resolve(tcCall(a && a.action)); },
  acall: (a) => { calls.push({ kind: 'al', action: a && a.action }); return Promise.resolve(alCall(a && a.action)); },
  // 静默实测：返回一份固定的权威实测值（码率/帧率/分辨率）
  ffProbe: (arg) => {
    calls.push({ kind: 'ffProbe', arg });
    state.ffProbe.push(arg);
    return Promise.resolve({ ok: true, width: 1920, height: 1080, codec: 'h264', audio: 'aac', fps: 25,
      videoKbps: 6800, audioKbps: 128, kbps: 6928, seconds: 5, elapsedSec: 5 });
  },
  openPreview: (url, title, meta) => { state.openPreview.push({ url, title, meta }); return Promise.resolve({ ok: true }); },
  openExternal: () => Promise.resolve({ ok: true }),
  saveCsv: (name, content) => { state.saveCsv.push({ name, content }); return Promise.resolve({ ok: true, path: '/tmp/' + name }); },
  webhook: () => Promise.resolve({ ok: true }),
  probeNode: () => Promise.resolve({ ok: true }),
  notify: () => Promise.resolve({ ok: true }),
  openPrivacy: () => Promise.resolve({ ok: true }),
  md5Sync: (s) => 'md5_' + String(s).length,
  sha256Sync: (s) => 'sha256_' + String(s).length,
  schedList: () => Promise.resolve({ ok: true, list: [] }),
  schedSave: () => Promise.resolve({ ok: true }), schedRemove: () => Promise.resolve({ ok: true }),
  schedToggle: () => Promise.resolve({ ok: true }), schedRunNow: () => Promise.resolve({ ok: true }),
  schedSyncCreds: () => Promise.resolve({ ok: true }),
  ff: () => Promise.resolve({ ok: true }), ffStop: () => Promise.resolve({ ok: true }),
  ffList: () => Promise.resolve({ ok: true, list: [] }),
  ffDevices: () => Promise.resolve({ ok: true, video: [], audio: [] }),
  ffPickFile: () => Promise.resolve({ ok: false }), ffPickDir: () => Promise.resolve({ ok: false }),
  ffRelay: () => Promise.resolve({ ok: true }), ffRelayStop: () => Promise.resolve({ ok: true }),
  ffSelfCheck: () => Promise.resolve({ ok: true }),
  onFfLog: noop, onFfProgress: noop, onFfRestarted: noop
};
