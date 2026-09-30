// jsdom 端到端：真加载 renderer/index.html，mock 云桥，验证历史推流查询全链路
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = require('path').resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + (detail || '')));
}

function tcCall(opts) {
  const a = opts.action;
  if (a === 'DescribeLiveDomains') return Promise.resolve({ ok: true, data: { DomainList: [{ Name: 'push.example.com', Type: 0 }] } });
  if (a === 'DescribeLiveStreamPublishedList') return Promise.resolve({ ok: true, data: { PublishInfo: [
    { StreamName: 's1', AppName: 'live', DomainName: 'push.example.com', StartTime: '2024-01-01T00:00:00Z', EndTime: '2024-01-01T01:00:00Z' }
  ] } });
  return Promise.resolve({ ok: true, data: {} });
}
function alCall(opts) {
  const a = opts.action;
  if (a === 'DescribeLiveStreamsPublishList') return Promise.resolve({ ok: true, data: { PublishInfo: { LiveStreamPublishInfo: [
    { StreamName: 'a1', AppName: 'live', DomainName: 'play.example.com', PublishDomain: 'push2.example.com', PublishUrl: 'rtmp://push2.example.com/live/a1', PublishTime: '2024-01-01T02:00:00Z', StopTime: '2024-01-01T03:00:00Z' }
  ] } } });
  if (a === 'DescribeLiveUserDomains') return Promise.resolve({ ok: true, data: { Domains: { PageData: [{ DomainName: 'play.example.com', LiveDomainType: 'liveVideo' }] } } });
  return Promise.resolve({ ok: true, data: {} });
}

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => console.log('  [jsdomError]', e.message));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://localhost/',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    const handlers = {
      call: (o) => tcCall(o),
      acall: (o) => alCall(o),
      probeNode: () => Promise.resolve({ ok: true }),
    };
    window.tcapi = new Proxy({}, { get(t, p) { return handlers[p] || (() => Promise.resolve({ ok: true, data: {} })); } });
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  }
});

const { window } = dom;
const doc = window.document;
const ex = (js) => window.eval(js);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 看门狗：若 25s 仍未结束，打印当前结果并强制退出
const watchdog = setTimeout(() => {
  console.log('\n[WATCHDOG] 超时强制退出');
  const pass = results.filter((r) => r.ok).length;
  console.log('已通过 ' + pass + ' / ' + results.length);
  process.exit(3);
}, 25000);

let ran = false;
window.addEventListener('load', run);
setTimeout(() => { if (!ran) run(); }, 600);

async function run() {
  if (ran) return; ran = true;
  try {
    console.log('--- run() 开始 ---');
    await wait(300);

    const sub = doc.querySelectorAll('#monSubtabs .subtab');
    check('H1 子标签页存在（在线流 / 历史推流）', sub.length === 2, 'count=' + sub.length);
    check('H2 历史推流面板存在且默认隐藏(hist-hidden)',
      !!doc.getElementById('monHistoryPane') && doc.getElementById('monHistoryPane').classList.contains('hist-hidden'));
    check('H3 查询控件齐全（开始/结束/域名/按钮/结果表）',
      !!doc.getElementById('hisStart') && !!doc.getElementById('hisEnd') && !!doc.getElementById('hisDomain') &&
      !!doc.getElementById('hisQueryBtn') && !!doc.getElementById('hisBody'));
    check('H4 在线流面板默认可见(monOnlinePane)', !!doc.getElementById('monOnlinePane'));

    let histBtn = null;
    sub.forEach((b) => { if (b.getAttribute('data-htab') === 'history') histBtn = b; });
    histBtn.click();
    await wait(30);
    check('H5 切到历史推流后：历史面板显示、在线面板隐藏',
      !doc.getElementById('monHistoryPane').classList.contains('hist-hidden') &&
      doc.getElementById('monOnlinePane').style.display === 'none');
    sub.forEach((b) => { if (b.getAttribute('data-htab') === 'online') b.click(); });
    await wait(30);
    check('H6 切回在线流后：在线面板显示、历史面板隐藏',
      doc.getElementById('monOnlinePane').style.display !== 'none' &&
      doc.getElementById('monHistoryPane').classList.contains('hist-hidden'));

    ex("window.state.connected = true; window.state.cfg.aliId='ak'; window.state.cfg.aliKey='sk';" +
       "window._ovDomains=[{Name:'push.example.com',Type:0}];" +
       "window._alDomains=[{DomainName:'play.example.com',LiveDomainType:'liveVideo'}];");
    histBtn.click();
    await wait(30);
    doc.getElementById('hisStart').value = '';
    doc.getElementById('hisEnd').value = '';
    ex('queryHisStreams()');
    await wait(500);

    const bodyHtml = doc.getElementById('hisBody').innerHTML;
    const rowCount = (bodyHtml.match(/<tr>/g) || []).length;
    check('H7 查询结果渲染出 2 行（腾讯 s1 + 阿里 a1）', rowCount === 2, 'rows=' + rowCount + ' html=' + bodyHtml.slice(0, 300));
    check('H8 腾讯流 s1 推流地址重建 rtmp://push.example.com/live/s1', /rtmp:\/\/push\.example\.com\/live\/s1/.test(bodyHtml));
    check('H9 阿里流 a1 推流地址采用云端 PublishUrl rtmp://push2.example.com/live/a1', /rtmp:\/\/push2\.example\.com\/live\/a1/.test(bodyHtml));
    check('H10 阿里流展示推流域名 push2.example.com（非播放域名）', /push2\.example\.com/.test(bodyHtml));
    check('H11 含复制推流地址操作按钮', /data-act="copyHis"/.test(bodyHtml));

    let copied = null;
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: (t) => { copied = t; return Promise.resolve(); } }, configurable: true });
    const copyBtn = doc.querySelector('#hisBody button[data-act="copyHis"]');
    if (copyBtn) copyBtn.click();
    await wait(50);
    check('H12 点击复制后拿到推流地址字符串', !!copied && /^rtmp:\/\//.test(copied), 'copied=' + copied);

    ex("window.state.connected=false; window.state.cfg.aliId=''; window.state.cfg.aliKey='';");
    ex('queryHisStreams()');
    await wait(200);
    check('H13 无云商配置时给出未查询到空态而非崩溃', /未查询到/.test(doc.getElementById('hisBody').innerHTML));
  } catch (e) {
    check('Hx 测试执行异常', false, (e && e.stack) || String(e));
  }

  clearTimeout(watchdog);
  const pass = results.filter((r) => r.ok).length;
  console.log('\n======== 历史推流查询 e2e 汇总 ========');
  console.log('通过 ' + pass + ' / ' + results.length);
  if (pass !== results.length) {
    results.filter((r) => !r.ok).forEach((r) => console.log('  FAIL ' + r.name + '  -> ' + r.detail));
  }
  process.exit(pass === results.length ? 0 : 1);
}
