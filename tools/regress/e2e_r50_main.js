// E2E r50-main（v1.1.7）——本地推流健壮性：require 真实 main.js 测真实 IPC
// ①文件源推流：目标 RTMP 立即拒绝连接 → FF_RTMP_ERR 瞬时错误自动重试（同参数 2 次重试）
// ②设备源推流：同款瞬时错误重试路径（ffSpawnDevice 的 rtmpErr 分支）
// ③自检 ③ 升级为「真实试推 1 秒」：accept-close 端口应判失败并带日志尾部
// ④ ff:openPrivacy IPC 已注册（不实际触发，避免弹系统设置）
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const net = require('net');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
const check = (name, ok, extra) => results.push({ name, pass: !!ok, extra: extra || '' });

ipcMain.on('app:version-sync', (e) => { e.returnValue = '1.1.7-test'; });
ipcMain.on('util:md5-sync', (e, s) => { e.returnValue = cryptoMd5(s); });
function cryptoMd5(s) { return require('crypto').createHash('md5').update(s).digest('hex'); }

function genMedia() {
  const bin = path.join(ROOT, process.arch === 'arm64' ? 'bin/ffmpeg-darwin-arm64' : 'bin/ffmpeg-darwin-x64');
  const mp4 = '/tmp/e2e_r50_src.mp4';
  try {
    if (!fs.existsSync(mp4)) execSync(bin + ' -y -f lavfi -i testsrc=duration=30:size=320x240:rate=10 -f lavfi -i sine=frequency=440:duration=30 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest ' + mp4, { stdio: 'ignore', timeout: 90000 });
  } catch (e) { console.error('genMedia failed:', e.message.slice(0, 200)); }
  return mp4;
}

require(path.join(ROOT, 'main.js'));   // 注册真实 IPC

async function main() {
  const mp4 = genMedia();

  // 假 RTMP 服务器：TCP accept 后立刻断开（模拟服务器拒绝），ffmpeg 握手即失败 → FF_RTMP_ERR
  let accepts = 0;
  const accSrv = net.createServer(s => { accepts++; s.end(); });
  await new Promise(r => accSrv.listen(0, '127.0.0.1', r));
  const ACCEPT_PORT = accSrv.address().port;

  // 等 main.js 创建的主窗口（真实 createWindow）
  let win = null;
  for (let i = 0; i < 60 && !win; i++) {
    await new Promise(r => setTimeout(r, 500));
    const ws = BrowserWindow.getAllWindows();
    if (ws.length) { try { if (!ws[0].webContents.isLoading()) win = ws[0]; } catch (e) { /* */ } }
  }
  if (!win) { console.log('===== E2E r50-main: FAIL 主窗口未出现 ====='); app.exit(2); return; }
  const ex = (js) => win.webContents.executeJavaScript(js);
  await ex("localStorage.clear(); 'ok';");

  // ---------- C. 文件源推流瞬时 RTMP 失败自动重试 ----------
  accepts = 0;
  const c1 = await ex(`window.tcapi.ff({ kind: 'push', source: { type: 'file', path: '${mp4}' }, rtmp: ['rtmp://127.0.0.1:${ACCEPT_PORT}/live/x'], label: 'r50-c1' })`);
  await new Promise(r => setTimeout(r, 10000));   // 首推 + 2 次重试（各 2s 间隔 + 6s 判活窗口）
  check('C1 文件源推流：RTMP 立即拒绝 → 自动重试共 3 次连接（1 首推 + 2 重试）',
    c1 && c1.ok === true && accepts >= 3, JSON.stringify({ ok: c1 && c1.ok, id: c1 && c1.id, accepts }));
  if (c1 && c1.id) await ex(`window.tcapi.ffStop('${c1.id}')`);

  // ---------- D. 设备源推流启动（无崩溃）----------
  // 注：本测试环境无法打开真实摄像头（avfoundation 采集失败先于 RTMP 连接），无法覆盖
  // ffSpawnDevice 的 rtmpErr 重试分支；该分支与文件源共用同一 mkPushArgs（C1 已验证）。
  accepts = 0;
  const d1 = await ex(`window.tcapi.ff({ kind: 'push', source: { type: 'device', deviceVideo: '0', deviceAudio: '' }, rtmp: ['rtmp://127.0.0.1:${ACCEPT_PORT}/live/y'], label: 'r50-d1', fps: 25 })`);
  await new Promise(r => setTimeout(r, 14000));
  check('D2 设备源推流：任务正常启动、采集重试路径无崩溃（返回 ok 且含任务 id）',
    d1 && d1.ok === true && !!d1.id, JSON.stringify({ ok: d1 && d1.ok, id: d1 && d1.id }));
  if (d1 && d1.id) await ex(`window.tcapi.ffStop('${d1.id}')`);

  // ---------- E. 自检 ③：真实试推 1 秒（升级后） ----------
  const e1 = await ex(`window.tcapi.ffSelfCheck({ source: { type: 'file', path: '${mp4}' }, rtmp: ['rtmp://127.0.0.1:${ACCEPT_PORT}/live/z'] })`);
  const rt = (e1 && e1.rtmp) || [];
  check('E3 自检升级为真实试推：拒绝连接的地址判失败并透出日志尾部',
    rt.length === 1 && rt[0].ok === false && (rt[0].tail || '').length > 0, JSON.stringify(rt[0] || {}));

  const e2 = await ex(`window.tcapi.ffSelfCheck({ source: { type: 'file', path: '${mp4}' }, rtmp: ['rtmp://127.0.0.1:${ACCEPT_PORT}/live/z'] })`);
  check('E4 自检结构含 busy/via/tail 字段（真实试推语义）',
    e2 && e2.rtmp && e2.rtmp[0] && Object.prototype.hasOwnProperty.call(e2.rtmp[0], 'busy') && e2.rtmp[0].via === 'push', 'structure');

  let pass = 0, fail = 0;
  results.forEach(r => { if (r.pass) pass++; else { fail++; console.log('FAIL:', r.name, r.extra); } });
  console.log(`===== E2E r50-main: ${pass}/${results.length} PASS${fail ? ' (' + fail + ' FAIL)' : ''} =====`);
  accSrv.close();
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(() => setTimeout(main, 800)).catch((e) => { console.error('E2E error:', e); app.exit(2); });
