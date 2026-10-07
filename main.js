/**
 * 港丰影视直播工作台 - 主进程
 * 功能：TC3-HMAC-SHA256 签名调用腾讯云直播 API、窗口管理、流预览子窗口
 *
 * 引用来源：
 *  - 云 API 签名算法遵循腾讯云 TC3-HMAC-SHA256 / 阿里云 ACS3-HMAC-SHA256 官方签名规范
 *    （见各云官网 OpenAPI 文档）。
 *  - libobs 真引擎经 native/obs-bridge 桥接，引擎来自 OBS Studio（GPL-2.0），见 THIRD_PARTY_NOTICES.md。
 */
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');   // r69：detectPlayers 需要展开 ~ 家目录路径
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
// r71：OBS 场景滤镜构造（缩放/翻转/旋转/来源叠加）抽到纯函数模块，便于离线单测
const { composeVideoFilter, compileSceneGraph, compileAudioMix, composeAudioPlan, composeAudioFilter, needsInput: ffNeedsInput } = require('./ffmpeg-args');
// v1.1.38：libobs 真引擎适配器（可选）——原生 addon 未编译/未打包时为 null，自动回退 ffmpeg
const { createLibobsEngine } = require('./libobs-engine');

let mainWindow = null;

// ---------------------------------------------------------------------------
// 腾讯云 API v3 签名调用
// ---------------------------------------------------------------------------
function sha256hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function tc3Call(args) {
  const {
    secretId,
    secretKey,
    host = 'live.tencentcloudapi.com',
    service = 'live',
    version = '2018-08-01',
    action,
    payload = {},
    region = ''
  } = args;

  return new Promise((resolve, reject) => {
    if (!secretId || !secretKey) {
      return reject(new Error('未配置 SecretId / SecretKey'));
    }
    const body = JSON.stringify(payload || {});
    const ts = Math.floor(Date.now() / 1000);
    const date = new Date(ts * 1000).toISOString().slice(0, 10);

    // 1. 拼接规范请求串
    const canonicalHeaders =
      'content-type:application/json; charset=utf-8\n' +
      'host:' + host + '\n' +
      'x-tc-action:' + action.toLowerCase() + '\n';
    const signedHeaders = 'content-type;host;x-tc-action';
    const canonicalRequest = [
      'POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(body)
    ].join('\n');

    // 2. 拼接待签名字符串
    const stringToSign = [
      'TC3-HMAC-SHA256',
      String(ts),
      date + '/' + service + '/tc3_request',
      sha256hex(canonicalRequest)
    ].join('\n');

    // 3. 计算签名
    const kDate = hmac('TC3' + secretKey, date);
    const kService = hmac(kDate, service);
    const kSigning = hmac(kService, 'tc3_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    const authorization =
      'TC3-HMAC-SHA256 ' +
      'Credential=' + secretId + '/' + date + '/' + service + '/tc3_request, ' +
      'SignedHeaders=' + signedHeaders + ', Signature=' + signature;

    const headers = {
      'Host': host,
      'Content-Type': 'application/json; charset=utf-8',
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Timestamp': String(ts),
      'Authorization': authorization
    };
    if (region) headers['X-TC-Region'] = region;

    const req = https.request({
      hostname: host,
      path: '/',
      method: 'POST',
      headers,
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.Response && json.Response.Error) {
            reject(new Error('[' + json.Response.Error.Code + '] ' + json.Response.Error.Message));
          } else {
            resolve(json.Response);
          }
        } catch (e) {
          reject(new Error('响应解析失败: ' + data.slice(0, 300)));
        }
      });
    });
    req.on('error', (e) => reject(new Error('网络请求失败: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时（15s），请检查网络或代理设置')); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 阿里云 OpenAPI 调用（ACS3-HMAC-SHA256 签名 · RPC 风格 · live 2016-11-01）
// ---------------------------------------------------------------------------
function acs3Encode(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function acs3Call(args) {
  const {
    accessKeyId,
    accessKeySecret,
    action,
    params = {},
    host = 'live.aliyuncs.com',
    version = '2016-11-01'
  } = args;

  return new Promise((resolve, reject) => {
    if (!accessKeyId || !accessKeySecret) {
      return reject(new Error('未配置阿里云 AccessKey ID / AccessKey Secret'));
    }
    const qp = Object.assign({ Action: action, Version: version }, params || {});
    const qs = Object.keys(qp).sort()
      .map((k) => acs3Encode(k) + '=' + acs3Encode(qp[k])).join('&');
    const isoTime = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const nonce = crypto.randomBytes(16).toString('hex');
    const payloadSha = sha256hex('');

    const signHeaders = {
      'host': host,
      'x-acs-action': action,
      'x-acs-content-sha256': payloadSha,
      'x-acs-date': isoTime,
      'x-acs-signature-nonce': nonce,
      'x-acs-version': version
    };
    const sortedNames = Object.keys(signHeaders).sort();
    const canonicalHeaders = sortedNames.map((n) => n + ':' + String(signHeaders[n]).trim() + '\n').join('');
    const signedHeaders = sortedNames.join(';');
    const canonicalRequest = ['POST', '/', qs, canonicalHeaders, signedHeaders, payloadSha].join('\n');
    const stringToSign = 'ACS3-HMAC-SHA256\n' + sha256hex(canonicalRequest);
    const signature = crypto.createHmac('sha256', accessKeySecret).update(stringToSign, 'utf8').digest('hex');
    const authorization =
      'ACS3-HMAC-SHA256 Credential=' + accessKeyId +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

    const req = https.request({
      hostname: host,
      path: '/?' + qs,
      method: 'POST',
      headers: {
        'Host': host,
        'Authorization': authorization,
        'x-acs-action': action,
        'x-acs-version': version,
        'x-acs-date': isoTime,
        'x-acs-signature-nonce': nonce,
        'x-acs-content-sha256': payloadSha
      },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          // 成功判定：live 等 RPC 服务成功响应无 Code 字段；BSS（费用中心）成功响应
          // 反而带 Code='Success' / '200' + Success:true —— 不能见 Code 就判失败。
          // 规则：HTTP >=400、或 (有 Code 且非 Success/纯数字 且 未显式 Success:true) → 失败
          const code = json && json.Code;
          const isNum = code != null && /^\d+$/.test(String(code));
          const isBssOk = code === 'Success' || isNum;
          if (res.statusCode >= 400 || (code && !isBssOk && json.Success !== true)) {
            reject(new Error('[' + (code || res.statusCode) + '] ' + (json.Message || '请求失败')));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error('响应解析失败: ' + data.slice(0, 300)));
        }
      });
    });
    req.on('error', (e) => reject(new Error('网络请求失败: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时（15s），请检查网络或代理设置')); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('tc:call', async (_e, args) => {
  try {
    const res = await tc3Call(args);
    return { ok: true, data: res };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ac:call', async (_e, args) => {
  try {
    const res = await acs3Call(args);
    return { ok: true, data: res };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:openExternal', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// MD5 同步版本（renderer 侧 md5Sync 使用 sendSync，必须同步返回字符串）
// 应用版本号（登录页 / 设置页显示；沙盒 preload 无法直接访问 app 模块）
ipcMain.on('app:version-sync', (e) => { e.returnValue = app.getVersion(); });
ipcMain.on('util:md5-sync', (e, s) => {
  e.returnValue = crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
});
// SHA256 同步版本（网页版地址生成器加密类型 MD5 / SHA256）
ipcMain.on('util:sha256-sync', (e, s) => {
  e.returnValue = crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
});

// ---------------------------------------------------------------------------
// 告警 Webhook 推送（钉钉 / 企业微信群机器人）
// ---------------------------------------------------------------------------
function httpsPostJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const data = JSON.stringify(body);
      const req = https.request({
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: timeoutMs || 10000
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try { resolve({ statusCode: res.statusCode, body: buf.slice(0, 500) }); }
          catch (e) { resolve({ statusCode: res.statusCode, body: buf.slice(0, 200) }); }
        });
      });
      req.on('error', (e) => reject(new Error(e.message)));
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
      req.write(data);
      req.end();
    } catch (e) { reject(new Error('URL 无效: ' + e.message)); }
  });
}

ipcMain.handle('app:webhook', async (_e, { type, url, title, text }) => {
  if (!url || !/^https?:\/\//.test(url)) return { ok: false, error: 'Webhook URL 无效' };
  try {
    let body;
    if (type === 'wechat') {
      body = { msgtype: 'markdown', markdown: { content: '**' + title + '**\n' + text } };
    } else {
      // 钉钉群机器人（markdown）
      body = { msgtype: 'markdown', markdown: { title: title, text: '### ' + title + '\n\n' + text.replace(/\n/g, '\n\n') } };
    }
    const r = await httpsPostJson(url, body);
    let ok = r.statusCode === 200;
    let detail = '';
    try {
      const j = JSON.parse(r.body);
      if (j.errcode !== undefined) { ok = ok && j.errcode === 0; if (j.errcode !== 0) detail = j.errmsg || ''; }
    } catch (e) { /* 非 JSON 响应，按 HTTP 状态判断 */ }
    return ok ? { ok: true } : { ok: false, error: detail || ('HTTP ' + r.statusCode) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// 集群节点连通性探测（GET 探测，返回延迟）
// ---------------------------------------------------------------------------
ipcMain.handle('app:probeNode', async (_e, url) => {
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, extra) => {
      if (done) return; done = true;
      resolve(Object.assign({ ok, ms: Date.now() - started }, extra || {}));
    };
    try {
      const u = new URL(url);
      const mod = u.protocol === 'http:' ? require('http') : https;
      const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method: 'GET', timeout: 6000 }, (res) => {
        res.resume();
        finish(res.statusCode < 500, { statusCode: res.statusCode });
      });
      req.on('error', (e) => finish(false, { error: e.message }));
      req.on('timeout', () => { req.destroy(); finish(false, { error: '连接超时（6s）' }); });
      req.end();
    } catch (e) { finish(false, { error: 'URL 无效: ' + e.message }); }
  });
});

// ---------------------------------------------------------------------------
// CSV（Excel 兼容）导出：带 BOM，逗号转义
// ---------------------------------------------------------------------------
ipcMain.handle('app:saveCsv', async (_e, defaultName, content) => {
  try {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出 CSV（Excel 可直接打开）',
      defaultPath: defaultName || 'export.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, error: '已取消' };
    // \ufeff BOM 让 Excel 正确识别 UTF-8 中文
    fs.writeFileSync(r.filePath, '\ufeff' + content, 'utf8');
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// 系统通知
// ---------------------------------------------------------------------------
ipcMain.handle('app:notify', (_e, title, body) => {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: String(title || '通知'), body: String(body || '').slice(0, 300), silent: false });
      n.on('click', () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } });
      n.show();
    }
  } catch (err) { /* 忽略通知失败 */ }
  return { ok: true };
});

// 打开系统隐私设置（摄像头/麦克风被拒后一键跳转，用户手动允许后重试推流）
ipcMain.handle('app:openPrivacy', (_e, pane) => {
  const panes = { camera: 'Privacy_Camera', microphone: 'Privacy_Microphone' };
  const sub = panes[String(pane || 'camera').toLowerCase()] || 'Privacy_Camera';
  return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?' + sub)
    .then(() => ({ ok: true }))
    .catch((err) => ({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// ffmpeg 引擎：本地文件 / 采集设备推流、拉流录制、预览中继
// ---------------------------------------------------------------------------
function ffBin() {
  // 按平台 + 架构选择随包分发的 ffmpeg（extraResources/bin）
  const name = process.platform === 'win32'
    ? 'ffmpeg-win32-x64.exe'
    : (process.arch === 'arm64' ? 'ffmpeg-darwin-arm64' : 'ffmpeg-darwin-x64');
  // 打包后二进制在 extraResources/bin，开发态在项目 bin/
  const prodPath = path.join(process.resourcesPath || '', 'bin', name);
  if (app.isPackaged && fs.existsSync(prodPath)) return prodPath;
  return path.join(__dirname, 'bin', name);
}

const ffProcs = new Map();   // id -> { proc, cmd, kind, label, startedAt, logTail }
let ffSeq = 0;
function ffLogLine(id, line) {
  const rec = ffProcs.get(id);
  if (!rec) return;
  rec.logTail.push(line);
  if (rec.logTail.length > 200) rec.logTail.shift();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ff:log', { id, line, kind: rec.kind, label: rec.label });
  }
}
function ffSpawn(args, kind, label) {
  const id = 'ff' + (++ffSeq) + '_' + Date.now();
  const bin = ffBin();
  const cmd = [path.basename(bin)].concat(args).join(' ');
  let proc;
  try {
    proc = spawn(bin, args, { windowsHide: true });
  } catch (err) {
    return { ok: false, error: '启动 ffmpeg 失败：' + err.message };
  }
  const rec = { proc, cmd, kind, label, startedAt: new Date().toLocaleString('sv-SE'), logTail: [], _prog: {} };
  ffProcs.set(id, rec);
  ffReapProcs();   // v1.1.49：起新任务时顺手回收僵尸记录，避免长直播进程表无限膨胀
  proc.stderr.on('data', (d) => {
    String(d).split(/\r?\n/).forEach((l) => { if (l.trim()) ffLogLine(id, l); });
  });
  // -progress stdout 解析（push 任务）：每秒一组 key=value，progress=end 结束
  if (kind === 'push') {
    let buf = '';
    const emitProgress = (kv) => {
      rec._prog = Object.assign(rec._prog, kv);
      if (kv.progress) {
        const p = rec._prog;
        let instKbps = 0;
        const size = Number(p.total_size) || 0;
        const now = Date.now();
        if (rec._lastSize && now - rec._lastTs > 300) {
          instKbps = Math.max(0, ((size - rec._lastSize) * 8) / ((now - rec._lastTs) / 1000) / 1000);
        }
        rec._lastSize = size; rec._lastTs = now;
        rec._prog = {}; // 本轮结束，清空等待下一组
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ff:progress', {
            id, kind,
            frame: Number(p.frame) || 0,
            fps: Number(p.fps) || 0,
            // r68 修复：-progress 的 bitrate 形如 "2500.0kbits/s"、speed 形如 "1.02x"，
            // 直接 Number() 全部得 NaN → 推流速度/平均码率恒为 0（界面显示 --）。
            // 这里剥掉单位后缀再 parseFloat。
            // 首帧前 ffmpeg 会给出 "bitrate=  -0.0kbits/s" / "speed=N/A"，钳到 0 免得界面出现 -0
            bitrateKbps: Math.max(0, Math.round(ffNum(p.bitrate))),   // ffmpeg 累计平均码率 kbits/s
            instKbps: Math.max(0, Math.round(instKbps)),              // 瞬时码率（total_size 差分）
            totalSizeMB: Math.round(size / 1048576 * 10) / 10,
            speed: Math.max(0, Math.round(ffNum(p.speed) * 100) / 100)
          });
        }
      }
    };
    proc.stdout.on('data', (d) => {
      buf += String(d);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      const kv = {};
      lines.forEach((l) => {
        const m = l.match(/^([a-z_]+)=(.*)$/);
        if (m) kv[m[1]] = m[2].trim();
      });
      if (Object.keys(kv).length) emitProgress(kv);
    });
  }
  proc.on('error', (err) => { ffLogLine(id, '[错误] ' + err.message); });
  proc.on('close', (code) => {
    ffLogLine(id, code === 0 ? '[完成] 正常结束' : ('[退出] code=' + code));
    rec.exited = true;
    rec.code = code;
    rec.exitAt = Date.now();   // v1.1.49：供 ffReapProcs 判断可回收
  });
  return { ok: true, id, cmd };
}
function ffStop(id, sig) {
  const rec = ffProcs.get(id);
  if (!rec) return { ok: false, error: '任务不存在或已结束' };
  rec.stopReq = true;   // 用户主动停止 → 不触发自动重连
  try {
    if (process.platform === 'win32') { spawn('taskkill', ['/pid', String(rec.proc.pid), '/f', '/t']); }
    else rec.proc.kill(sig || 'SIGINT'); // SIGINT 让 ffmpeg 优雅收尾（写 moov 完整 mp4）
  } catch (e) { /* ignore */ }
  return { ok: true };
}

// 自动重连（OBS 同款）：推流进程意外退出后自动重启，最多 5 次、间隔 5 秒。
// mkArgs 闭包重建 ffmpeg 参数（设备源按最后一次成功的采集参数重启，避免重走协商试错）
// 重连退避阶梯（秒）：服务端抖动时若固定 5 秒猛打，容易被 CDN 判定为异常连接而拉黑
const RECONN_BACKOFF = [2, 4, 8, 16, 30];
// 稳定运行多久算「已恢复」→ 清零重连计数（毫秒）
const RECONN_STABLE_MS = 60000;

/**
 * v1.1.49：自动重连（对齐 OBS 的 Auto-reconnect 策略）。
 *
 * 旧实现的三个真实缺陷：
 *   1. 计数只增不减 → 一场 3 小时的直播里累计断 5 次（哪怕每次都成功恢复），
 *      第 6 次起就彻底失去重连能力，而用户完全不知情。
 *   2. 固定 5 秒间隔，无退避 → 服务端抖动时被连续猛打。
 *   3. 不区分错误类型 → 「编码器不存在」这种致命错误也会重启 5 次空转。
 */
function attachAutoRestart(id, rec, mkArgs, opt) {
  opt = opt || {};
  const max = opt.max || RECONN_BACKOFF.length;
  const sup = { tries: 0, timer: null, gaveUp: false };
  const notify = (kind, curId, waitSec) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ff:reconnect', {
        id: curId, label: rec.label, kind: kind,   // waiting | retried | gaveup | fatal
        tries: sup.tries, max: max, waitSec: waitSec || 0
      });
    }
  };
  const hook = (curId, curRec) => {
    curRec.autoRestart = sup;
    curRec.startedTs = Date.now();
    curRec.proc.once('close', () => {
      if (curRec.stopReq) return;                  // 用户主动停止 → 不重连
      // 稳定运行超过阈值视为「已恢复」，计数清零（修复缺陷 1）
      if (Date.now() - (curRec.startedTs || 0) > RECONN_STABLE_MS) sup.tries = 0;
      if (sup.tries >= max) {
        sup.gaveUp = true;
        ffLogLine(curId, '[自动重连] 已连续重试 ' + max + ' 次仍未恢复，停止重连（可手动重新开始）');
        notify('gaveup', curId);
        return;
      }
      // 致命错误不重试（修复缺陷 3）
      const log = (curRec.logTail || []).join('\n');
      if (FF_FATAL_ERR.test(log)) {
        sup.gaveUp = true;
        ffLogLine(curId, '[自动重连] 检测到不可恢复错误（编码器 / 参数 / 文件 / 设备），不再重试');
        notify('fatal', curId);
        return;
      }
      sup.tries++;
      const wait = RECONN_BACKOFF[Math.min(sup.tries - 1, RECONN_BACKOFF.length - 1)] * 1000;
      ffLogLine(curId, '[自动重连] 中断，' + (wait / 1000) + ' 秒后进行第 ' + sup.tries + '/' + max + ' 次重连…');
      notify('waiting', curId, wait / 1000);
      sup.timer = setTimeout(() => {
        if (curRec.stopReq) return;                // 等待期间用户已手动停止 → 取消
        ffReapProcs();                             // 顺手回收僵尸记录，避免长直播无限累积
        const r2 = ffSpawn(mkArgs(), curRec.kind, curRec.label);
        if (!r2.ok) { ffLogLine(curId, '[自动重连] 重启失败：' + r2.error); return; }
        const rec2 = ffProcs.get(r2.id);
        rec2.stopReq = false;
        // 老记录打上「已被接管」标记：界面不再显示，也不参与统计，但日志仍可查
        curRec.replacedBy = r2.id;
        ffLogLine(r2.id, '[自动重连] 已重新启动（原任务 ' + curId + '，第 ' + sup.tries + ' 次）');
        // 只有推流走 ff:restarted（渲染层据此把新 id 接回对应路数的统计图表）；
        // 录制续录不进推流状态机，避免串路。
        if (mainWindow && !mainWindow.isDestroyed() && curRec.kind === 'push') {
          mainWindow.webContents.send('ff:restarted', { oldId: curId, newId: r2.id, label: curRec.label, tries: sup.tries });
        }
        notify('retried', r2.id);
        hook(r2.id, rec2);
      }, wait);
    });
  };
  hook(id, rec);
  return sup;
}

/**
 * v1.1.49：录制续录的分段文件名。
 * 为什么要换文件名：ffmpeg 重连后若还写同一个输出路径，会把已录制的那一段整个覆盖掉，
 * 等于「断流恢复」反而丢掉了断之前的全部内容。切成 _part01 / _part02 才能保住已录部分。
 */
function recordSegPath(out, n) {
  if (!n) return out;
  var m = String(out).match(/^(.*?)((?:\.[A-Za-z0-9]+)?)$/);
  var base = m ? m[1] : String(out);
  var ext = (m && m[2]) ? m[2] : '';
  return base + '_part' + String(n).padStart(2, '0') + ext;
}

/**
 * v1.1.49：回收 ffProcs 里的僵尸记录。
 * 旧实现从不删除 —— 每次重连都往 Map 里新增一条，老记录标 running:false 却永久留着，
 * 一场直播下来 ff:list 会堆出几十条僵尸任务，界面任务列表越来越长。
 */
function ffReapProcs() {
  const now = Date.now();
  const KEEP_MS = 5 * 60 * 1000;      // 已退出满 5 分钟的记录可回收
  ffProcs.forEach((rec, id) => {
    if (rec.replacedBy) { ffProcs.delete(id); return; }               // 已被新进程接管
    if (rec.exited && rec.exitAt && now - rec.exitAt > KEEP_MS) ffProcs.delete(id);
  });
  // 兜底容量上限：超出时优先淘汰最老的已退出记录
  const MAX = 50;
  if (ffProcs.size > MAX) {
    const dead = [];
    ffProcs.forEach((rec, id) => { if (rec.exited) dead.push([id, rec.exitAt || 0]); });
    dead.sort((a, b) => a[1] - b[1]);
    let over = ffProcs.size - MAX;
    for (const [id] of dead) { if (over <= 0) break; ffProcs.delete(id); over--; }
  }
}
function ffList() {
  const out = [];
  ffProcs.forEach((rec, id) => {
    // v1.1.49：已被新进程接管的老记录不进列表（否则每次重连都多一条僵尸任务）
    if (rec.replacedBy) return;
    out.push({
      id, kind: rec.kind, label: rec.label, cmd: rec.cmd, startedAt: rec.startedAt,
      running: !rec.exited, logTail: rec.logTail.slice(-6),
      // 重连状态：界面可据此显示「重连中 x/5」
      reconnect: rec.autoRestart ? { tries: rec.autoRestart.tries, gaveUp: !!rec.autoRestart.gaveUp } : null
    });
  });
  return { ok: true, list: out };
}

function normalizePushUrls(rtmp) {
  // 多路推流：接受数组或换行分隔文本，每行一路 RTMP（去重、去空）
  const list = (Array.isArray(rtmp) ? rtmp : String(rtmp || '').split(/\r?\n/))
    .map((s) => String(s).trim()).filter(Boolean);
  return Array.from(new Set(list));
}

// r68：剥离 ffmpeg -progress 的数值单位后缀（"2500.0kbits/s" → 2500，"1.02x" → 1.02，"N/A" → 0）
function ffNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.eE+-]/g, ''));
  return isFinite(n) ? n : 0;
}

// ---------------- r68：推流协议 / 封装格式能力矩阵 ----------------
// 实测（内置 ffmpeg 6.0）：
//   [flv @ ..] Video codec hevc not compatible with flv → RTMP(FLV) 装不下 H.265/VP9，一启动即退出。
//   ffmpeg 6.0 的 flv muxer 无 enhanced_rtmp 选项，无法走增强型 RTMP 携带 HEVC。
// 因此按「协议 → 容器 → 可用编码」做前置校验，把硬崩溃换成可行动的提示。
const PUSH_MUX = {
  rtmp:  { fmt: 'flv',    label: 'RTMP(FLV)' },
  rtmps: { fmt: 'flv',    label: 'RTMPS(FLV)' },
  http:  { fmt: 'flv',    label: 'HTTP-FLV' },
  https: { fmt: 'flv',    label: 'HTTP-FLV' },
  srt:   { fmt: 'mpegts', label: 'SRT(MPEG-TS)' },
  rtsp:  { fmt: 'rtsp',   label: 'RTSP' },
  udp:   { fmt: 'mpegts', label: 'UDP(MPEG-TS)' },
  rtp:   { fmt: 'rtp',    label: 'RTP' }
};
// r70：编码器 → **编码族**。判断「能否进某容器」看的是编码族（H.264 / HEVC / VP9），
// 不是编码器名字 —— 否则每加一个硬件编码器就要到处补名单，漏一个就放行 HEVC 进 FLV 直接炸。
const ENC_FAMILY = {
  'libx264': 'h264', 'libx264rgb': 'h264', 'libopenh264': 'h264', 'h264': 'h264',
  'h264_videotoolbox': 'h264', 'h264_nvenc': 'h264', 'h264_qsv': 'h264', 'h264_amf': 'h264',
  'libx265': 'hevc', 'libkvazaar': 'hevc', 'hevc': 'hevc',
  'hevc_videotoolbox': 'hevc', 'hevc_nvenc': 'hevc', 'hevc_qsv': 'hevc', 'hevc_amf': 'hevc',
  'libvpx-vp9': 'vp9', 'vp9': 'vp9'
};
// 硬件编码器不接受 x264/x265 那套 -preset（nvenc 的 preset 是 p1~p7 / ll / hq，
// 传 veryfast 会直接报 Option not found），必须区别对待
const HW_ENC_RE = /_(videotoolbox|nvenc|qsv|amf)$/i;
function encFamily(c) { return ENC_FAMILY[String(c || '').toLowerCase()] || 'h264'; }
function isHwEncoder(c) { return HW_ENC_RE.test(String(c || '').toLowerCase()); }
// 各容器支持的**编码族**（flv 只认 H.264 / H.263 / VP6 / FLV1 等传统编码）
const MUX_CODECS = {
  flv:    ['h264'],
  mpegts: ['h264', 'hevc', 'vp9'],
  rtsp:   ['h264', 'hevc', 'vp9'],
  // rtp 沿用原口径不放行 VP9（VP9 over RTP 在本环境无法实测，保持保守）
  rtp:    ['h264', 'hevc']
};
function pushUrlScheme(u) {
  const m = String(u || '').match(/^([a-zA-Z]+):\/\//);
  return m ? m[1].toLowerCase() : '';
}
function muxForUrl(u) {
  return PUSH_MUX[pushUrlScheme(u)] || PUSH_MUX.rtmp;
}
// 返回 null = 该编码可进该容器；否则返回给用户的中文说明
function codecMuxProblem(codec, muxFmt, muxLabel) {
  const allow = MUX_CODECS[muxFmt] || MUX_CODECS.flv;
  const c = String(codec || 'libx264').toLowerCase();
  if (c === 'copy') return null;                       // 直拷不重新编码，容器沿用源流编码
  if (allow.indexOf(encFamily(c)) >= 0) return null;
  if (muxFmt === 'flv') {
    return 'H.265/HEVC、VP9 码流无法封装进 FLV 容器（RTMP 协议即 FLV）。' +
      '内置 ffmpeg 6.0 未提供 enhanced-RTMP 支持，推流会立刻失败。\n' +
      '可选方案：① 改用 H.264 编码（推荐）；② 改用 SRT 地址（srt://host:port?streamid=...）推 H.265/VP9；③ 改用 RTSP 地址（rtsp://...）。';
  }
  return '编码 ' + codec + ' 与 ' + muxLabel + ' 容器不兼容，请更换编码或推流协议。';
}
// r70：码率解析 —— 界面允许 "8000k" / "8M" / "8000000"，旧代码 parseInt 会把 "8M" 算成 8，
// 导致 -bufsize 变成 16k（4K 直接码率崩掉）。统一解析成 kbit/s 数字。
function bitrateK(v, defK) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  let m = s.match(/^([\d.]+)\s*k/); if (m) return Math.round(parseFloat(m[1]));
  m = s.match(/^([\d.]+)\s*m/);     if (m) return Math.round(parseFloat(m[1]) * 1000);
  m = s.match(/^([\d.]+)\s*g/);     if (m) return Math.round(parseFloat(m[1]) * 1000000);
  m = s.match(/^([\d.]+)/);         if (m) return Math.round(parseFloat(m[1]));   // 裸数字按 k 处理
  return defK == null ? 2500 : defK;
}
// r70：推荐码率（kbit/s）。
// 注意：**不能按像素线性外推** —— 3840×2160 是 1080p 的 4 倍像素，线性算会得出 18000k 这种
// 离谱值（实测 4K30 推 8000~9000k 已经很好）。码流随分辨率是**次线性**增长的：分辨率越高，
// 单像素分摊的码率越低（压缩效率随画面尺寸提升）。业界（Netflix 码率阶梯）用的是近似开方。
// 模型：k = 4500 × √(像素比 × 帧率比)，基准 1080p30 ≈ 4500k。与既有预设逐条对齐：
//   1080p30→4500 / 1080p60→6300(预设6000) / 4K30→9000(预设8000) / 4K60→12700(预设12000) / 720p30→3000(预设2500)
// H.265 同画质约为 H.264 的 62%（业界 60~65%），这正是它省带宽的价值所在。
function recommendBitrateK(w, h, fps, fam) {
  const px = (w || 1920) * (h || 1080);
  const f = fps || 30;
  const ratio = (px / (1920 * 1080)) * (f / 30);
  let k = 4500 * Math.sqrt(Math.max(0.01, ratio));
  if (fam === 'hevc') k *= 0.62;
  else if (fam === 'vp9') k *= 0.68;
  k = Math.round(k / 100) * 100;
  return Math.max(300, Math.min(60000, k));
}

// ---------------- r68：多文件素材（OBS 播放列表式） ----------------
// 用 ffmpeg concat demuxer 把多个素材串成一个虚拟输入，配合 -stream_loop 循环整轮。
// 写临时清单到系统临时目录（路径做了单引号转义，兼容带空格/中文的文件名）。
function writeConcatList(files) {
  const listPath = path.join(os.tmpdir(), 'gf_concat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.txt');
  const body = files.map((f) => "file '" + String(f).replace(/\\/g, '/').replace(/'/g, "'\\''") + "'").join('\n') + '\n';
  fs.writeFileSync(listPath, body, 'utf8');
  return listPath;
}

// ---------------- 采集设备起流能力探测重试 ----------------
// 实测根因：设备「自动协商」可能选中不被支持的帧率/分辨率。例如某虚拟采集卡仅支持
// 1920x1080@60fps，默认按 29.97fps 起流直接 Input/output error。策略：
//   第 1 次：自动协商；若 6 秒内进程退出且日志含采集错误 →
//   从错误输出解析设备支持模式（avfoundation 格式「1920x1080@[60.000000 60.000000]fps」），
//   按最接近请求帧率的模式显式重试；解析不到模式时按常见帧率梯度（30/25/60/15）重试，最多 4 次。
const FF_CAPTURE_ERR = /avfoundation|dshow|selected framerate|supported modes|could not find (video|audio)|not supported by the device|input\/output error/i;
// 瞬时网络/传输错误：实测对端偶发握手 Input/output error（重试即成功）、连接重置等。
// 这类错误此前直接放弃（只在采集错误时重试），用户视角 = 点开始推流几秒后任务静默消失。
//
// v1.1.49 修正：旧正则含裸 `rtmp`。ffmpeg 启动会回显整条命令行（里面必然有 rtmp:// 地址），
// 于是「日志里出现推流地址」就被判成网络错误 —— 无论真正原因是什么都触发重试，
// 连「编码器不存在」这种致命错误也会被无意义地重启。改为只匹配明确的传输故障措辞。
const FF_RTMP_ERR = /input\/output error|i\/o error|connection (refused|reset|aborted|timed out)|unable to (connect|open)|failed to (connect|open)|handshake failed|network is unreachable|no route to host|server closed|broken pipe|timed? ?out|end of file/i;
// 不可恢复错误：重连一百次也是同样的错（编码器/参数/文件/设备问题），直接放弃，避免无限空转
const FF_FATAL_ERR = /unknown encoder|encoder .* not found|invalid argument|no such file|not found|permission denied|unrecognized option|option .* not found|incorrect codec parameters|error opening filters|cannot find|invalid data found when processing input/i;
function parseDevModes(log) {
  const modes = [];
  const re = /(\d{2,5})x(\d{2,5})@\[?([\d.]+)[ ,]+([\d.]+)\]?/g;
  let m;
  while ((m = re.exec(log))) modes.push({ w: +m[1], h: +m[2], min: +m[3], max: +m[4] });
  return modes;
}
function pickDevMode(modes, reqFps) {
  if (!modes || !modes.length) return null;
  const target = reqFps || 30;
  const sorted = modes.slice().sort((a, b) =>
    Math.abs(a.max - target) - Math.abs(b.max - target) ||
    (a.w >= a.h ? 0 : 1) - (b.w >= b.h ? 0 : 1) ||        // 优先横屏
    Math.abs(a.h - 1080) - Math.abs(b.h - 1080) ||        // 分辨率高度接近 1080p
    b.w * b.h - a.w * a.h);                               // 同类取更大分辨率
  return sorted[0];
}
async function ffSpawnDevice(buildFn, kind, label, src0, reqFps) {
  let modes = null;             // 从失败日志解析出的支持模式
  const tried = [];
  const waitExit = (rec, ms) => new Promise((resolve) => {
    const t = setTimeout(() => resolve('alive'), ms);
    rec.proc.once('close', () => { clearTimeout(t); resolve('exit'); });
  });
  const attempt = (cap) => {
    tried.push(cap);
    const src = Object.assign({}, src0, cap);
    const r = ffSpawn(buildFn(src), kind, label);
    if (r.ok) r.lastCap = cap;      // 记录本次采集参数（自动重连时按最后一组可用参数重启）
    return { r, rec: r.ok ? ffProcs.get(r.id) : null };
  };
  // 第 1 次：设备自动协商（不带任何采集约束）
  let { r, rec } = attempt({});
  if (!r.ok) return r;
  let verdict = await waitExit(rec, 6000);
  let n = 0;
  while (verdict === 'exit' && n < 3) {
    const log = rec.logTail.join('\n');
    const capErr = FF_CAPTURE_ERR.test(log);
    const rtmpErr = !capErr && FF_RTMP_ERR.test(log);
    if (!capErr && !rtmpErr) return r;   // 其他错误（参数/编码/磁盘等）→ 不重试
    ffProcs.delete(r.id);      // 清理失败尝试的记录
    let cap = {};
    if (capErr) {
      // 采集错误：从失败日志解析设备支持模式，按最接近请求帧率的模式显式重试
      if (!modes) modes = parseDevModes(log);
      const caps = [];
      if (modes.length) {
        const target = reqFps || 30;
        modes.slice().sort((a, b) =>
          Math.abs(a.max - target) - Math.abs(b.max - target) ||
          (a.w >= a.h ? 0 : 1) - (b.w >= b.h ? 0 : 1) ||
          Math.abs(a.h - 1080) - Math.abs(b.h - 1080) ||
          b.w * b.h - a.w * a.h)
          .slice(0, 3).forEach((md) => caps.push({ capSize: md.w + 'x' + md.h, capFps: Math.round(md.max) }));
      } else {
        [30, 25, 60, 15].forEach((f) => caps.push({ capFps: f }));
      }
      cap = caps.find((c) => !tried.some((t) => t.capFps === c.capFps && t.capSize === c.capSize));
      if (!cap) break;
    } else {
      // 瞬时 RTMP/网络错误：等待 2 秒按原参数重试（OBS 同款；首次握手偶发失败重试即成功）
      ffLogLine(r.id, '[自动重试] 推流连接瞬时失败（' + (log.split(/\r?\n/).filter(Boolean).pop() || '未知错误').slice(0, 120) + '），2 秒后重试…');
      await new Promise((res) => setTimeout(res, 2000));
    }
    ({ r, rec } = attempt(cap));
    if (!r.ok) return r;
    verdict = await waitExit(rec, 6000);
    n++;
  }
  return r;
}

/**
 * v1.1.37：为「作为叠加层」的 OBS 来源构造 ffmpeg 输入参数。
 * 返回值：字符串数组（形如 ['-i', '/path'] 或 ['-f','dshow','-i','video=...']）；
 *         无法构造（未选文件 / 无设备）时返回 null，调用方跳过该来源。
 *
 * 注意：主画面（source 参数）仍走 buildPushArgs 里的原有分支，本函数只处理叠加层。
 */
function ffSourceInputArgs(s, primarySrc) {
  const st = s.settings || {};
  if (s.type === 'image_source' || s.type === 'image') {
    const p = st.file || s.path || '';
    return p ? ['-i', p] : null;
  }
  if (s.type === 'ffmpeg_source') {
    // 媒体源：本地文件作为叠加输入（视频/音频文件均可，视频才参与 overlay）
    const p = st.is_local_file === false ? (st.input || '') : (st.local_file || st.file || '');
    if (!p) return null;
    const a = [];
    if (st.looping) a.push('-stream_loop', '-1');
    a.push('-i', p);
    return a;
  }
  if (s.type === 'av_capture_input') {
    // 摄像头：设备标识由渲染层「来源属性」下拉填充（Windows 为 dshow 的 "video=<名称>"，
    // macOS 为 avfoundation 的 "video:audio" 序号串）。这里做平台适配。
    const dev = st.device != null ? String(st.device) : '';
    if (!dev) return null;
    const a = [];
    if (process.platform === 'darwin') {
      // avfoundation：设备串形如 "0" 或 "0:1"（视频:音频）
      a.push('-f', 'avfoundation', '-i', dev);
    } else {
      // dshow：若渲染层给的是裸名称则补 "video=" 前缀，已是完整串则原样使用
      const dshow = /^(video|audio)=/i.test(dev) ? dev : ('video=' + dev);
      a.push('-f', 'dshow', '-i', dshow);
    }
    return a;
  }
  if (s.type === 'monitor_capture') {
    // 显示器捕获：Windows 用 gdigrab 抓屏，macOS 用 avfoundation 的屏幕设备。
    const mon = st.monitor != null ? String(st.monitor) : '0';
    const a = [];
    if (process.platform === 'darwin') {
      a.push('-f', 'avfoundation', '-i', (mon || '1'));
    } else {
      // gdigrab：monitor 为 '0' / 空 → 抓整屏 desktop；否则抓指定窗口标题
      if (!mon || mon === '0') a.push('-f', 'gdigrab', '-framerate', '30', '-i', 'desktop');
      else a.push('-f', 'gdigrab', '-framerate', '30', '-i', 'title=' + mon);
    }
    return a;
  }
  if (s.type === 'browser_source') {
    // 浏览器源：无内置浏览器内核。能力受限 —— 若用户提供了预渲染帧序列/静帧路径则作为图片输入，
    // 否则返回 null（由 compileSceneGraph 记为 skipped，日志提示）。
    const p = st.snapshot || st.file || '';
    return p ? ['-i', p] : null;
  }
  return null;
}

// v1.1.43：判断某来源的输入流是否含音频轨（多源音频混音用）。
// 与 ffSourceInputArgs 同源判定：能产生音频轨的来源才纳入 amix。
function ffSourceHasAudio(s) {
  const st = (s && s.settings) || {};
  if (!s) return false;
  if (s.type === 'ffmpeg_source') {
    // 媒体源：本地媒体文件通常含音频轨（具体有无由 ffmpeg 探测，混音时用 :a? 语义兜底）
    const p = st.is_local_file === false ? (st.input || '') : (st.local_file || st.file || '');
    return !!p;
  }
  if (s.type === 'av_capture_input') {
    // 摄像头：仅当显式指定了音频设备时才带音频轨
    const dev = st.device != null ? String(st.device) : '';
    if (!dev) return false;
    if (process.platform === 'darwin') {
      // avfoundation 串形如 "0:1"（视频:音频），含冒号即带音频
      return /:/.test(dev) && dev.split(':')[1] !== '';
    }
    // dshow：video=名:audio=名 或带 :audio=
    return /:audio=/.test(dev);
  }
  return false;
}

function buildPushArgs(o) {
  // o: { source: { type, path, deviceVideo, deviceAudio }, rtmp(数组/多路), videoBitrate, outSize, fps, loop, copy,
  //       codec, flip, zoom, preset, gopSec, profile, audioBr }
  const urls = normalizePushUrls(o.rtmp);
  const args = ['-hide_banner', '-loglevel', 'info'];
  const src = o.source || {};
  if (src.type === 'file') {
    // r68：素材列表（多文件）→ concat demuxer 串成一个输入；单文件沿用原路径
    var fileList = Array.isArray(src.files) ? src.files.filter(Boolean) : [];
    if (!fileList.length && src.path) fileList = [src.path];
    if (fileList.length > 1) {
      const listPath = writeConcatList(fileList);
      if (o.loop) args.push('-stream_loop', '-1');
      args.push('-re', '-f', 'concat', '-safe', '0', '-i', listPath);
    } else {
      if (o.loop) args.push('-stream_loop', '-1');
      args.push('-re', '-i', (fileList[0] || src.path));
    }
  } else if (src.type === 'device') {
    if (src.capFps) args.push('-framerate', String(src.capFps));
    if (src.capSize && /^\d{2,5}x\d{2,5}$/.test(src.capSize)) args.push('-video_size', src.capSize);
    if (process.platform === 'darwin') {
      const dev = src.deviceVideo || '0';
      const au = (src.deviceAudio !== undefined && src.deviceAudio !== '') ? (':' + src.deviceAudio) : '';
      args.push('-f', 'avfoundation', '-i', dev + au);
    } else {
      let dshow = 'video=' + (src.deviceVideoName || src.deviceVideo || '');
      if (src.deviceAudio !== undefined && src.deviceAudio !== '') dshow += ':audio=' + (src.deviceAudioName || src.deviceAudio);
      args.push('-f', 'dshow', '-i', dshow);
    }
  }
  // r71：图片来源作为独立输入流（主画面为 0，图片依次为 1、2…），规避 movie 滤镜文件名转义坑
  // v1.1.37：扩展到 OBS 全部需要独立输入的来源类型（图片 / 媒体源 / 摄像头 / 显示器捕获 / 浏览器源），
  //          逐个追加 -i 并把「来源 id → 输入流序号」回填 inputMap，供 compileSceneGraph 组装叠加图。
  const overlaySources = (o.sources || []).filter(function (s) {
    return s && s.enabled !== false && ffNeedsInput(s.type);
  });
  const imgInputs = [];     // 兼容 composeVideoFilter 旧签名：图片类输入流序号
  const inputMap = {};      // { sourceId: 输入流序号 }
  const audioInputs = [];   // v1.1.43：含音频的输入流 { inIdx, volume, muted }
  let inIdx = 0;            // 输入流计数（主画面已占用 0）
  overlaySources.forEach(function (s) {
    const inArgs = ffSourceInputArgs(s, src);
    if (!inArgs) return;                       // 该来源无法构造输入（如媒体源未选文件）→ 跳过
    args.push.apply(args, inArgs);
    inIdx += 1;
    inputMap[s.id] = inIdx;
    if (s.type === 'image_source' || s.type === 'image') imgInputs.push(inIdx);
    // v1.1.43：叠加源含音频轨时纳入混音
    if (ffSourceHasAudio(s)) {
      audioInputs.push({ inIdx: inIdx, volume: s.volume, muted: s.muted });
    }
  });
  const hasAudio = src.type === 'file' || (src.deviceAudio !== undefined && src.deviceAudio !== '');
  // v1.1.43：主画面（输入 0）含音频时置于混音首位
  if (hasAudio) audioInputs.unshift({ inIdx: 0, volume: (src.volume !== undefined ? src.volume : 1), muted: !!src.muted });
  // v1.1.47：独立音频源（声音与画面解耦）。inputIndex 排在图片输入之后，避免图片 [n:v] 序号错位。
  const audioPlan = composeAudioPlan(Object.assign({}, (o.audioPlan || {}), {
    inputIndex: 1 + imgInputs.length,
    isDarwin: process.platform === 'darwin'
  }));
  if (audioPlan.inputArgs && audioPlan.inputArgs.length) {
    args.push.apply(args, audioPlan.inputArgs);
    inIdx += 1;   // 独立音频输入占一个流序号（-i 已在 inputArgs 中追加）
  }
  // r66：编码器选择（默认 libx264，支持 H.265/HEVC、VP9）
  const codec = o.codec || 'libx264';
  // r70：按**编码族**判断，不再比对编码器名字 —— 这样 hevc_videotoolbox / hevc_nvenc
  // 等硬件编码器一加入就自动继承「HEVC 不能进 FLV」的约束，不用逐个补名单。
  const fam = encFamily(codec);
  const isHevc = fam === 'hevc';
  const isVP9 = fam === 'vp9';
  const isHw = isHwEncoder(codec);
  if (o.copy && src.type === 'file') {
    args.push('-c', 'copy');
  } else {
    // 基础视频编码参数
    args.push('-c:v', codec);
    if (isHw) {
      // 硬件编码器：不传 -preset/-tune（nvenc 的 preset 语义完全不同，传 veryfast 直接报
      // "Option not found"）。videotoolbox 用 -realtime 1 保证低延迟、-allow_sw 1 在硬件
      // 被占用时回落软件编码而不是直接失败（4K 场景常见）。
      if (/_videotoolbox$/i.test(codec)) args.push('-realtime', '1', '-allow_sw', '1');
    } else if (!isVP9) {
      args.push('-preset', o.preset || 'veryfast');
      if (!isHevc) args.push('-tune', 'zerolatency');   // H.265 的 tune 走 x265-params，避免重复设置导致 x265 报错
    } else {
      // VP9：-cpu-used 映射（0=最慢最好 ~ 8=最快最差）
      const cpuUsed = { ultrafast:8, superfast:7, veryfast:6, faster:5, fast:4, medium:2 };
      args.push('-cpu-used', String(cpuUsed[o.preset] || 4), '-deadline', 'realtime');
    }
    // r70：先把码率统一解析成 kbit/s 再拼参数，修掉 "8M" → bufsize 16k 的老 bug。
    // 直播用 maxrate = 1.0×目标、bufsize = 2×目标（OBS 同款 CBR 手感）；
    // 4K 这类大码率再放宽容差到 1.05×，避免瞬时峰值被压导致画面糊。
    const bK = bitrateK(o.videoBitrate, 2500);
    const maxK = Math.round(bK * (bK >= 8000 ? 1.05 : 1.0));
    args.push('-b:v', bK + 'k', '-maxrate', maxK + 'k', '-bufsize', (bK * 2) + 'k');
    // 像素格式：H.264/H.265/VP9 直播统一 yuv420p（兼容性最好）
    args.push('-pix_fmt', 'yuv420p');
    // 关键帧间隔
    const gopFrames = Math.max(20, Math.round((o.fps || 25) * (Number(o.gopSec) || 2)));
    args.push('-g', String(gopFrames));
    args.push('-r', String(o.fps || 25));
    if (isHevc && !isHw) {
      // H.265 优化（r71）：x265-params 一次性控制 GOP / 场景切换 / 调优档，比单独 -g 更可靠；
      // 关闭 B 帧（bf 0）压低端到端延迟，配合 SRT/WebRTC 实现超低延时直播。
      const h265Profile = o.h265Profile && /^(main|main10|mainstillpicture)$/i.test(o.h265Profile) ? o.h265Profile : 'main';
      const h265Tune = o.h265Tune && /^(zerolatency|fastdecode|animation)$/i.test(o.h265Tune) ? o.h265Tune : 'zerolatency';
      args.push('-profile:v', h265Profile);
      args.push('-pix_fmt', h265Profile.toLowerCase() === 'main10' ? 'yuv420p10le' : 'yuv420p');
      args.push('-x265-params', 'keyint=' + gopFrames + ':min-keyint=' + gopFrames + ':scenecut=0:repeat-headers=1:tune=' + h265Tune);
      args.push('-bf', '0');
    } else if (o.profile && fam === 'h264' && !isHw) {
      // H.264 Profile（HEVC/VP9 无此选项，硬件编码器用各自默认）
      args.push('-profile:v', o.profile);
    }
    // r71：视频滤镜链（缩放 + 翻转 + 旋转(横竖屏) + OBS 来源叠加）
    // v1.1.37：升级为 compileSceneGraph —— 支持 OBS 全部 7 类来源（图片/文字/媒体源/摄像头/
    //          显示器捕获/色源/浏览器源）进入同一张 filter_complex 叠加图。
    //          只要来源里出现「文字」或「需独立输入的叠加源」，就统一交给 compileSceneGraph
    //          （OBS 形态的 text_ft2_source 必须由它翻译成 drawtext，composeVideoFilter 只认 legacy 'text'）。
    const synthSrcs = (o.sources || []).filter(function (s) {
      return s && s.enabled !== false &&
        (ffNeedsInput(s.type) || s.type === 'color_source' ||
         s.type === 'text_ft2_source' || s.type === 'text');
    });
    var vfRes;
    if (synthSrcs.length) {
      const g = compileSceneGraph(o, o.sources, inputMap);
      // 有多输入叠加图时优先用 complex；若来源全被跳过则退回基础画布
      if (g.complex) vfRes = { complex: g.complex, map: g.map };
      else vfRes = g.plain || composeVideoFilter(o, imgInputs);
      // 能力受限来源（如浏览器源无预渲染帧）在此记录，随任务日志提示用户
      if (g.skipped && g.skipped.length) {
        o.__skippedSources = g.skipped;
      }
    } else {
      vfRes = composeVideoFilter(o, imgInputs);
    }
    // v1.1.43：多源音频混音（主画面 + 叠加源）。先算出音频混音链（多路才返回非 null）。
    const amix = compileAudioMix(audioInputs, { audioRate: '44100' });
    // v1.1.47：独立音频源与画面音频的关系，统一组装成「音频滤镜图 + 输出 map + 是否编码」三元组。
    //   mode=off     → 禁音轨（-an）
    //   mode=source  → 沿用 v1.1.43 行为（amix 或 -map 0:a?）
    //   mode=device/url → 独立音源（chain 产 [aind]）；mix=true 与画面音频 amix（duration=first:normalize=0），
    //                      否则独立音源独占音轨
    var audioComplex = null, audioMap = null, audioHas = false;
    if (audioPlan.mode === 'off') {
      audioHas = false;
    } else if (audioPlan.mode === 'device' || audioPlan.mode === 'url') {
      // 独立音源：mix 时画面音频 [0:a] 混入；不 mix 时独立音源独占
      if (audioPlan.mix && hasAudio) {
        audioComplex = '[0:a]aresample=async=1:first_pts=0,aformat=sample_rates=44100:channel_layouts=stereo[am0];' +
          audioPlan.chain.replace(/\[aind\]$/, '[am1]') +
          ';[am0][am1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]';
        audioMap = '[aout]';
        audioHas = true;
      } else {
        audioComplex = audioPlan.chain.replace(/\[aind\]$/, '[aout]');
        audioMap = '[aout]';
        audioHas = true;
      }
    } else {
      // source（默认）：沿用 v1.1.43 行为
      if (amix) { audioComplex = amix.complex; audioMap = amix.map; audioHas = true; }
      else if (hasAudio) { audioComplex = null; audioMap = '0:a?'; audioHas = true; }
      else { audioHas = false; }
    }
    // v1.1.49：音频滤镜（降噪/增益/噪声门/压缩/限幅）——统一挂在「最终输出音轨」上，
    // 这样无论音频来自画面、独立声卡还是多路混音，处理链都只跑一次且顺序固定。
    //   有音频图（[aout]）→ 在图尾接一段 [afin]<chain>[aout]；
    //   无音频图（单路 -map 0:a? 直通）→ 用 -af，避免为了挂滤镜强行构造 filter_complex。
    var audioAf = '';
    if (audioHas) {
      const afRes = composeAudioFilter(o.audioFilters);
      if (afRes.chain) {
        if (audioComplex) {
          audioComplex = audioComplex.replace(/\[aout\]$/, '[afin]') + ';[afin]' + afRes.chain + '[aout]';
        } else {
          audioAf = afRes.chain;
        }
      }
    }
    if (vfRes.complex) {
      // 多输入叠加图：把音频图并入同一 filter_complex（视频图末尾 [vout] + 音频图末尾 [aout]）
      args.push('-filter_complex', vfRes.complex + (audioComplex ? (';' + audioComplex) : ''));
      args.push('-map', vfRes.map);
      if (audioComplex) args.push('-map', audioMap);
      else if (audioHas) args.push('-map', audioMap || '0:a?');
    } else if (vfRes.vf) {
      if (audioComplex) {
        // 视频走单输入 -vf 但音频有图（叠加源/独立音源混音）→ 把 -vf 链包装成图，与音频图合并
        args.push('-filter_complex', '[0:v]' + vfRes.vf + '[vout];' + audioComplex);
        args.push('-map', '[vout]');
        args.push('-map', audioMap);
      } else {
        args.push('-vf', vfRes.vf);
      }
    }
    if (audioAf) args.push('-af', audioAf);
    // 音频编码：有音频（主画面/混音/独立音源）时编码 AAC；否则禁音轨
    if (audioHas) args.push('-c:a', 'aac', '-b:a', o.audioBr || '128k', '-ar', '44100');
    else args.push('-an');
  }
  // 注入 -progress：stdout 每秒输出 frame/fps/bitrate/total_size/speed 键值对，供质量小窗实时图表。
  // r68：原来由 ff:run 用 splice 在 "-f flv url" 数组尾部倒推插入——按 urls.length*3 估算，
  // 一旦某路是 RTSP（多 2 个 -rtsp_transport 参数）就会插错位置拼出 "-f -progress pipe:1"，
  // ffmpeg 立即以 "Requested output format '-progress' ..." 退出（v1.1.6 本地推流一启动即死的根因）。
  // 改为在编码器参数之后、输出参数之前直接压入，位置永远正确。
  args.push('-progress', 'pipe:1', '-nostats', '-stats_period', '1');
  // 多路输出：一次编码，同时推到 N 路（r68：按各路协议自动选容器，SRT/RTSP 走 mpegts/rtsp）
  urls.forEach((u) => {
    const m = muxForUrl(u);
    if (m.fmt === 'rtsp') {
      // RTSP 推流（announce）必须显式指定传输方式，tcp 在 NAT/防火墙下最稳
      args.push('-rtsp_transport', 'tcp', '-f', 'rtsp', u);
    } else {
      args.push('-f', m.fmt, u);
    }
  });
  return args;
}

function buildRecordArgs(o) {
  // o: { url, out, recordBitrate, recordMaxrate } 或 { source: { type:'device', deviceVideo, deviceAudio }, out, recordBitrate, recordMaxrate }
  const args = ['-hide_banner', '-loglevel', 'info', '-y'];
  if (o.source && o.source.type === 'device') {
    // 外接采集设备录制：avfoundation(macOS) / dshow(Windows) 采集原始帧，必须转码封装。
    // 采集参数默认自动协商，重试时支持显式 capFps/capSize（见 ffSpawnDevice）
    const src = o.source;
    if (src.capFps) args.push('-framerate', String(src.capFps));
    if (src.capSize && /^\d{2,5}x\d{2,5}$/.test(src.capSize)) args.push('-video_size', src.capSize);
    if (process.platform === 'darwin') {
      const dev = src.deviceVideo || '0';
      const au = (src.deviceAudio !== undefined && src.deviceAudio !== '') ? (':' + src.deviceAudio) : '';
      args.push('-f', 'avfoundation', '-i', dev + au);
    } else {
      // Windows dshow：video=名:audio=名
      let dshow = 'video=' + (src.deviceVideoName || src.deviceVideo || '');
      if (src.deviceAudio !== undefined && src.deviceAudio !== '') dshow += ':audio=' + (src.deviceAudioName || src.deviceAudio);
      args.push('-f', 'dshow', '-i', dshow);
    }
    const br = parseInt(o.recordBitrate) || 4500;
    const mx = parseInt(o.recordMaxrate) || br;   // 最高码率可自定义，留空 = 与码率一致
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-b:v', br + 'k', '-maxrate', mx + 'k', '-bufsize', (mx * 2) + 'k',
      '-pix_fmt', 'yuv420p', '-g', '60'
    );
    if (src.deviceAudio !== undefined && src.deviceAudio !== '') args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100');
    else args.push('-an');
    args.push('-movflags', '+faststart', o.out);
    return args;
  }
  // 拉流录制：默认流复制（-c copy）不转码；指定 recordBitrate 时用 libx264 转码到目标码率
  args.push('-i', o.url);
  const br = parseInt(o.recordBitrate);
  if (br > 0) {
    const mx = parseInt(o.recordMaxrate) || br;   // 最高码率可自定义，留空 = 与码率一致
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-b:v', br + 'k', '-maxrate', mx + 'k', '-bufsize', (mx * 2) + 'k',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100'
    );
  } else {
    args.push('-c', 'copy', '-bsf:a', 'aac_adtstoasc');
  }
  args.push('-movflags', '+faststart', o.out);
  return args;
}

ipcMain.handle('ff:run', async (_e, args) => {
  if (!fs.existsSync(ffBin())) return { ok: false, error: '未找到内置 ffmpeg（bin/ 目录缺失）' };
  if (args.kind === 'push') {
    // v1.1.38：libobs 真引擎（可选）。渲染层在用户显式选 libobs 引擎且单路推流时，
    // 携带 engine='libobs' 与 obsScene，主进程据此走原生合成 + RTMP 输出。
    if (args.engine === 'libobs') {
      const eng = getObsEngine();
      if (!eng) return { ok: false, error: 'libobs 引擎不可用（原生桥接未编译/未打包），已回退 ffmpeg' };
      const u = normalizePushUrls(args.rtmp)[0];
      if (!u) return { ok: false, error: '请填写推流地址' };
      try {
        const size = (args.obsScene && args.obsScene.size) || args.outSize || '1920x1080';
        const m = String(size).match(/^(\d{3,5})x(\d{3,5})$/);
        eng.pushScene(args.obsScene, { baseWidth: m ? Number(m[1]) : 1920, baseHeight: m ? Number(m[2]) : 1080, fps: Number(args.fps) || 30 });
        const srv = splitRtmp(u);
        const ok = eng.startStream(srv.server, srv.key, args);
        if (!ok) return { ok: false, error: 'libobs 输出启动失败（检查编码器插件是否已编译进 CI 产物）' };
        return { ok: true, id: 'obs', engine: 'libobs', url: u };
      } catch (e) {
        return { ok: false, error: 'libobs 引擎错误：' + e.message };
      }
    }
    const urls = normalizePushUrls(args.rtmp);
    if (!urls.length) return { ok: false, error: '请填写至少一路推流地址（rtmp:// / srt:// / rtsp://）' };
    // r68：放宽协议校验——SRT/RTSP 是 H.265/VP9 唯一可行的推流通道
    for (const u of urls) {
      if (!/^(rtmp|rtmps|srt|rtsp|http|https|udp|rtp):\/\//i.test(u)) {
        return { ok: false, error: '推流地址需为 rtmp:// / srt:// / rtsp:// 开头：' + u.slice(0, 50) };
      }
    }
    // r68：编码 × 容器兼容性前置校验（H.265 推 RTMP 会硬失败，这里提前给出可行动提示）
    if (!args.copy) {
      const codec = args.codec || 'libx264';
      for (const u of urls) {
        const m = muxForUrl(u);
        const problem = codecMuxProblem(codec, m.fmt, m.label);
        if (problem) {
          return { ok: false, error: '【编码与推流协议不兼容】' + problem + '\n当前地址：' + u.slice(0, 60) + '（' + m.label + '）' };
        }
      }
    }
    const src = args.source || {};
    const mkPushArgs = (s) => {
      // r68：-progress 已由 buildPushArgs 在输出参数之前正确压入，无需再 splice
      return buildPushArgs(Object.assign({}, args, { source: s, rtmp: urls }));
    };
    // 采集设备源：起流失败自动按设备支持模式重试（能力探测）
    if (src.type === 'device') {
      const res = await ffSpawnDevice((s) => mkPushArgs(s), 'push', args.label || urls[0], src, Number(args.fps) || 30);
      if (res.ok && args.autoRestart && ffProcs.get(res.id)) {
        attachAutoRestart(res.id, ffProcs.get(res.id), () => mkPushArgs(Object.assign({}, src, res.lastCap || {})));
      }
      return res;
    }
    // 文件源：瞬时 RTMP/网络错误自动重试（与设备源同款；实测首次握手偶发 Input/output error，
    // 重试即成功；非 RTMP 错误如文件不存在不重试直接返回，由日志透出真实原因）
    let r = ffSpawn(mkPushArgs(src), 'push', args.label || urls[0]);
    if (!r.ok) return r;
    for (let t = 0; t < 2; t++) {
      const rec0 = ffProcs.get(r.id);
      if (!rec0) break;
      const verdict = await new Promise((resolve) => {
        const t2 = setTimeout(() => resolve('alive'), 6000);
        rec0.proc.once('close', () => { clearTimeout(t2); resolve('exit'); });
      });
      if (verdict === 'alive') break;
      const log = rec0.logTail.join('\n');
      if (!FF_RTMP_ERR.test(log)) break;
      ffProcs.delete(r.id);
      ffLogLine(r.id, '[自动重试] 推流连接瞬时失败，2 秒后重试…');
      await new Promise((res) => setTimeout(res, 2000));
      r = ffSpawn(mkPushArgs(src), 'push', args.label || urls[0]);
      if (!r.ok) return r;
    }
    if (r.ok && args.autoRestart && ffProcs.get(r.id)) {
      attachAutoRestart(r.id, ffProcs.get(r.id), () => mkPushArgs(src));
    }
    return r;
  }
  if (args.kind === 'record') {
    // v1.1.49：录制也支持断流自动续录（直播录制断一次就整段丢失，代价太大）。
    // 续录必须切到新文件名，否则 ffmpeg 会覆盖掉断流前已录好的那一段。
    const attachRecordReconn = (r, mk) => {
      if (!r.ok || !args.autoRestart) return r;
      const rec = ffProcs.get(r.id);
      if (!rec) return r;
      let seg = 0;
      attachAutoRestart(r.id, rec, () => {
        seg++;
        const out2 = recordSegPath(args.out, seg);
        ffLogLine(r.id, '[自动续录] 输出切换到 ' + out2 + '（已录部分保留在上一分段）');
        return mk(out2);
      }, { max: 3 });
      return r;
    };
    // 设备源录制（外接采集卡 / 摄像头）与拉流 URL 录制两种来源
    if (args.source && args.source.type === 'device') {
      if (!args.source.deviceVideo) return { ok: false, error: '请选择视频采集设备' };
      const res = await ffSpawnDevice(
        (s) => buildRecordArgs(Object.assign({}, args, { source: s })),
        'record', args.label || args.out, args.source, 30
      );
      return attachRecordReconn(res, (out2) => buildRecordArgs(Object.assign({}, args, {
        source: Object.assign({}, args.source, res.lastCap || {}), out: out2
      })));
    }
    if (!/^(rtmp|https?|artc|srt):\/\//i.test(args.url || '')) return { ok: false, error: '录制地址必须是 rtmp/http(s)/srt 链接' };
    return attachRecordReconn(
      ffSpawn(buildRecordArgs(args), 'record', args.label || args.out),
      (out2) => buildRecordArgs(Object.assign({}, args, { out: out2 }))
    );
  }
  return { ok: false, error: '未知任务类型' };
});
ipcMain.handle('ff:stop', (_e, id) => ffStop(id));
ipcMain.handle('ff:list', () => ffList());
ipcMain.handle('ff:pickFile', async () => {
  // r68：素材列表一次可多选（OBS 式批量导入）；paths 与 path 都返回，老调用方不受影响
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择本地视频素材（可多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '视频文件', extensions: ['mp4', 'flv', 'mkv', 'mov', 'avi', 'ts', 'm3u8', 'webm'] }]
  });
  return r.canceled ? { ok: false } : { ok: true, path: r.filePaths[0], paths: r.filePaths };
});
ipcMain.handle('ff:pickDir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { title: '选择录制保存目录', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? { ok: false } : { ok: true, path: r.filePaths[0] };
});
// ---------------------------------------------------------------------------
// r70：运行时探测本机可用编码器
// 为什么不能在前端写死编码器菜单：内置 ffmpeg 在不同平台编译的编码器不一样
// （macOS 有 videotoolbox 没 nvenc，Windows 通常是 nvenc/qsv 没 videotoolbox），
// 写死就会出现「菜单里有 NVENC，点了却报 Unknown encoder」。
// 因此跑一次 `ffmpeg -encoders`，只把真正存在的编码器返回给界面，结果按二进制路径缓存。
// ---------------------------------------------------------------------------
const ENC_MENU = [
  { id: 'libx264',            fam: 'h264', label: 'H.264 软件编码（libx264，兼容性最好）' },
  { id: 'h264_videotoolbox',  fam: 'h264', label: 'H.264 硬件 · VideoToolbox（macOS，4K 首推）' },
  { id: 'h264_nvenc',         fam: 'h264', label: 'H.264 硬件 · NVENC（NVIDIA 显卡）' },
  { id: 'h264_qsv',           fam: 'h264', label: 'H.264 硬件 · QuickSync（Intel 核显）' },
  { id: 'h264_amf',           fam: 'h264', label: 'H.264 硬件 · AMF（AMD 显卡）' },
  { id: 'libx265',            fam: 'hevc', label: 'H.265/HEVC 软件编码（libx265，省 35~40% 码率）' },
  { id: 'hevc_videotoolbox',  fam: 'hevc', label: 'H.265/HEVC 硬件 · VideoToolbox（macOS，4K 首推）' },
  { id: 'hevc_nvenc',         fam: 'hevc', label: 'H.265/HEVC 硬件 · NVENC（NVIDIA 显卡）' },
  { id: 'hevc_qsv',           fam: 'hevc', label: 'H.265/HEVC 硬件 · QuickSync（Intel 核显）' },
  { id: 'hevc_amf',           fam: 'hevc', label: 'H.265/HEVC 硬件 · AMF（AMD 显卡）' },
  { id: 'libvpx-vp9',         fam: 'vp9',  label: 'VP9（libvpx-vp9，Web 生态）' }
];
let encCache = null;    // { bin, list }
function listVideoEncoders() {
  const bin = ffBin();
  if (!fs.existsSync(bin)) return null;
  if (encCache && encCache.bin === bin) return encCache.list;
  let out = '';
  try {
    out = execFileSync(bin, ['-hide_banner', '-loglevel', 'error', '-encoders'], { encoding: 'utf8', timeout: 15000 });
  } catch (e) {
    out = (e && e.stdout ? String(e.stdout) : '') + (e && e.stderr ? String(e.stderr) : '');
  }
  const have = new Set();
  out.split(/\r?\n/).forEach((l) => {
    // 形如： V....D libx264   libx264 H.264 / AVC ...
    const m = l.match(/^\s*V\.{0,5}\S*\s+(\S+)\s/);
    if (m) have.add(m[1]);
  });
  const list = ENC_MENU.filter((e) => have.has(e.id)).map((e) => ({
    id: e.id, fam: e.fam, label: e.label, hw: isHwEncoder(e.id)
  }));
  // 兜底：探测失败（比如 stdout 格式异常）时至少给软件编码，别把菜单弄空
  if (!list.length) {
    list.push({ id: 'libx264', fam: 'h264', label: ENC_MENU[0].label, hw: false },
              { id: 'libx265', fam: 'hevc', label: 'H.265/HEVC（libx265）', hw: false });
  }
  encCache = { bin, list };
  return list;
}
ipcMain.handle('ff:listEncoders', () => {
  const list = listVideoEncoders();
  return list ? { ok: true, list } : { ok: false, error: '未找到内置 ffmpeg' };
});
ipcMain.handle('ff:devices', () => {
  // 枚举采集设备：macOS avfoundation / Windows dshow
  const bin = ffBin();
  if (!fs.existsSync(bin)) return { ok: false, error: '未找到内置 ffmpeg' };
  return new Promise((resolve) => {
    let out = '';
    const args = process.platform === 'darwin'
      ? ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']
      : ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
    const p = spawn(bin, args, { windowsHide: true });
    p.stderr.on('data', (d) => { out += String(d); });
    p.on('close', () => {
      const devs = [];
      let cur = 'video';
      out.split(/\r?\n/).forEach((l) => {
        if (/AVFoundation video devices|DirectShow video devices/i.test(l)) cur = 'video';
        else if (/AVFoundation audio devices|DirectShow audio devices/i.test(l)) cur = 'audio';
        const m = l.match(/\[(\d+)\]\s+(.+?)(\s*\[[^\]]*\])?$/);
        if (m && /\[\d+\]/.test(l) && !/devices/i.test(m[2])) {
          devs.push({ type: cur, index: Number(m[1]), name: m[2].trim().replace(/^"|"$/g, '') });
        }
      });
      resolve({ ok: true, devices: devs });
    });
    setTimeout(() => { try { p.kill(); } catch (e) { /* */ } resolve({ ok: true, devices: [] }); }, 8000);
  });
});

// 流媒体地址探测：
//   只传地址           → 读流头解析分辨率 / 帧率 / 编解码（阿里云实时质量接口不返回分辨率，用它补充）
//   传 {url, seconds}  → 追加 `-t <sec> -c copy -f null -` 真实采样，从结尾统计行
//                        video:NNkB / audio:NNkB 换算码率（×8/秒数），这是 ffmpeg 实测的权威值，
//                        不依赖播放器统计、也不需要播放域名对应的云端接口（外部地址流只此一途）
ipcMain.handle('ff:probe', (_e, arg) => new Promise((resolve) => {
  const opt = (arg && typeof arg === 'object') ? arg : { url: arg };
  const url = String(opt.url || '');
  const sec = Math.max(0, Math.min(30, Math.floor(Number(opt.seconds) || 0)));
  const bin = ffBin();
  if (!fs.existsSync(bin)) return resolve({ ok: false, error: '未找到内置 ffmpeg' });
  // v1.1.30：放行本地文件路径（素材横竖屏联动需要探测本地视频分辨率）
  const isUrl = /^(https?|rtmp|artc|srt):\/\//i.test(url);
  if (!isUrl && !fs.existsSync(url)) return resolve({ ok: false, error: '地址不合法或文件不存在' });
  const args = ['-hide_banner'];
  if (sec <= 0) args.push('-nostats');   // 只读流头时抑制统计噪声；采样时保留，以便校核 bitrate 行
  args.push('-i', url);
  if (sec > 0) args.push('-t', String(sec), '-c', 'copy', '-f', 'null', '-');
  let out = '';
  let p;
  try { p = spawn(bin, args, { windowsHide: true }); }
  catch (err) { return resolve({ ok: false, error: err.message }); }
  // 采样模式要给足读流+采样时间，否则拿不到结尾统计行（拿不到就无法算码率）
  const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* */ } }, sec > 0 ? (sec + 8) * 1000 : 9000);
  p.stderr.on('data', (d) => { out += String(d); });
  p.on('close', () => {
    clearTimeout(to);
    const lines = out.split(/\r?\n/);
    const vl = lines.find((l) => /: Video:/.test(l)) || '';
    const al = lines.find((l) => /: Audio:/.test(l)) || '';
    const m = vl.match(/(\d{2,5})x(\d{2,5})/);
    const res = {
      width: m ? +m[1] : 0,
      height: m ? +m[2] : 0,
      codec: (vl.split('Video:')[1] || '').split(/[,(]/)[0].trim(),
      audio: (al.split('Audio:')[1] || '').split(/[,(]/)[0].trim(),
    };
    const fm = vl.match(/([\d.]+)\s*fps/);
    if (fm) res.fps = +fm[1];
    if (sec > 0) {
      const vkb = (out.match(/video:\s*(\d+)\s*kB/i) || [])[1];
      const akb = (out.match(/audio:\s*(\d+)\s*kB/i) || [])[1];
      // 实际经过时间（统计行 time=HH:MM:SS.xx）比请求的秒数更准：读流/起播耗时会让实际值略小于请求值。
      // 注意 `-f null` 下 ffmpeg 的 bitrate 恒为 N/A（输出大小未知），故只能用字节数换算。
      let el = 0;
      const tm = [...out.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
      if (tm) el = (+tm[1]) * 3600 + (+tm[2]) * 60 + parseFloat(tm[3]);
      const div = el > 0.5 ? el : sec;
      res.videoKbps = vkb ? Math.round(+vkb * 8 / div) : 0;
      res.audioKbps = akb ? Math.round(+akb * 8 / div) : 0;
      res.kbps = res.videoKbps + res.audioKbps;
      res.seconds = sec;
      res.elapsedSec = +div.toFixed(2);
    }
    res.ok = !!m || (sec > 0 && res.kbps > 0);
    if (res.ok) return resolve(res);
    resolve({ ok: false, error: '未解析到视频流信息', tail: lines.filter(Boolean).slice(-3).join(' | ') });
  });
  p.on('error', (err) => { clearTimeout(to); resolve({ ok: false, error: err.message }); });
}));

// 音频电平实测（独立于 ff:probe，避免影响既有断言与调用方）
// 为什么需要它：直播流在 Electron 里走 MSE（mpegts.js / hls.js），而 MSE 源无法向 Web Audio
// 提供音频（MediaElementSource 与 captureStream 实测均恒 0，原生 MP4 路径则正常）——也就是说
// 实时频谱对直播流拿不到数据。改用 ffmpeg 真解码 1.5 秒音频，用 astats 取 RMS / Peak 电平，
// 这是直播场景下唯一可靠的音频实测来源。调用方需自行限流（每路流不要频繁拉起）。
ipcMain.handle('ff:audioLevel', (_e, arg) => new Promise((resolve) => {
  const opt = (arg && typeof arg === 'object') ? arg : { url: arg };
  const sec = Math.max(1, Math.min(6, Math.floor(Number(opt.seconds) || 2)));
  const bin = ffBin();
  if (!fs.existsSync(bin)) return resolve({ ok: false, error: '未找到内置 ffmpeg' });
  // v1.1.47：三类来源（与界面「声音来源」一一对应）：
  //   { url }                        网络音频流 / 远端文件
  //   { path }                       本地素材（探其音轨电平）
  //   { deviceIndex, deviceName }    本机音频采集设备（外接声卡 / 麦克风 / 采集卡音频）
  const url = String(opt.url || '');
  const path = String(opt.path || '');
  let inputArgs = null;
  if (url) {
    if (!/^(https?|rtmp|artc|srt):\/\//i.test(url)) return resolve({ ok: false, error: '地址不合法' });
    inputArgs = ['-i', url];
  } else if (path) {
    if (!fs.existsSync(path)) return resolve({ ok: false, error: '本地文件不存在' });
    inputArgs = ['-i', path];
  } else if (opt.deviceIndex != null || opt.deviceName) {
    if (process.platform === 'darwin') {
      inputArgs = ['-f', 'avfoundation', '-i', ':' + (opt.deviceIndex != null ? opt.deviceIndex : '0')];
    } else {
      inputArgs = ['-f', 'dshow', '-i', 'audio=' + (opt.deviceName || opt.deviceIndex)];
    }
  } else {
    return resolve({ ok: false, error: '未指定音频来源（url / path / 设备）' });
  }
  // -vn 只留音频；astats 在结束帧打印 RMS level dB / Peak level dB
  const args = ['-hide_banner', '-nostats'].concat(inputArgs, ['-t', String(sec), '-vn',
    '-af', 'astats=metadata=0:reset=0', '-f', 'null', '-']);
  let out = '';
  let p;
  try { p = spawn(bin, args, { windowsHide: true }); }
  catch (err) { return resolve({ ok: false, error: err.message }); }
  const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* */ } }, (sec + 10) * 1000);
  p.stderr.on('data', (d) => { out += String(d); });
  p.on('close', () => {
    clearTimeout(to);
    const hasAudio = /Stream #[\d:.]+.*: Audio:/i.test(out);
    if (!hasAudio) return resolve({ ok: true, hasAudio: false, rmsDb: null, peakDb: null });
    const rms = (out.match(/RMS level dB:\s*(-?[\d.]+)/i) || [])[1];
    const peak = (out.match(/Peak level dB:\s*(-?[\d.]+)/i) || [])[1];
    // 静音流（-inf / -91 以下）视为无有效电平
    const num = (x) => (x === undefined || x === null || x === '-inf') ? null : parseFloat(x);
    const r = num(rms), pk = num(peak);
    resolve({
      ok: true, hasAudio: true,
      rmsDb: (r === null || r < -90) ? null : r,
      peakDb: (pk === null || pk < -90) ? null : pk,
      seconds: sec
    });
  });
  p.on('error', (err) => { clearTimeout(to); resolve({ ok: false, error: err.message }); });
}));

// 推流前自检：①ffmpeg 可用 ②媒体源试采（设备试开 2 秒 / 文件可读）③RTMP 服务器 TCP 连通性。
// 每步给真实报错，不再「启动后静默失败」
ipcMain.handle('ff:selfcheck', async (_e, args) => {
  const bin = ffBin();
  if (!fs.existsSync(bin)) return { ok: false, error: '未找到内置 ffmpeg（bin/ 目录缺失）' };
  const res = { ok: true, ffmpeg: true, media: null, rtmp: [] };
  const src = (args && args.source) || {};
  // ② 媒体源试采 2 秒（-f null 不落盘）
  let testArgs = null;
  if (src.type === 'file') {
    testArgs = ['-hide_banner', '-i', String(src.path || ''), '-t', '2', '-f', 'null', '-'];
  } else if (src.type === 'device') {
    testArgs = [];
    if (src.capFps) testArgs.push('-framerate', String(src.capFps));
    if (src.capSize && /^\d{2,5}x\d{2,5}$/.test(src.capSize)) testArgs.push('-video_size', src.capSize);
    if (process.platform === 'darwin') {
      const au = (src.deviceAudio !== undefined && src.deviceAudio !== '') ? (':' + src.deviceAudio) : '';
      testArgs.push('-f', 'avfoundation', '-i', (src.deviceVideo || '0') + au);
    } else {
      let dshow = 'video=' + (src.deviceVideoName || src.deviceVideo || '');
      if (src.deviceAudio !== undefined && src.deviceAudio !== '') dshow += ':audio=' + (src.deviceAudioName || src.deviceAudio);
      testArgs.push('-f', 'dshow', '-i', dshow);
    }
    testArgs.push('-t', '2', '-f', 'null', '-');
  }
  if (testArgs) {
    res.media = await new Promise((resolve) => {
      let out = '';
      let p;
      try { p = spawn(bin, testArgs, { windowsHide: true }); }
      catch (err) { return resolve({ ok: false, tail: err.message, modes: [] }); }
      const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* */ } }, 20000);
      p.stderr.on('data', (d) => { out += String(d); });
      p.on('close', (code) => {
        clearTimeout(to);
        // 试采成功：code=0 或已输出流信息；macOS 权限被拒/设备占用时 code!=0 且日志可判别
        const ok = code === 0 || /Stream #/.test(out);
        const tail = out.split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
        resolve({ ok, code, tail, modes: parseDevModes(out) });
      });
      p.on('error', (err) => { clearTimeout(to); resolve({ ok: false, tail: err.message, modes: [] }); });
    });
  }
  // ③ RTMP 连通性：真实试推 1 秒（ lavfi 测试画面 → 目标地址）。
// TCP 端口通 ≠ RTMP 可用：握手/鉴权/流占用都要真实推流才能暴露（实测偶发握手 Input/output error
// 只有真实推流才复现）。结果区分：ok / 已被占用（说明地址有效且正在推流）/ 失败（附日志尾部）
  const net = require('net');
  const urls = (args && args.rtmp) || [];
  for (const u of urls) {
    const item = { url: String(u), host: '?', ok: false, busy: false, via: 'push', tail: '' };
    try {
      const hu = new URL(item.url);
      item.host = hu.hostname + ':' + (Number(hu.port) || 1935);
      item.via = 'push';
      item.ok = await new Promise((rv) => {
        let out = '';
        let p;
        try { p = spawn(bin, ['-hide_banner', '-loglevel', 'info', '-re', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '300k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-f', 'flv', item.url], { windowsHide: true }); }
        catch (err) { return rv(false); }
        const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* */ } rv(false); }, 15000);
        p.stderr.on('data', (d) => { out += String(d); });
        p.on('close', (code) => {
          clearTimeout(to);
          item.tail = out.split(/\r?\n/).filter(Boolean).slice(-3).join('\n').slice(0, 400);
          if (code === 0) return rv(true);
          if (/already publish|already exist|published/i.test(out)) { item.busy = true; return rv(true); }
          rv(false);
        });
        p.on('error', () => { clearTimeout(to); rv(false); });
      });
    } catch (e) { item.host = '解析失败'; item.via = 'push'; }
    res.rtmp.push(item);
  }
  return res;
});

// ---------------------------------------------------------------------------
// 预览播放子窗口
// ---------------------------------------------------------------------------
// ffmpeg 本地中继：主进程起 HTTP 服务，ffmpeg 拉远端流 -c copy 转 POST 进来，
// 播放窗口以 http://127.0.0.1 访问（同源、无 CORS），彻底绕开 file:// 跨域限制
let relaySrv = null;
let relayPort = 0;
let relayClients = [];
// ---------------------------------------------------------------------------
// r69：解码器配置缓存 —— 修复「RTMP 地址播放出错」的根因
//
// 原时序：ff:relay 先起 ffmpeg 推流 → 立刻把 http://127.0.0.1:PORT/live.flv 返回给渲染进程 →
//         渲染进程再建 mpegts.js 播放器发起 GET。实测这两步之间 ffmpeg 已推掉约 25KB，
//         **FLV 文件头 + metadata + AVC/AAC 序列头 + 首个关键帧全在里面，被丢弃**
//         （relayClients 为空时无人接收）。播放器后连上拿到的是没有 FLV 头的半截流，
//         mpegts.js 无法解析 → 必然报错。RTMP 源尤其明显：拉流握手后 ffmpeg 立刻吐头。
// 修复：把「首个关键帧之前的所有数据」即纯配置段缓存下来，任何客户端连入时先补发这段，
//       再转发实时数据 —— 播放器无论何时连入都能初始化解码器，随后等下一个自然关键帧出画面。
//       只补配置不补画面数据，时间戳保持连续，不会出现跳变导致的花屏/卡顿。
// ---------------------------------------------------------------------------
let relayCfg = Buffer.alloc(0);    // 配置段缓存（FLV header + metadata + AVC/AAC 序列头）
let relayCfgReady = false;
let relayBuf = Buffer.alloc(0);    // 未解析完的尾部字节
function relayResetCfg() {
  relayCfg = Buffer.alloc(0);
  relayCfgReady = false;
  relayBuf = Buffer.alloc(0);
}
// 流式解析 FLV：定位「第一个视频关键帧 tag」的起始偏移，其之前的全部内容即为配置段
function relayIngest(chunk) {
  relayBuf = relayCfgReady ? Buffer.alloc(0) : Buffer.concat([relayBuf, chunk]);
  if (relayCfgReady || relayBuf.length < 13) return;
  // 必须是合法 FLV 头；否则放弃缓存（按原样透传，交给播放器报错）
  if (!(relayBuf[0] === 0x46 && relayBuf[1] === 0x4c && relayBuf[2] === 0x56)) { relayCfgReady = true; return; }
  let off = 13;   // 'FLV'(3) + version(1) + flags(1) + headerSize(4) + PreviousTagSize0(4)
  while (off + 11 <= relayBuf.length) {
    const type = relayBuf[off];
    const dataSize = (relayBuf[off + 1] << 16) | (relayBuf[off + 2] << 8) | relayBuf[off + 3];
    const total = 11 + dataSize + 4;                 // tag header + data + PreviousTagSize
    if (off + total > relayBuf.length) return;       // 该 tag 还没收全，等下一批
    // 视频 tag 且为关键帧（data[0] 高 4 位 = 1）：它之前的都是解码器配置
    if (type === 9 && dataSize > 1 && (relayBuf[off + 11] >> 4) === 1) {
      relayCfg = relayBuf.slice(0, off);
      relayCfgReady = true;
      relayBuf = Buffer.alloc(0);
      return;
    }
    off += total;
  }
  // 防止无限累积（例如纯音频流永远等不到视频关键帧）
  if (relayBuf.length > 2 * 1024 * 1024) { relayCfg = relayBuf.slice(0, Math.min(relayBuf.length, 65536)); relayCfgReady = true; relayBuf = Buffer.alloc(0); }
}
function startRelayServer() {
  return new Promise((resolve, reject) => {
    relaySrv = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200); res.end('ok');
        req.on('data', (chunk) => {
          relayIngest(chunk);
          relayClients = relayClients.filter((c) => !c.destroyed);
          relayClients.forEach((c) => c.write(chunk));
        });
      } else if (req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'video/x-flv',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          'Connection': 'close'
        });
        // ★ 新客户端先补发配置段，否则它拿不到 FLV 头/序列头，解码器无法初始化
        if (relayCfgReady && relayCfg.length) { try { res.write(relayCfg); } catch (e) { /* 已断开 */ } }
        relayClients.push(res);
        req.on('close', () => { relayClients = relayClients.filter((c) => c !== res); });
      } else { res.writeHead(405); res.end(); }
    });
    relaySrv.on('error', reject);
    relaySrv.listen(0, '127.0.0.1', () => resolve(relaySrv.address().port));
  });
}
ipcMain.handle('ff:relay', async (_e, url) => {
  if (!fs.existsSync(ffBin())) return { ok: false, error: '未找到内置 ffmpeg' };
  try {
    if (!relaySrv) relayPort = await startRelayServer();
    // 停掉上一个中继任务
    ffProcs.forEach((rec, id) => { if (rec.kind === 'relay' && !rec.exited) ffStop(id, 'SIGKILL'); });
    relayClients.forEach((c) => { try { c.end(); } catch (e) { /* */ } });
    relayClients = [];
    relayResetCfg();
    const r = ffSpawn(
      // r69：RTMP/FLV 拉流加 -rw_timeout（微秒）避免网络异常时 ffmpeg 永久卡住；
      // -re 关闭（中继转推要保持实时性），-flvflags no_duration_filesize 让 FLV 头可被增量消费。
      ['-hide_banner', '-loglevel', 'warning', '-rw_timeout', '10000000',
        '-i', url, '-c', 'copy', '-f', 'flv', '-flvflags', 'no_duration_filesize',
        'http://127.0.0.1:' + relayPort + '/publish'],
      'relay', url
    );
    if (!r.ok) return r;
    // r69：等流真正就绪（配置段已缓存）或 ffmpeg 早退，再告诉播放器可以连了。
    // 旧逻辑启动即返回，播放器连上时要么数据已被丢（无 FLV 头）要么源根本不通却干等到看门狗超时。
    const rec = ffProcs.get(r.id);
    const ready = await new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (relayCfgReady) { clearInterval(timer); resolve('ready'); return; }
        if (rec && rec.exited) { clearInterval(timer); resolve('exit'); return; }
        if (Date.now() - t0 > 12000) { clearInterval(timer); resolve('timeout'); return; }
      }, 100);
    });
    if (ready === 'exit') {
      const tail = (rec && rec.logTail ? rec.logTail.join('\n') : '') || '';
      ffLogLine(r.id, '[错误] 中继源流连接失败，ffmpeg 已退出');
      return { ok: false, error: '无法拉取该地址（ffmpeg 启动后即退出）：' + (tail.trim().split('\n').slice(-3).join(' / ') || '地址不可达 / 流不存在 / 协议不支持') };
    }
    if (ready === 'timeout') {
      // 超时说明源大概率拉不通，别把 ffmpeg 悬着白占资源（旧逻辑正是因此挂在后台）
      try { ffStop(r.id, 'SIGKILL'); } catch (e) { /* 已退出 */ }
      return { ok: false, error: '连接该地址超时（12 秒未收到流数据）：地址可能不可达、需要鉴权，或该流当前没有在推。请确认地址正确且流已开播' };
    }
    return { ok: true, url: 'http://127.0.0.1:' + relayPort + '/live.flv' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('ff:relayStop', () => {
  ffProcs.forEach((rec, id) => { if (rec.kind === 'relay' && !rec.exited) ffStop(id, 'SIGKILL'); });
  relayClients.forEach((c) => { try { c.end(); } catch (e) { /* */ } });
  relayClients = [];
  relayResetCfg();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// r69：外部原生播放器兜底（VLC）
// 浏览器内核没有 RTMP 协议栈，内置中继虽已修好时序，但遇到
//   · 非常规编码（H.265 over RTMP）
//   · CDN 侧异常 / 服务端不配合的 FLV
//   · 用户就想用熟悉的专业播放器
// 时，最稳的仍是交给 VLC 这类原生播放器。这里探测本机已装的播放器并直接拉起。
// ---------------------------------------------------------------------------
const PLAYER_CANDIDATES = [
  { name: 'VLC', darwin: ['/Applications/VLC.app/Contents/MacOS/VLC', '~/Applications/VLC.app/Contents/MacOS/VLC'],
    win32: ['C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', 'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'],
    linux: ['/usr/bin/vlc', '/usr/local/bin/vlc', '/snap/bin/vlc'] },
  { name: 'IINA', darwin: ['/Applications/IINA.app/Contents/MacOS/IINA', '~/Applications/IINA.app/Contents/MacOS/IINA'], win32: [], linux: [] },
  { name: 'PotPlayer', darwin: '',
    win32: ['C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
            'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini.exe'], linux: [] },
  // macOS 上 mpv 可能装在任何前缀（brew Intel 在 /usr/local），多列几个常见位置
  { name: 'mpv', darwin: ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv', '/opt/local/bin/mpv'],
    win32: [], linux: ['/usr/bin/mpv', '/usr/local/bin/mpv'] }
];
function detectPlayers() {
  const out = [];
  PLAYER_CANDIDATES.forEach((p) => {
    let raw = [];
    if (process.platform === 'darwin') raw = p.darwin;
    else if (process.platform === 'win32') raw = p.win32;
    else raw = p.linux;
    // 各平台候选路径可能是字符串也可能是数组，统一成数组；支持 ~ 展开（用户自己装的 App）
    const paths = (Array.isArray(raw) ? raw : [raw]).filter(Boolean)
      .map((fp) => (String(fp).indexOf('~/') === 0 ? path.join(os.homedir(), String(fp).slice(2)) : String(fp)));
    paths.forEach((fp) => { if (fs.existsSync(fp)) out.push({ name: p.name, path: fp }); });
  });
  return out;
}
ipcMain.handle('ff:listPlayers', () => ({ ok: true, list: detectPlayers() }));
ipcMain.handle('ff:openInPlayer', async (_e, url, playerPath) => {
  if (!/^(https?|rtmp|rtsp|srt|udp|rtp):\/\//i.test(url || '')) {
    return { ok: false, error: '地址需为 http(s)/rtmp/rtsp/srt 链接' };
  }
  const list = detectPlayers();
  if (!list.length) {
    return { ok: false, error: '未检测到本机播放器（VLC / IINA / PotPlayer / mpv）。安装 VLC 后可用原生播放器拉 RTMP，这是 RTMP 最可靠的播放方式', needInstall: true };
  }
  const p = (playerPath && list.filter((x) => x.path === playerPath)[0]) || list[0];
  try {
    if (process.platform === 'darwin') {
      // macOS：直接用可执行文件路径拉起，可带 URL 参数
      spawn(p.path, [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      spawn(p.path, [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn(p.path, [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, player: p.name };
  } catch (err) {
    return { ok: false, error: '拉起 ' + p.name + ' 失败：' + err.message };
  }
});

let previewWindow = null;
function openPreview(playUrl, title, urls, meta) {
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.close();
    previewWindow = null;
  }
  previewWindow = new BrowserWindow({
    width: 900,
    height: 640,
    title: '播放预览 - ' + (title || playUrl),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      // 关键：预览页为本地 file:// 页面，mpegts.js / hls.js 需直接 XHR 拉取 CDN 流媒体，
      // 必须关闭同源策略，否则请求被 CORS 拦截导致"永远加载中/网络错误"
      webSecurity: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false
    }
  });
  // 本地播放器页（mpegts.js / hls.js 已打包进 vendor，离线可用，不依赖 CDN）
  const query = { url: playUrl, title: title || '' };
  // 候选地址列表（多域名 × 多协议）：预览页逐个探测，第一个可达的自动播放
  if (Array.isArray(urls) && urls.length > 1) query.urls = JSON.stringify(urls);
  // 域名识别信息（推流域名 → 播放域名），预览窗口顶栏显示并可手动切换播放域名
  if (meta && typeof meta === 'object') query.meta = JSON.stringify(meta);
  previewWindow.loadFile(path.join(__dirname, 'renderer', 'preview.html'), { query });
  previewWindow.on('closed', () => { previewWindow = null; });
}
ipcMain.handle('app:openPreview', (_e, url, title, meta) => {
  // 放行 http(s)（网页直连/中继）与 rtmp（预览页自动走 ffmpeg 中继）；支持候选地址数组
  const isValid = (u) => /^(https?|rtmp):\/\//i.test(u || '');
  let list;
  if (Array.isArray(url)) {
    list = url.filter(isValid);
    if (!list.length) return Promise.resolve({ ok: false, error: '没有有效的播放地址（需 http/https/rtmp 链接）' });
  } else {
    if (!isValid(url)) return Promise.resolve({ ok: false, error: '播放地址必须是 http(s) 或 rtmp 链接' });
    list = [url];
  }
  openPreview(list[0], title, list, meta);
  return Promise.resolve({ ok: true });
});

// ---------------------------------------------------------------------------
// v1.1.48：本机 PGM 输出（把 PGM 画面送到指定显示器 = HDMI 外接屏 / 采集卡）
//
// 难点：主窗的 PGM 是主窗里的一个 <video>/<img> 元素，跨窗口传不了元素句柄；
// captureStream() 传流也会被 Chromium 的跨窗口限制卡住。所以这里不传画面，
// 只传「源配置」——由输出窗拿同一份 source 自己起播。
//
// 关于采集卡：绝大多数采集卡（Elgato Cam Link / 圆刚 GC 系列等）的 HDMI IN
// 会被系统枚举成一块显示器，因此「选它」就等于把 PGM 送进采集卡，无需额外代码。
// 只有输入侧的纯 USB 采集棒不具备输出能力，列表里自然看不到。
// ---------------------------------------------------------------------------
let outWindow = null;
let outState = { open: false, displayId: null, fit: 'contain', info: false, source: null };

function outDisplays() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: (d.label || ('显示器 ' + (i + 1))) + ' · ' + d.bounds.width + '×' + d.bounds.height
      + (d.id === primary.id ? '（主显示器）' : ''),
    primary: d.id === primary.id,
    bounds: d.bounds
  }));
}
function outFindDisplay(id) {
  const all = screen.getAllDisplays();
  return all.filter((d) => String(d.id) === String(id))[0] || screen.getPrimaryDisplay();
}
function outApplyBounds(d) {
  if (!outWindow || outWindow.isDestroyed()) return;
  const b = d.bounds;
  outWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
}
function outBroadcast(kind, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send(kind, payload); } catch (e) { /* 主窗已关 */ }
  }
}
function outCreateWindow(displayId) {
  const d = outFindDisplay(displayId);
  outWindow = new BrowserWindow({
    width: d.bounds.width, height: d.bounds.height,
    x: d.bounds.x, y: d.bounds.y,
    frame: false,             // 无边框：送屏时不能出现标题栏
    focusable: false,         // 点了输出，输入焦点还在主窗，操作不被打断
    fullscreenable: false,
    skipTaskbar: true,        // 送采集卡时不多一块任务栏图标
    backgroundColor: '#000000',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      // output.html 为本地 file:// 页面，素材 file:// 与 mpegts/hls 拉流需绕过同源策略
      webSecurity: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false
    }
  });
  outWindow.loadFile(path.join(__dirname, 'renderer', 'output.html'));
  // 立即铺一次：窗口创建时已按 bounds 定位，但部分平台（macOS 刘海屏 / 缩放屏）会在
  // 显示后再修正一次可用区，这里 + ready-to-show 双保险，避免出现留白边。
  outApplyBounds(outFindDisplay(outState.displayId));
  outWindow.once('ready-to-show', () => {
    if (!outWindow || outWindow.isDestroyed()) return;
    // showInactive：不抢焦点（配合 focusable:false）
    try { outWindow.showInactive(); } catch (e) { outWindow.show(); }
    outApplyBounds(outFindDisplay(outState.displayId));
  });
  outWindow.on('closed', () => {
    outWindow = null;
    outState.open = false;
    outBroadcast('out:state', outState);
  });
}
ipcMain.handle('out:displays', () => ({ ok: true, displays: outDisplays() }));
ipcMain.handle('out:state', () => ({ ok: true, state: outState }));
ipcMain.handle('out:get', () => ({
  ok: true,
  open: !!outState.open,
  displayId: outState.displayId,
  source: outState.source,
  cfg: { fit: outState.fit, info: outState.info }
}));
ipcMain.handle('out:open', (_e, displayId) => {
  const list = outDisplays();
  if (!list.length) return { ok: false, error: '未检测到显示器' };
  const target = (displayId != null && displayId !== '' && displayId !== 'undefined')
    ? displayId : list[0].id;
  outState.displayId = target;
  if (!outWindow || outWindow.isDestroyed()) outCreateWindow(target);
  else outApplyBounds(outFindDisplay(target));
  outState.open = true;
  // 开窗后立刻下发一次，避免输出窗 ready 晚于这次 open 导致白屏
  if (outWindow && !outWindow.isDestroyed()) {
    outWindow.webContents.send('out:cfg', { fit: outState.fit, info: outState.info });
    if (outState.source) outWindow.webContents.send('out:source', outState.source);
  }
  outBroadcast('out:state', outState);
  return { ok: true, state: outState };
});
ipcMain.handle('out:close', () => {
  if (outWindow && !outWindow.isDestroyed()) outWindow.close();
  outWindow = null;
  outState.open = false;
  outBroadcast('out:state', outState);
  return { ok: true, state: outState };
});
ipcMain.handle('out:source', (_e, src) => {
  outState.source = src || null;
  if (outWindow && !outWindow.isDestroyed()) outWindow.webContents.send('out:source', outState.source);
  return { ok: true };
});
ipcMain.handle('out:style', (_e, o) => {
  const c = (o && typeof o === 'object') ? o : {};
  if (c.fit) outState.fit = c.fit;
  if (c.info !== undefined) outState.info = !!c.info;
  if (outWindow && !outWindow.isDestroyed()) {
    outWindow.webContents.send('out:cfg', { fit: outState.fit, info: outState.info });
  }
  return { ok: true, state: outState };
});
// 热插拔：目标屏被拔掉 → 窗口自动移到主显示器并回传 out:moved，界面同步提示
screen.on('display-removed', (_e, d) => {
  if (!outWindow || outWindow.isDestroyed()) return;
  if (!d || String(d.id) !== String(outState.displayId)) return;
  const primary = screen.getPrimaryDisplay();
  outState.displayId = primary.id;
  outApplyBounds(primary);
  outBroadcast('out:moved', { displayId: primary.id, label: primary.label || '主显示器' });
  outBroadcast('out:state', outState);
});
screen.on('display-metrics-changed', (_e, d, changes) => {
  if (!outWindow || outWindow.isDestroyed()) return;
  if (!d || String(d.id) !== String(outState.displayId)) return;
  // 分辨率 / 位置变化（含旋转）时重新铺满，否则会留黑边或溢出
  if (changes && (changes.includes && (changes.includes('bounds') || changes.includes('workArea')))) {
    outApplyBounds(outFindDisplay(outState.displayId));
  } else {
    outApplyBounds(outFindDisplay(outState.displayId));
  }
});

// ---------------------------------------------------------------------------
// libobs 真引擎（可选，v1.1.38）
// 原生桥接（native/obs-bridge）在 CI 编译、打包进 resources/obs-bridge 后可用；
// 本地/未打包环境为 null → 全链路自动回退 ffmpeg 引擎，UI 与推流行为不变。
// ---------------------------------------------------------------------------
let obsEngine = null;
function getObsEngine() {
  if (obsEngine === null) {
    try { obsEngine = createLibobsEngine(); } catch (e) { obsEngine = undefined; }
    if (!obsEngine) obsEngine = undefined;
  }
  return obsEngine || null;
}
// 把完整 RTMP 地址拆成 libobs rtmp_common 需要的 server + key（末段路径为 stream key）
function splitRtmp(url) {
  const m = String(url || '').match(/^(rtmps?:\/\/[^/]+(?:\/[^/]+)*)\/([^/]+)$/);
  if (m) return { server: m[1], key: m[2] };
  return { server: String(url || ''), key: '' };
}
ipcMain.handle('obs:status', () => {
  const eng = getObsEngine();
  return {
    ok: true,
    available: !!eng,
    engine: eng ? 'libobs' : 'ffmpeg',
    version: eng ? (eng.meta.version || '') : '',
    nativePath: eng ? (eng.meta.nativePath || '') : ''
  };
});
ipcMain.handle('obs:devices', (_e, category) => {
  const eng = getObsEngine();
  if (!eng) return { ok: false, list: [], error: 'libobs 引擎不可用' };
  try { return { ok: true, list: eng.enumDevices(category) || [] }; }
  catch (e) { return { ok: false, list: [], error: e.message }; }
});
ipcMain.handle('obs:pushScene', (_e, scene, config) => {
  const eng = getObsEngine();
  if (!eng) return { ok: false, error: 'libobs 引擎不可用（原生桥接未编译/未打包）' };
  try { return eng.pushScene(scene, config); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('obs:startStream', (_e, url, key, o) => {
  const eng = getObsEngine();
  if (!eng) return { ok: false, error: 'libobs 引擎不可用' };
  try { return { ok: eng.startStream(url, key, o) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('obs:stopStream', () => { const eng = getObsEngine(); if (eng) eng.stopStream(); return { ok: true }; });

// ---- v1.1.40：音频控制 / 滤镜 / 过渡 / 预览 回读 IPC ----
ipcMain.handle('obs:setVolume', (_e, scene, name, volume) => {
  const eng = getObsEngine();
  if (!eng) return { ok: false, error: 'libobs 引擎不可用' };
  try { return { ok: eng.setSourceVolume(scene, name, volume) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('obs:setMuted', (_e, scene, name, muted) => {
  const eng = getObsEngine();
  if (!eng) return { ok: false, error: 'libobs 引擎不可用' };
  try { return { ok: eng.setSourceMuted(scene, name, muted) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('obs:addFilter', (_e, scene, name, filterId, filterName, settings) => {
  const eng = getObsEngine();
  if (!eng) return { ok: false, error: 'libobs 引擎不可用' };
  try { return { ok: eng.addSourceFilter(scene, name, filterId, filterName, settings) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('obs:removeFilter', (_e, scene, name, filterName) => {
  const eng = getObsEngine();
  if (!eng) return { ok: false, error: 'libobs 引擎不可用' };
  try { return { ok: eng.removeSourceFilter(scene, name, filterName) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('obs:updateFilter', (_e, scene, name, filterName, settings) => {
  const eng = getObsEngine();
  if (!eng) return { ok: false, error: 'libobs 引擎不可用' };
  try { return { ok: eng.updateSourceFilter(scene, name, filterName, settings) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('obs:createTransition', (_e, typeId, name, durationMs) => {
  const eng = getObsEngine();
  if (!eng) return { ok: false, error: 'libobs 引擎不可用' };
  try { return { ok: eng.createTransition(typeId, name, durationMs) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('obs:triggerTransition', (_e, sceneName) => {
  const eng = getObsEngine();
  if (!eng) return { ok: false, error: 'libobs 引擎不可用' };
  try { return { ok: eng.triggerTransition(sceneName) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('obs:preview', (_e, width, height) => {
  const eng = getObsEngine();
  if (!eng) return { ok: false, reason: 'libobs 引擎不可用' };
  try {
    const r = eng.renderPreview(width, height);
    if (r && r.ok && r.data) {
      // Buffer 经 IPC 结构化克隆会变 Uint8Array，转 ArrayBuffer 传给渲染层
      const ab = r.data.buffer ? r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) : r.data;
      return { ok: true, width: r.width, height: r.height, stride: r.stride, data: ab };
    }
    return { ok: false, reason: (r && r.reason) || '回读失败' };
  } catch (e) { return { ok: false, reason: e.message }; }
});

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: '港丰影视直播工作台',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出兜底：关闭软件时强制终止全部 ffmpeg 子进程（推流/拉流/录制/探测），
// 并置 stopReq 阻止自动重连在进程树被杀后再拉起新进程。
// 没有这一步，父进程退出后 ffmpeg 会变成孤儿进程继续往云端推流（实测复现）。
app.on('before-quit', () => {
  // v1.1.38：先关 libobs 真引擎（停推流、清场景、关 GPU/音频上下文），再杀 ffmpeg 子进程
  try { if (obsEngine) obsEngine.shutdown(); } catch (e) { /* ignore */ }
  ffProcs.forEach((rec) => {
    rec.stopReq = true;
    try {
      if (process.platform === 'win32') {
        // /t 连进程树一起杀，防止 ffmpeg 再派生子进程残留
        spawn('taskkill', ['/pid', String(rec.proc.pid), '/f', '/t'], { windowsHide: true });
      } else {
        rec.proc.kill('SIGKILL');
      }
    } catch (e) { /* 进程可能已退出 */ }
  });
  ffProcs.clear();
});
