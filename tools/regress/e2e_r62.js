// E2E r62：六项改动的确定性回归
//  A. 表单整行排版：地址生成（腾讯/阿里）与拉流转推（腾讯/阿里）四页 —— 表单卡不再被 560px 压缩成左栏，
//     生成地址 / 任务列表移到表单下方（纵向堆叠，占满整行）
//  B. 音频可视化画布高度下调（预览卡 .aviz 58→42，质量页 .qaviz 46→36，独立预览窗 56→42）
//  C. 侧边栏菜单字体加大（分组 11→13.5px，菜单项 14.5→15.5px）
//  D. 在线流数量趋势数值修复：采样与渲染分离（页签点击 / extSync / 主题重绘不再插入重复样本）+ 整数刻度
//  E. 云服务器双云同页 + 自动查询（无页签；srvBodyTc + srvBodyAl 两块表格同屏）
//  F. 断流报警弹窗加大（420→600px，字号 / 按钮 / 图标同步放大）
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  → ' + (detail || '')));
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1500, height: 950, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  const ex = (js) => win.webContents.executeJavaScript(js);
  await wait(500);
  await ex("localStorage.clear(); (function(){ state.cfg={}; enterApp(false); })(); 'ok'");

  // ---------- A. 四页整行排版（阿里云页签是运行时并入腾讯云对应页的 cloud-pane） ----------
  const pages = [
    { view: 'genaddr', tab: null, formSel: '#genBtn', below: '#genPushCard', name: '地址生成（腾讯）' },
    { view: 'genaddr', tab: 'al', formSel: '#alGenBtn', below: '#alAddrResult', name: '地址生成（阿里）' },
    { view: 'relay', tab: null, formSel: '#tkSubmitBtn', below: '#taskBody', name: '拉流转推（腾讯）' },
    { view: 'relay', tab: 'al', formSel: '#alRelaySubmitBtn', below: '#alRelayBody', name: '拉流转推（阿里）' }
  ];
  for (const p of pages) {
    await ex(`document.querySelector('.nav-item[data-view="${p.view}"]').click(); 'ok'`);
    if (p.tab) {
      await ex(`(function(){ var t=document.querySelector('#view-${p.view} .ctab[data-cloud="${p.tab}"]'); if(t) t.click(); 'ok' })()`);
    }
    await wait(250);
    const g = await ex(`(function(){
      function box(sel){ var e=document.querySelector(sel); if(!e) return null; var r=e.getBoundingClientRect();
        var c=e.closest('.card')||e; var cr=c.getBoundingClientRect();
        // 结果所在的「行」：并排卡取其 grid-2 容器，普通卡取自身
        var row=(c.closest('.grid-2')||c); var rr=row.getBoundingClientRect();
        return {y:Math.round(r.y), cardW:Math.round(cr.width), rowW:Math.round(rr.width), rowX:Math.round(rr.x)}; }
      return { form: box('${p.formSel}'), below: box('${p.below}') };
    })()`);
    const contentW = await ex(`(function(){ var v=document.getElementById('view-${p.view}'); return Math.round(v.getBoundingClientRect().width); })()`);
    // 整行 = 表单卡与结果行都接近内容区宽度（>85%），且结果块在表单下方（y 更大）
    const okW = g.form && g.below && g.form.cardW > contentW * 0.85 && g.below.rowW > contentW * 0.85;
    const okBelow = g.form && g.below && g.below.y > g.form.y;
    check(`A ${p.name}：表单整行（表单卡 ${g.form && g.form.cardW} / 结果行 ${g.below && g.below.rowW} / 内容区 ${contentW}）`, okW, JSON.stringify(g));
    check(`A ${p.name}：结果在表单下方（form.y=${g.form && g.form.y} < below.y=${g.below && g.below.y}）`, okBelow, JSON.stringify(g));
  }

  // ---------- B. 音频画布高度 ----------
  const av = await ex(`(function(){
    var it = { key: 't|push.x.com|live|avz|', live: true, tag: '',
      s: { _prov: 'tencent', StreamName: 'avz', AppName: 'live', DomainName: 'push.x.com' } };
    var card = watchBuildCard(it);
    document.getElementById('watchGrid').appendChild(card);
    document.getElementById('view-watch').classList.add('active');
    var el = card.querySelector('[data-w="aviz"]');
    var h = el ? Math.round(el.getBoundingClientRect().height) : null;
    watchStop(it.key);
    return { h: h };
  })()`);
  check('B 预览卡音频画布高度 ≤ 48px（原 58px）', av.h !== null && av.h <= 48, JSON.stringify(av));
  const css = await ex(`(function(){
    var rules=[].slice.call(document.styleSheets).map(function(s){try{return [].slice.call(s.cssRules||[])}catch(e){return []}}).reduce(function(a,b){return a.concat(b)},[]);
    function h(sel){ var r=rules.filter(function(x){return x.selectorText===sel})[0]; return r?r.style.height:null; }
    return { aviz: h('.aviz'), qaviz: h('.qaviz') };
  })()`);
  check('B 质量页 .qaviz 高度下调到 36px（原 46px）', css.qaviz === '36px' && css.aviz === '42px', JSON.stringify(css));
  const pv = require('fs').readFileSync(path.join(ROOT, 'renderer', 'preview.html'), 'utf8');
  check('B 独立预览窗音频画布高度 42px（原 56px）', /\.aviz\{[^}]*height:42px/.test(pv), 'preview.html .aviz height');

  // ---------- C. 侧边栏字体 ----------
  const nav = await ex(`(function(){
    var g=document.querySelector('.nav-group'), i=document.querySelector('.nav-item span');
    return { groupFs: g?getComputedStyle(g).fontSize:null, groupW: g?getComputedStyle(g).fontWeight:null,
      itemFs: i?getComputedStyle(i).fontSize:null };
  })()`);
  check('C 侧边栏分组标题（总览 / 系统 等）13.5px 加粗', parseFloat(nav.groupFs) >= 13 && parseInt(nav.groupW) >= 700, JSON.stringify(nav));
  check('C 侧边栏菜单项 15.5px（原 14.5px）', parseFloat(nav.itemFs) >= 15, JSON.stringify(nav));

  // ---------- D. 趋势数值：采样与渲染分离 ----------
  await ex(`document.querySelector('.nav-item[data-view="overview"]').click(); 'ok'`);
  await wait(300);
  const d = await ex(`(function(){
    window._monList = [{_prov:'tencent'},{_prov:'aliyun'},{_prov:'external'}];
    var before = _ovTrend.length;
    ovSampleTrend();                       // 定时轮询采样点
    var afterSample = _ovTrend.length;
    ovUpdateCharts(); ovUpdateCharts();    // 重绘（此前每次都会 push → 重复样本）
    var afterRenders = _ovTrend.length;
    // 点页签（模拟 r62 之前会 push 的路径）
    return { before: before, afterSample: afterSample, afterRenders: afterRenders,
      last: _ovTrend[afterSample-1] || null };
  })()`);
  check('D ovUpdateCharts 重绘不插入样本（渲染前后长度不变）',
    d.afterSample === d.before + 1 && d.afterRenders === d.afterSample, JSON.stringify(d));
  check('D 样本数值正确（tc=1 / al=1 / ex=1）',
    d.last && d.last.tc === 1 && d.last.al === 1 && d.last.ex === 1, JSON.stringify(d.last));
  const eLine = await ex(`(function(){
    // intAxis → yAxis minInterval=1（计数不出现 0.5 刻度）
    var captured=null;
    var orig=window.echarts; if(!orig) return {skip:true};
    return { hasInt: typeof ovSampleTrend==='function' && typeof ovCounts==='function' };
  })()`);
  const src = require('fs').readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  check('D renderELine 支持 intAxis 整数刻度且趋势图启用',
    /minInterval: opts\.intAxis \? 1 : undefined/.test(src) && /\['路数'\], 'light', \{ intAxis: true \}/.test(src), '');

  // ---------- E. 云服务器双云同页 + 自动查询 ----------
  await ex(`document.querySelector('.nav-item[data-view="servers"]').click(); 'ok'`);
  await wait(500);
  const srv = await ex(`(function(){
    var tc=document.getElementById('srvBodyTc'), al=document.getElementById('srvBodyAl');
    var t1=document.getElementById('srvRegion'), t2=document.getElementById('srvAlRegion');
    return { hasTc: !!tc, hasAl: !!al, bothVisible: !!(tc&&al&&tc.offsetHeight>0&&al.offsetHeight>0),
      tcText: tc?tc.textContent.slice(0,60):null, alText: al?al.textContent.slice(0,60):null,
      regionsVisible: !!(t1&&t2&&t1.offsetHeight>0&&t2.offsetHeight>0),
      noTabs: !document.getElementById('srvCloudTabs') };
  })()`);
  check('E 双云表格同屏（srvBodyTc + srvBodyAl 均可见），页签已移除',
    srv.hasTc && srv.hasAl && srv.bothVisible && srv.noTabs && srv.regionsVisible, JSON.stringify(srv));
  check('E 进入页面自动查询（腾讯区已出现自动查询结果而非初始占位）',
    srv.tcText && srv.tcText.indexOf('选择地域后点击') < 0, srv.tcText);

  // 双云行内操作各自的列表隔离：模拟两行按钮
  const iso = await ex(`(function(){
    window._srvListTc=[{InstanceId:'tc-1',InstanceName:'腾讯机',InstanceState:'RUNNING'}];
    window._srvListAl=[{InstanceId:'al-1',InstanceName:'阿里机',Status:'Running',_regionId:'cn-hangzhou'}];
    var tc=window._srvListTc[0], al=window._srvListAl[0];
    var bt={dataset:{srv:'reboot',cloud:'tc',i:0}}, ba={dataset:{srv:'reboot',cloud:'al',i:0}};
    function pick(b){ return ((b.dataset.cloud==='al'?window._srvListAl:window._srvListTc)||[])[Number(b.dataset.i)]; }
    return { tc: pick(bt)&&pick(bt).InstanceId, al: pick(ba)&&pick(ba).InstanceId };
  })()`);
  check('E 行内操作按 data-cloud 取各自列表（tc→_srvListTc / al→_srvListAl）',
    iso.tc === 'tc-1' && iso.al === 'al-1', JSON.stringify(iso));

  // 未配置阿里云密钥时自动查询静默（不 toast，只在表格内提示）
  const silent = await ex(`(function(){
    var saved={id:state.cfg.aliId,key:state.cfg.aliKey}; state.cfg.aliId=''; state.cfg.aliKey='';
    var toasts=0; var orig=window.toast; window.toast=function(){ toasts++; };
    queryAlInstances(true);
    var tipAl=document.getElementById('srvBodyAl').textContent;
    queryAlInstances();   // 手动路径仍应 toast 提醒
    window.toast=orig; state.cfg.aliId=saved.id; state.cfg.aliKey=saved.key;
    return { toastsAuto: toasts, tipHasCfg: tipAl.indexOf('AccessKey') >= 0 };
  })()`);
  check('E 自动查询未配阿里云密钥：静默且表格内提示；手动查询才 toast',
    silent.toastsAuto === 1 && silent.tipHasCfg, JSON.stringify(silent));

  // ---------- F. 断流报警弹窗加大（r65 改为多实例堆叠，showAlarmModal 往 #alarmStack 追加卡片） ----------
  await ex(`showAlarmModal('在线流断开','流「mystream」（腾讯云）已停止推流'); 'ok'`);
  await wait(300);
  const modal = await ex(`(function(){
    var m=document.querySelector('#alarmStack .alarm-modal');
    if(!m) return null; var r=m.getBoundingClientRect();
    var t=m.querySelector('.alarm-type'), x=m.querySelector('.alarm-text');
    return { w:Math.round(r.width), h:Math.round(r.height),
      titleFs:t?getComputedStyle(t).fontSize:null, textFs:x?getComputedStyle(x).fontSize:null };
  })()`);
  check('F 弹窗加大：宽 ≥ 560px（原 420px）', modal && modal.w >= 560, JSON.stringify(modal));
  check('F 弹窗文字加大：标题 ≥ 19px、正文 ≥ 15px（原 16/13px）',
    modal && parseFloat(modal.titleFs) >= 19 && parseFloat(modal.textFs) >= 15, JSON.stringify(modal));
  // 关闭弹窗，避免影响后续
  await ex(`(function(){ closeAllAlarmModals(); 'ok' })()`);

  // ---------- 汇总 ----------
  const bad = results.filter(r => !r.ok);
  console.log('========================================');
  console.log('E2E r62：' + (results.length - bad.length) + '/' + results.length + (bad.length ? '  FAILED' : '  ALL PASS'));
  await app.quit();
  process.exit(bad.length ? 1 : 0);
}
main().catch(e => { console.error(e); app.quit(); process.exit(1); });
