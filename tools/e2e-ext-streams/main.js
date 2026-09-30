// 外部地址流 E2E：真实渲染器（renderer/index.html）+ mock 云端 + 本地真实 HTTP-FLV 源
//
// 素材准备（首次运行前执行一次）：
//     bash tools/e2e-ext-streams/make-source.sh
// 运行：
//     cd <项目根> && env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1 \
//       ./node_modules/.bin/electron tools/e2e-ext-streams/main.js
// 注意：NODE_OPTIONS 里注入的 broker fs shim 与 ELECTRON_RUN_AS_NODE=1 都会破坏 electron 启动，必须用 env -u 摘掉。
//
// 覆盖范围（A–L 共 87 项断言）：地址校验 / 界面加入路径 / _monList 注入与四菜单联动（预览·概览·在线流·质量·带宽）
//   / 静默实测（ff:probe 采样）/ 采样累积与历史写入 / 手动关闭 / 断流自动判定 / 重连新会话 / 崩溃残留回收
//   / 历史查看与 CSV 导出 / 真实 http-flv 播放采样。
//
// 三条被测流的分工（避免真实播放与合成样本互相污染，保证断言确定性）：
//   #1 真实可播地址（本地 http-flv，限速下行）→ 菜单联动 + 真实播放采样（L 段）
//   #2 指向已关闭端口 → 保证无真实样本 → 静默实测（D）与关闭写历史（F/G）
//   #3 指向已关闭端口 → 等应用自己判定断流（H，走真实失败链路而非手工调用）
//
// 两个已知的 harness 保真度要点（否则会得到假结论）：
//   1. 必须调用 enterApp(false) 走真实登录入口：否则 bindWatchPrefs/bindExtStreams 不会执行，
//      界面按钮（加入 / 历史表格 / 历史数据弹窗）全部未绑定，测试会漏掉真实点击路径。
//   2. 本地素材必须限速下发：回环网会把 4.6MB 瞬间灌满，fetch 字节差恒为 0，
//      「FLV 下行字节数 → kbps」永远算出 0，真实播放采样断言必然失败。
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PROJ = path.resolve(__dirname, '..', '..');
const FLV = process.env.E2E_FLV || path.join(__dirname, 'src.flv');
const PORT = Number(process.env.E2E_PORT) || 18901;
const FLV_URL = 'http://127.0.0.1:' + PORT + '/live/ext.flv';
const DEAD1 = 'http://127.0.0.1:1/live/hist.flv';    // 端口 1 必然拒绝连接
const DEAD2 = 'http://127.0.0.1:1/live/down.flv';

app.setPath('userData', path.join(require('os').tmpdir(), 'e2e_ext_userdata'));   // 隔离 localStorage，保证每次从零开始

let win, srv;
const results = [];
function ck(ok, msg) { results.push({ ok: !!ok, msg }); console.log((ok ? 'PASS  ' : 'FAIL  ') + msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (js) => win.webContents.executeJavaScript(js, true);
const J = (v) => JSON.stringify(v);

function startServer() {
  return new Promise((resolve) => {
    // 限速下行：回环网会把 4.8MB 素材瞬间灌满，fetch 字节差恒为 0（码率只能算出 0）。
    // 按 ≈2080 kbps 匀速下发，模拟真实直播的连续下行，使「FLV 下行字节数 → kbps」可稳定观测。
    const PACE_BPS = 260 * 1024;
    function servePaced(req, res) {
      let fd;
      try { fd = fs.openSync(FLV, 'r'); } catch (e) { res.writeHead(500); res.end(); return; }
      const buf = Buffer.allocUnsafe(32 * 1024);
      let carry = 0, last = Date.now(), closed = false;
      req.on('close', function () { closed = true; try { fs.closeSync(fd); } catch (e) {} });
      function step() {
        if (closed) return;
        const now = Date.now();
        carry += (now - last) / 1000 * PACE_BPS; last = now;
        if (carry < 2048) { setTimeout(step, 25); return; }
        let n = 0;
        try { n = fs.readSync(fd, buf, 0, Math.min(Math.floor(carry), buf.length), null); } catch (e) { n = 0; }
        if (!n) { try { fs.closeSync(fd); } catch (e) {} res.end(); return; }   // 素材发完 → 直播结束
        carry -= n;
        if (!res.write(Buffer.from(buf.subarray(0, n)))) { res.once('drain', step); return; }
        setTimeout(step, 25);
      }
      step();
    }
    srv = http.createServer((req, res) => {
      // 只提供 /live/ext.flv：其他路径一律 404，避免腾讯云卡片的候选地址意外播到同一个文件
      if (req.url.split('?')[0] !== '/live/ext.flv') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': 'video/x-flv', 'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store', 'Connection': 'close'
      });
      servePaced(req, res);
    });
    srv.listen(PORT, '127.0.0.1', resolve);
  });
}

app.whenReady().then(async () => {
  if (!fs.existsSync(FLV)) {
    console.log('缺少测试素材：' + FLV);
    console.log('请先执行：bash tools/e2e-ext-streams/make-source.sh');
    app.exit(3); return;
  }
  try { fs.rmSync(path.join(require('os').tmpdir(), 'e2e_ext_userdata'), { recursive: true, force: true }); } catch (e) {}
  await startServer();
  win = new BrowserWindow({
    show: false, width: 1500, height: 950,
    webPreferences: { contextIsolation: false, sandbox: false, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') }
  });
  await win.loadFile(path.join(PROJ, 'renderer', 'index.html'));
  await sleep(1200);

  await ev(`state.cfg.secretId='e2e'; state.cfg.secretKey='e2e';
    state.cfg.aliId='LTAI_E2E'; state.cfg.aliKey='e2e'; state.cfg.playDomain='127.0.0.1:${PORT}';
    state.cfg.monProto='flv'; state.cfg.monHttps=false; state.cfg.monAlarm=false;
    state.connected=true; window._alDomains=[]; 'ok'`);
  // 走真实登录入口：enterApp → bindWatchPrefs → bindExtStreams 才会挂上界面事件。
  // （跳过这一步会让「加入」按钮、历史表格按钮、历史数据弹窗按钮全部未绑定，
  //   测试就只覆盖了函数调用而漏掉真实用户点击路径。）
  await ev(`enterApp(false); 'ok'`);
  await sleep(400);
  ck(await ev(`document.getElementById('app').classList.contains('show')`), '进入主界面（真实入口 enterApp 已执行）');

  // ---------- A 地址校验 ----------
  console.log('\n--- A 地址校验 ---');
  const av = JSON.parse(await ev(`JSON.stringify([
    extUrlOk('rtmp://push.test/live/a'),
    extUrlOk('http://cdn.test/a.ts'),
    extUrlOk('http://cdn.test/live/a.flv'),
    extUrlOk('https://cdn.test/live/a.m3u8?auth=1'),
    extUrlOk('')
  ])`));
  ck(av[0] && /http/.test(av[0]), '拒绝 rtmp:// 并提示需转 HTTP-FLV/HLS：' + String(av[0]).slice(0, 24) + '…');
  ck(av[1] && /flv|m3u8/.test(av[1]), '拒绝非 .flv/.m3u8 地址：' + String(av[1]).slice(0, 24) + '…');
  ck(av[2] === '', '接受 http .flv 地址');
  ck(av[3] === '', '接受 https .m3u8 地址（带查询串）');
  ck(av[4] === '请填写流地址', '空地址被拒绝');

  // ---------- B 加入与数据模型 ----------
  console.log('\n--- B 加入外部流 ---');
  ck(JSON.parse(await ev(`JSON.stringify(extAdd('rtmp://x/live/a'))`)).ok === false, '非法地址无法加入');
  const b1 = JSON.parse(await ev(`JSON.stringify(extAdd(${J(FLV_URL)}, '真实播放源'))`));
  const id1 = b1.id;
  ck(b1.ok === true, '合法地址加入成功（id=' + id1 + '）');
  const b2 = JSON.parse(await ev(`JSON.stringify(extAdd(${J(FLV_URL)}))`));
  ck(b2.ok === false && b2.error === '已存在', '重复地址被拒绝（提示已存在）');
  const ml = JSON.parse(await ev(`JSON.stringify(extMonList())`));
  ck(ml.length === 1 && ml[0]._prov === 'external' && ml[0]._extId === id1 &&
     ml[0].AppName === 'ext' && ml[0].DomainName === '127.0.0.1:' + PORT,
     'extMonList 形态与云端流同构（_prov/_extId/AppName/DomainName 正确）');
  ck(await ev(`extWatchKeyOf(${J(id1)}) === 'external|ext|' + ${J(id1)}`), '观看卡 key 稳定且唯一');

  // B2 界面路径（真实用户入口：填地址 → 点「加入」）
  const UI_URL = 'http://127.0.0.1:1/live/ui.flv';
  await ev(`document.getElementById('extUrl').value=${J(UI_URL)};
    document.getElementById('extName').value='界面加入源';
    document.getElementById('extAddBtn').click(); 'ok'`);
  await sleep(300);
  ck(JSON.parse(await ev(`JSON.stringify(extList().map(function(e){return e.name;}))`)).indexOf('界面加入源') >= 0,
     '界面「加入」按钮可加入外部地址流（真实点击路径）');
  ck(await ev(`document.getElementById('extUrl').value === '' && document.getElementById('extName').value === ''`),
     '加入成功后地址/备注输入框被清空（便于连续加入）');
  await ev(`document.getElementById('extUrl').value='rtmp://x/live/a'; document.getElementById('extAddBtn').click(); 'ok'`);
  await sleep(200);
  ck(!JSON.parse(await ev(`JSON.stringify(extList().map(function(e){return e.url;}))`)).some(function (u) { return u.indexOf('rtmp') === 0; }),
     '界面加入非法地址（rtmp://）被拦截，未写入配置');
  await ev(`(function(){var e=extList().filter(function(x){return x.name==='界面加入源';})[0]; if(e) extRemove(e.id,'手动关闭'); return 'ok';})()`);
  await sleep(200);
  ck((await ev(`extList().length`)) === 1, '清理界面加入的测试流（无实测样本 → 不产生空历史）');
  ck((await ev(`extHistLoad().length`)) === 0, '无样本的流关闭后不写空历史');

  // ---------- C 注入 _monList 后的菜单联动 ----------
  console.log('\n--- C 菜单联动（预览 / 概览 / 在线流）---');
  await ev(`document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active');});
    document.getElementById('view-overview').classList.add('active');
    document.getElementById('view-watch').classList.add('active'); refreshMonitor(false);`);
  await sleep(1200);
  const provs = JSON.parse(await ev(`JSON.stringify((window._monList||[]).map(function(s){return s._prov;}))`));
  ck(provs.filter(function (p) { return p === 'external'; }).length === 1, '_monList 已合并外部流：' + J(provs));
  ck(await ev(`document.getElementById('stOnline').textContent === '3'`), '概览在线流总数含外部流（3 = 腾讯1+阿里1+外部1）');
  const pc = JSON.parse(await ev(`(function(){var c={tencent:0,aliyun:0,external:0};(window._monList||[]).forEach(function(s){
    if(s._prov==='external')c.external++;else if(s._prov==='aliyun')c.aliyun++;else c.tencent++;});return JSON.stringify(c);})()`));
  ck(pc.tencent === 1 && pc.aliyun === 1 && pc.external === 1, '云商分布三分支计数正确：' + J(pc));
  const pie = JSON.parse(await ev(`(function(){var el=document.getElementById('ovPie');if(!el||!el._chart)return 'none';
    return JSON.stringify(el._chart.getOption().series[0].data.map(function(d){return {name:d.name,value:d.value};}));})()`));
  ck(Array.isArray(pie) && pie.some(function (d) { return d.name === '外部地址流' && d.value === 1; }),
     '概览饼图含「外部地址流」分类：' + J(pie));
  ck(await ev(`document.getElementById('monBody').querySelectorAll('tr').length === 2`),
     '在线流页只列云商流（外部流不混入，避免云商操作误用）');
  const cards = Number(await ev(`document.getElementById('watchGrid').querySelectorAll('.wcard').length`));
  ck(cards === 3, '预览观看卡片数 = 3（腾讯 1 + 阿里 1 + 外部 1），实际 ' + cards);
  ck(await ev(`(function(){var c=document.querySelectorAll('#watchGrid .wcard');for(var i=0;i<c.length;i++){
    if(c[i].textContent.indexOf('真实播放源')>=0)return 'hit';}return 'miss';})()`) === 'hit',
     '外部流卡片以备注名为标题');
  ck(await ev(`(function(){var c=document.querySelectorAll('#watchGrid .wcard');for(var i=0;i<c.length;i++){
    if(c[i].textContent.indexOf('真实播放源')>=0 && c[i].querySelector('[data-wact="close"]'))return 'yes';}return 'no';})()`) === 'yes',
     '外部流卡片带「关闭」按钮（手动关闭入口）');
  ck(await ev(`document.getElementById('watchCount').textContent.indexOf('含外部地址流 1') >= 0`),
     '预览观看计数标注外部流：' + await ev(`document.getElementById('watchCount').textContent`));

  // ---------- D 流质量（未播放 → 静默实测） ----------
  console.log('\n--- D 流质量检测（静默实测）---');
  const id2 = JSON.parse(await ev(`JSON.stringify(extAdd(${J(DEAD1)}, '静默实测源'))`)).id;
  await ev(`document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active');});
    document.getElementById('view-quality').classList.add('active'); qDetectAll();`);
  await sleep(900);
  const qk2 = await ev(`qCardKey(extMonList().filter(function(s){return s._extId===${J(id2)};})[0])`);
  const qGet = async (sfx) => await ev(`(document.getElementById(${J(qk2 + ':' + sfx)})||{}).textContent`);
  ck(!!qk2, '外部流质量卡已创建（key=' + qk2 + '）');
  ck((await qGet('br')) === '6,928', '码率取静默实测值 6928 kbps（显示 ' + await qGet('br') + '）');
  ck((await qGet('vf')) === '25.0', '帧率取静默实测值 25.0（显示 ' + await qGet('vf') + '）');
  ck((await qGet('res')) === '1920×1080', '分辨率取静默实测值 1920×1080（显示 ' + await qGet('res') + '）');
  ck(/静默实测/.test(await qGet('extra')), '标注数据来源为 ffmpeg 静默实测：' + String(await qGet('extra')).slice(0, 36) + '…');
  ck((await ev(`__e2e.state.ffProbe.length`)) > 0, '确实调用了主进程探测接口');
  ck((await ev(`__e2e.state.ffProbe[0].seconds`)) === 5, '探测请求带采样秒数（权威码率的来源）');
  const qk1 = await ev(`qCardKey(extMonList().filter(function(s){return s._extId===${J(id1)};})[0])`);
  ck(!!qk1 && qk1 !== qk2, '同名不同流不共用质量卡（key 带流维度）');

  // ---------- E 带宽监控 ----------
  console.log('\n--- E 带宽监控 ---');
  await ev(`document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active');});
    document.getElementById('view-charts').classList.add('active'); bwStreamsRefresh();`);
  await sleep(700);
  const grp = JSON.parse(await ev(`JSON.stringify(Object.keys(_bwGrp).map(function(k){
    return [_bwGrp[k].prov,_bwGrp[k].kbps,_bwGrp[k].name];}))`));
  const extGrp = grp.filter(function (x) { return x[0] === 'external' && x[2] === '静默实测源'; });
  ck(extGrp.length === 1, '带宽自动分组含外部流条目：' + J(grp));
  ck(extGrp[0] && extGrp[0][1] === 6928, '外部流带宽采用实测码率 6928 kbps');
  const sumTxt = await ev(`document.getElementById('bwGrpSum').textContent`);
  ck(/外部地址流 2/.test(sumTxt), '带宽页汇总标注外部流数量：' + sumTxt);
  const series = JSON.parse(await ev(`(function(){var el=document.getElementById('bwGrpChart');
    return el&&el._chart?JSON.stringify(el._chart.getOption().series.map(function(s){return s.name;})):'[]';})()`));
  ck(series.some(function (n) { return /外部地址流/.test(n); }), '带宽图表含外部地址流系列：' + J(series));
  ck(await ev(`document.getElementById('bwGrpBody').textContent.indexOf('外部地址流') >= 0`), '带宽明细表含外部地址流分组标题');

  // ---------- F 采样累积与历史写入 ----------
  console.log('\n--- F 采样累积与历史写入 ---');
  await ev(`(function(){for(var i=0;i<300;i++){extSessPush(${J(id2)}, 4000+(i%50)*20, 24+(i%3), '1920×1080');}
    _extSess[${J(id2)}].startAt = Date.now()-300000; return 'ok';})()`);
  const st1 = JSON.parse(await ev(`JSON.stringify(extSessStat(${J(id2)}))`));
  ck(st1.points === 300, '会话采样点统计正确（300，未被空样本污染）');
  ck(st1.kbpsMax === 4980, '峰值码率计算正确（4980）');
  ck(Math.abs(st1.fpsAvg - 25) < 0.6, '平均帧率计算正确（' + st1.fpsAvg + '，接近 25）');
  ck(st1.dur >= 299 && st1.dur <= 301, '会话时长按起止时间计算（' + st1.dur + ' 秒）');
  ck(st1.res === '1920×1080', '会话记录分辨率');
  ck((await ev(`extSessStat('nonexistent')`)) === null, '无样本的流不产生统计（不会写出空历史）');
  await ev(`extHistFinalize(${J(id2)},'手动关闭')`);
  const H1 = JSON.parse(await ev(`JSON.stringify(extHistLoad().map(function(h){
    return [h.id,h.reason,h.points,h.samples.length,h.kbpsMax,h.res,h.open];}))`));
  ck(H1.length === 1, '历史写入 1 条：' + J(H1));
  ck(H1[0][1] === '手动关闭', '结束原因 = 手动关闭');
  ck(H1[0][2] === 300, '历史保留完整采样点数（300）');
  ck(H1[0][3] <= 601, '历史样本按上限抽稀（' + H1[0][3] + ' ≤ 601）');
  ck(H1[0][6] === false, '历史条目已收尾（open=false）');

  // ---------- G 手动关闭 ----------
  console.log('\n--- G 手动关闭外部流 ---');
  await ev(`extRemove(${J(id2)},'手动关闭')`);
  await sleep(400);
  ck(await ev(`extList().length === 1`), '配置中已移除该外部流（仅剩 #1）');
  ck(await ev(`(window._monList||[]).filter(function(s){return s._prov==='external' && s._extId===${J(id2)};}).length === 0`),
     '_monList 中已无该外部流');
  ck(await ev(`_watchPlayers['external|ext|' + ${J(id2)}] === undefined`), '预览卡片与播放器已销毁');
  ck(await ev(`extHistLoad().length === 1`), '关闭后历史记录仍保留（可回看流数据）');
  ck(Number(await ev(`document.getElementById('extHistBody').querySelectorAll('tr').length`)) === 1,
     '历史记录表格渲染 1 行');

  // ---------- H 断流（走应用自身的失败链路） ----------
  console.log('\n--- H 断流自动记录 ---');
  const id3 = JSON.parse(await ev(`JSON.stringify(extAdd(${J(DEAD2)}, '断流测试源'))`)).id;
  await ev(`(function(){for(var i=0;i<40;i++){extSessPush(${J(id3)}, 2500+i*10, 25, '1280×720');}
    _extSess[${J(id3)}].startAt = Date.now()-40000; return 'ok';})()`);
  console.log('  等待应用自身判定断流（连接失败 → 重试一轮 → 判定）…');
  let down = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    down = await ev(`!!(extFind(${J(id3)}) && extFind(${J(id3)}).down)`);
    if (down) break;
  }
  ck(down === true, '应用自身判定出断流（非手工调用 extMarkDown）');
  const H2 = JSON.parse(await ev(`JSON.stringify(extHistLoad().map(function(h){return [h.id,h.reason,h.kbpsAvg,h.res];}))`));
  ck(H2.length === 2, '断流写入第 2 条历史：' + J(H2));
  ck(/断流/.test(H2[0][1]), '断流记录的结束原因含「断流」：' + H2[0][1]);
  ck(await ev(`extFind(${J(id3)}).down === true`), '断流后该流仍保留在预览列表并标记 down（便于重连）');
  ck(await ev(`extMonList().filter(function(s){return s._extId===${J(id3)};})[0]._extDown === true`),
     '监控条目带 _extDown 标记供各菜单展示');
  await ev(`qDetectAll()`);
  await sleep(500);
  const qk3 = await ev(`qCardKey(extMonList().filter(function(s){return s._extId===${J(id3)};})[0])`);
  const st3 = await ev(`(document.getElementById(${J(qk3 + ':st')})||{}).textContent`);
  const ex3 = await ev(`(document.getElementById(${J(qk3 + ':extra')})||{}).textContent`);
  ck(/已断流/.test(st3 || ''), '质量卡状态显示「已断流」：' + st3);
  ck(/已断流|历史/.test(ex3 || ''), '断流后用历史数据回填，卡片不空白：' + String(ex3).slice(0, 44) + '…');
  ck(/断流/.test(await ev(`document.getElementById('extHistBody').textContent`)), '历史表格中可见断流记录（可查看流数据）');

  // ---------- I 重连重置 ----------
  console.log('\n--- I 重连后开启新会话 ---');
  await ev(`extOnAlive(${J(id3)})`);
  ck(await ev(`extFind(${J(id3)}).down === false`), '重连后断流标记被清除');
  ck(await ev(`_extSess[${J(id3)}].samples.length === 0 && _extSess[${J(id3)}].finalized === false`),
     '重连后开启新会话（采样清空、可再次记历史）');
  const nBefore = await ev(`extHistLoad().length`);
  await ev(`(function(){for(var i=0;i<10;i++){extSessPush(${J(id3)}, 3000, 25, '1280×720');}return 'ok';})()`);
  await ev(`extHistFinalize(${J(id3)},'断流')`);
  ck((await ev(`extHistLoad().length`)) === nBefore + 1, '重连后的新会话产生新的一条历史（不与上一条合并）');
  // 幂等回归：同一次会话被收尾两次只更新同一条
  // （曾出现缺陷：收尾后 open=false，extHistFindOpen 再也命中不到 → 同一条流写出两条重复记录）
  const snap = `JSON.stringify({n:extHistLoad().length,hid:extHistLoad()[0].hid,reason:extHistLoad()[0].reason,endAt:extHistLoad()[0].endAt})`;
  const b4 = JSON.parse(await ev(snap));
  await ev(`extRemove(${J(id3)},'手动关闭')`);
  const a4 = JSON.parse(await ev(snap));
  ck(a4.n === b4.n, '关闭时再次收尾不新增重复记录（同一次会话只有一条）：' + b4.n + ' → ' + a4.n);
  ck(a4.hid === b4.hid && a4.reason === '断流' && a4.endAt === b4.endAt,
     '同一条记录被原地更新，且首次结束原因「断流」不被后续手动关闭覆盖：' + J(a4));

  // ---------- J 历史恢复 ----------
  console.log('\n--- J 未正常结束的历史回收 ---');
  await ev(`(function(){var H=extHistLoad(); H.forEach(function(h){h.open=false;});
    H.unshift({hid:'hx',id:'gone',open:true,reason:'直播中',name:'崩溃残留',url:'http://x/a.flv',samples:[],startAt:Date.now()});
    extHistSave(H); return 'ok';})()`);
  ck((await ev(`extHistRecover()`)) === 1, '回收 1 条「进行中」记录');
  ck((await ev(`(extHistLoad().filter(function(h){return h.hid==='hx';})[0]||{}).reason`)) === '未正常结束',
     '残留记录被标记为「未正常结束」而不是留成进行中');
  await ev(`extHistDelete('hx')`);

  // ---------- K 历史查看与导出 ----------
  console.log('\n--- K 历史数据查看与导出 ---');
  const rows = Number(await ev(`document.getElementById('extHistBody').querySelectorAll('tr').length`));
  const hcount = Number(await ev(`extHistLoad().length`));
  ck(rows === hcount && hcount === 3, '历史表格行数 = 历史条数（' + hcount + '），实际 ' + rows);
  const hid = await ev(`extHistLoad()[0].hid`);
  await ev(`extShowData(${J(hid)})`);
  await sleep(400);
  ck(await ev(`!document.getElementById('extDataMask').classList.contains('hidden')`), '历史数据弹窗打开');
  ck(/http:\/\/127\.0\.0\.1/.test(await ev(`document.getElementById('extDataSub').textContent`)),
     '弹窗显示该次会话的地址与起止时间');
  ck(/kbps/.test(await ev(`document.getElementById('extDataStats').textContent`)),
     '弹窗统计含码率：' + String(await ev(`document.getElementById('extDataStats').textContent`)).replace(/\s+/g, ' ').slice(0, 56));
  const csv0 = await ev(`__e2e.state.saveCsv.length`);
  await ev(`document.getElementById('extDataCsvBtn').click()`);
  await sleep(300);
  ck((await ev(`__e2e.state.saveCsv.length`)) === csv0 + 1, '导出 CSV 触发了保存');
  const C = JSON.parse(await ev(
    `(function(){var a=__e2e.state.saveCsv;return JSON.stringify(a.length?a[a.length-1]:{name:'',content:''});})()`)) || { name: '', content: '' };
  ck(/外部流历史_.*\.csv$/.test(C.name), 'CSV 文件名含流名与结束时间：' + C.name);
  ck(/采样时间,码率 kbps,帧率 fps/.test(C.content), 'CSV 表头正确');
  ck((C.content || '').split('\n').length > 2, 'CSV 含数据行（' + (C.content || '').split('\n').length + ' 行）');
  ck((await ev(`document.querySelectorAll('#extHistBody button[data-ha="readd"]').length`)) === hcount,
     '每条历史都带「重新加入」入口（' + hcount + ' 条）');
  await ev(`document.getElementById('extDataCloseBtn').click()`);
  ck(await ev(`document.getElementById('extDataMask').classList.contains('hidden')`), '弹窗可关闭');

  // ---------- L 真实播放链路 ----------
  console.log('\n--- L 真实 http-flv 播放与采样 ---');
  // 重建该卡片播放器并在限速下行窗口内观测：静态素材 25 秒 + 下行限速 ≈2080 kbps，
  // 8 秒窗口内码率/帧率都有稳定真实值（不做重建则此前的下行早已发完，字节差恒为 0）
  await ev(`(function(){var k='external|ext|'+${J(id1)}; watchStop(k); renderWatch(); return 'ok';})()`);
  await sleep(8000);
  const L = JSON.parse(await ev(`JSON.stringify((function(){
    var k='external|ext|'+${J(id1)}, st=_watchPlayers[k], sm=((_extSess[${J(id1)}]||{}).samples||[]);
    return {
      keys: Object.keys(_watchPlayers).filter(function(x){return x.indexOf('external|')===0;}),
      samples: sm.length,
      maxKbps: sm.reduce(function(a,x){return Math.max(a,x.kbps||0);},0),
      fps: sm.length?sm[sm.length-1].fps:0,
      status: (st&&st.status)?st.status.textContent:''
    };
  })())`));
  ck(L.keys.length === 1, '外部流卡片保持播放实例（未因其他流关闭被误销毁）');
  ck(L.samples >= 4, '真实播放期间持续产生每秒采样（' + L.samples + ' 点）');
  ck(/播放中|连接中/.test(L.status), '播放状态正常推进：' + String(L.status).slice(0, 46));
  ck(L.maxKbps >= 1200 && L.maxKbps <= 3600,
     'FLV 下行字节数换算出的码率落在限速带宽内：' + L.maxKbps + ' kbps（下行限速 ≈2080 kbps）');
  ck(L.fps > 0, '解码帧率实测有效：' + L.fps + ' fps');
  const wd = JSON.parse(await ev(`JSON.stringify({k:document.querySelector('#watchGrid .wcard [data-w="kbps"]')?1:0})`));
  ck(wd.k === 1, '预览卡片指标区正常渲染');
  await ev(`extRemove(${J(id1)},'手动关闭')`);
  await sleep(200);
  const Hfinal = JSON.parse(await ev(`JSON.stringify(extHistLoad().map(function(h){return [h.name,h.reason,h.kbpsAvg,h.points];}))`));
  ck(Hfinal.length === 4, '全部会话均有历史留档（共 ' + Hfinal.length + ' 条）：' + J(Hfinal));
  ck(Hfinal.some(function (h) { return h[0] === '真实播放源' && h[1] === '手动关闭' && h[2] > 0; }),
     '真实播放的那次会话也写入了历史且平均码率有效');

  // ---------- 汇总 ----------
  const pass = results.filter((x) => x.ok).length;
  console.log('\n========================================');
  console.log('外部地址流 E2E：' + pass + '/' + results.length + (pass === results.length ? '  ALL PASS' : '  存在失败'));
  results.filter((x) => !x.ok).forEach((x) => console.log('  FAIL: ' + x.msg));
  console.log('========================================');
  try { srv.close(); } catch (e) {}
  setTimeout(() => app.exit(pass === results.length ? 0 : 1), 300);
}).catch((e) => { console.log('HARNESS ERROR: ' + (e && e.stack || e)); app.exit(2); });
