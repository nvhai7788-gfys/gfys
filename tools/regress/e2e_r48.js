// E2E r48（v1.1.5）：
// ①推流前自检（ff:selfcheck：文件试采 / RTMP 连通 / 设备失败透出真实报错）
// ②ff:probe 流头分辨率解析（阿里云质量卡分辨率补齐）
// ③编码器校准参数写入命令行（preset/gopSec/profile/audioBr，OBS 同款）
// ④推流中断自动重连（OBS 同款）
// ⑤qAliProbeRes 渲染层接线（用本地 http FLV 服务器实测回填 320x240）
// 本轮 E2E 直接 require 真实 main.js —— 测的是真实 IPC 实现，非 mock
const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
const check = (name, ok, extra) => results.push({ name, pass: !!ok, extra: extra || '' });

function genMedia() {
  const bin = path.join(ROOT, process.arch === 'arm64' ? 'bin/ffmpeg-darwin-arm64' : 'bin/ffmpeg-darwin-x64');
  const mp4 = '/tmp/e2e_r48_src.mp4';
  const flv = '/tmp/e2e_r48_src.flv';
  try {
    if (!fs.existsSync(mp4)) execSync(bin + ' -y -f lavfi -i testsrc=duration=20:size=320x240:rate=10 -f lavfi -i sine=frequency=440:duration=20 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest ' + mp4, { stdio: 'ignore', timeout: 90000 });
    if (!fs.existsSync(flv)) execSync(bin + ' -y -i ' + mp4 + ' -c copy ' + flv, { stdio: 'ignore', timeout: 90000 });
  } catch (e) { console.error('genMedia failed:', e.message.slice(0, 200)); }
  return { mp4, flv };
}
// 拿一个保证空闲的端口（先 listen 再 close）
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

require(path.join(ROOT, 'main.js'));   // 注册真实 IPC（ff:run/probe/selfcheck/list/stop）

async function main() {
  const { mp4, flv } = genMedia();
  let flvSrv, accSrv;
  await new Promise(r => { flvSrv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'video/x-flv' }); fs.createReadStream(flv).pipe(res); }); flvSrv.listen(0, '127.0.0.1', r); });
  const FLV_PORT = flvSrv.address().port;
  // 假 RTMP 服务器：TCP accept 后立刻断开（模拟服务器拒绝该流），ffmpeg 握手即失败退出
  await new Promise(r => { accSrv = net.createServer(s => s.end()); accSrv.listen(0, '127.0.0.1', r); });
  const ACCEPT_PORT = accSrv.address().port;
  const CLOSED_PORT = await freePort();

  // 等真实 main.js 创建的主窗口
  let win = null;
  for (let i = 0; i < 60 && !win; i++) {
    await new Promise(r => setTimeout(r, 500));
    const ws = BrowserWindow.getAllWindows();
    if (ws.length) { try { if (!ws[0].webContents.isLoading()) win = ws[0]; } catch (e) { /* */ } }
  }
  if (!win) { console.log('===== E2E r48: FAIL 主窗口未出现 ====='); app.exit(2); return; }
  const ex = (js) => win.webContents.executeJavaScript(js);
  await new Promise(r => setTimeout(r, 1500));
  await ex("localStorage.clear(); 'ok';");
  await win.loadURL('about:blank');
  await win.loadFile(path.join(ROOT, 'renderer/index.html'));
  await new Promise(r => setTimeout(r, 1500));

  // ---------- A. 推流前自检 ----------
  const a1 = await ex(`window.tcapi.ffSelfCheck({ source: { type: 'file', path: '${mp4}' }, rtmp: [] })`);
  check('A1 自检·文件源试采 2 秒：ffmpeg 可用、文件可读', a1 && a1.ffmpeg === true && a1.media && a1.media.ok === true, JSON.stringify((a1 && a1.media && a1.media.tail || '').slice(-120)));

  const a2 = await ex(`window.tcapi.ffSelfCheck({ source: { type: 'file', path: '${mp4}' }, rtmp: ['rtmp://127.0.0.1:${ACCEPT_PORT}/live/x', 'rtmp://127.0.0.1:${CLOSED_PORT}/live/x'] })`);
  const rt = (a2 && a2.rtmp) || [];
  // r50 起自检 ③ 升级为「真实试推 1 秒」：accept-then-close 端口（TCP 通但 RTMP 握手失败）应判 false
  check('A2 自检·真实试推语义：握手失败端口判失败（带日志尾部）/ 无人监听端口判失败',
    rt.length === 2 && rt[0].ok === false && (rt[0].tail || '').indexOf('handshake') >= 0 && rt[1].ok === false,
    JSON.stringify(rt));

  const a3 = await ex(`window.tcapi.ffSelfCheck({ source: { type: 'device', deviceVideo: '99' }, rtmp: [] })`);
  check('A3 自检·无效设备优雅失败并透出真实报错',
    a3 && a3.ok && a3.media && a3.media.ok === false && (a3.media.tail || '').length > 0, JSON.stringify((a3 && a3.media && a3.media.tail || '').slice(-120)));

  // ---------- B. ff:probe 流头分辨率 ----------
  const b1 = await ex(`window.tcapi.ffProbe('http://127.0.0.1:${FLV_PORT}/src.flv')`);
  check('B1 ffProbe 解析流头分辨率 320x240', b1 && b1.ok && b1.width === 320 && b1.height === 240, JSON.stringify(b1));

  // ---------- C. 编码器校准参数进命令行 ----------
  await ex(`window.tcapi.ff({ kind:'push', source:{type:'file', path:'${mp4}'}, rtmp:['rtmp://127.0.0.1:${ACCEPT_PORT}/live/calib'], fps:30, videoBitrate:'2500k', preset:'medium', gopSec:3, profile:'baseline', audioBr:'160k', autoRestart:false, label:'calib' })`);
  await new Promise(r => setTimeout(r, 4000));
  const cl = await ex(`window.tcapi.ffList()`);
  const calib = ((cl && cl.list) || []).filter(t => t.label === 'calib');
  const cmd = calib.length ? calib[0].cmd : '';
  check('C1 校准参数写入命令行：-preset medium / -profile:v baseline / -b:a 160k / -g 90（30fps×3s）',
    cmd.indexOf('-preset medium') >= 0 && cmd.indexOf('-profile:v baseline') >= 0 &&
    cmd.indexOf('-b:a 160k') >= 0 && cmd.indexOf('-g 90') >= 0, cmd.slice(0, 500));

  // ---------- D. 自动重连 ----------
  const d1 = await ex(`window.tcapi.ff({ kind:'push', source:{type:'file', path:'${mp4}'}, rtmp:['rtmp://127.0.0.1:${ACCEPT_PORT}/live/reconn'], fps:30, autoRestart:true, label:'reconn' })`);
  check('D1 推流任务启动成功', d1 && d1.ok, JSON.stringify(d1));
  await new Promise(r => setTimeout(r, 9500));   // 退出(~2s) + 5s 后首次重连
  const dl = await ex(`window.tcapi.ffList()`);
  const rc = ((dl && dl.list) || []).filter(t => t.label === 'reconn');
  const hasRestartLog = rc.some(t => (t.logTail || []).join('\n').indexOf('自动重连') >= 0);
  check('D2 中断后自动重连：产生第 2 条任务且日志含「自动重连」', rc.length >= 2 && hasRestartLog,
    JSON.stringify(rc.map(t => ({ id: t.id, running: t.running, log: (t.logTail || []).slice(-2) }))));
  for (const t of rc) { if (t.running) await ex(`window.tcapi.ffStop('${t.id}')`); }

  // ---------- E. 阿里云质量卡分辨率补齐（渲染层接线） ----------
  await ex(`(function () {
    $('monHttps').checked = false;   // 本地 http 服务器
    window._alDomains = [{ DomainName: '127.0.0.1:${FLV_PORT}', LiveDomainType: 'liveVideo', LiveDomainStatus: 'online' }];
    state.cfg.alDomainAuth = state.cfg.alDomainAuth || {};
    state.cfg.alDomainAuth['127.0.0.1:${FLV_PORT}'] = { on: true, type: 'type_a', main: 'testkey' };
    window.qAliProbeRes({ StreamName: 'csi88888', AppName: 'liveApp', PublishDomain: 'push.gfcnn.com' }, 'tk1');
    return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 8000));
  const e1 = await ex(`window._qAliResProbed['tk1'] || ''`);
  check('E1 阿里质量卡分辨率由 ffmpeg 探流回填（320x240）', e1 === '320x240', e1);

  // ---------- 汇总 ----------
  flvSrv.close(); accSrv.close();
  const pass = results.filter(r => r.pass).length;
  console.log('===== E2E r48: ' + pass + '/' + results.length + ' PASS =====');
  results.forEach(r => console.log((r.pass ? '✅' : '❌') + ' ' + r.name + (r.pass ? '' : '  → ' + r.extra)));
  app.exit(pass === results.length ? 0 : 1);
}
app.whenReady().then(() => setTimeout(main, 800)).catch(e => { console.error('FATAL', e); app.exit(2); });
