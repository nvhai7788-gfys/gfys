// E2E r63：直播推流（本地推流 + 本地录制）/ 转码水印模板 / 直播间 / 集群节点管理 —— 整行显示
//  A. 四页去掉左右分栏：表单/功能卡占满内容区一行，列表/结果块在下方整行
//  B. 复选框 / 单选框不被全局 input{width:100%} 拉伸（checkbox 紧贴文字，宽度为固有宽度）
//  C. 空态文案与新布局一致（不再出现「从左侧…」）
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

  // ---------- A. 四页整行 ----------
  const pages = [
    { view: 'localpush', anchors: ['#lpStartBtn', '#lpRecBtn', '#lpBody'], name: '直播推流·本地录制' },
    { view: 'room', anchors: ['#rmAddBtn', '#rmList'], name: '直播间' },
    { view: 'templates', anchors: ['#tpAddBtn', '#tpList'], name: '转码水印模板' },
    { view: 'nodes', anchors: ['#ndAddBtn', '#ndList'], name: '集群节点管理' }
  ];
  for (const p of pages) {
    await ex(`document.querySelector('.nav-item[data-view="${p.view}"]').click(); 'ok'`);
    await wait(300);
    const g = await ex(`(function(){
      function row(sel){ var e=document.querySelector(sel); if(!e) return null;
        var c=e.closest('.card')||e; var cr=c.getBoundingClientRect();
        var row=(c.closest('.grid-2')||c); var rr=row.getBoundingClientRect();
        return {y:Math.round(cr.y), rowW:Math.round(rr.width), top:Math.round(rr.top)}; }
      return { first: row('${p.anchors[0]}'), last: row('${p.anchors[p.anchors.length-1]}'),
        hasGrid: !!document.querySelector('#view-${p.view} > .grid-2') };
    })()`);
    const contentW = await ex(`(function(){ return Math.round(document.getElementById('view-${p.view}').getBoundingClientRect().width); })()`);
    const okRow = g.first && g.last && g.first.rowW > contentW * 0.85 && g.last.rowW > contentW * 0.85;
    const okStack = g.first && g.last && g.last.top >= g.first.top;   // 列表在表单卡所在行之下或同行（localpush 两卡上下）
    check(`A ${p.name}：功能卡与列表均整行（行宽 ${g.first && g.first.rowW} / ${g.last && g.last.rowW} / 内容区 ${contentW}）`, okRow, JSON.stringify(g));
    check(`A ${p.name}：无左右分栏容器`, !g.hasGrid, JSON.stringify({ hasGrid: g.hasGrid }));
  }

  // ---------- B. 复选框不被拉伸 ----------
  await ex(`document.querySelector('.nav-item[data-view="localpush"]').click(); 'ok'`);
  await wait(300);
  const cb = await ex(`(function(){
    var c=document.getElementById('lpLoop'), r=document.querySelector('input[name="lpSrcType"]');
    if(!c||!r) return null;
    return { cbW: Math.round(c.getBoundingClientRect().width), radioW: Math.round(r.getBoundingClientRect().width) };
  })()`);
  check('B 复选框 / 单选框为固有宽度（≤28px，不再被 width:100% 拉伸）',
    cb && cb.cbW <= 28 && cb.radioW <= 28, JSON.stringify(cb));

  // ---------- C. 空态文案 ----------
  await ex(`(function(){ renderRooms && renderRooms(); renderNodes && renderNodes(); renderTemplates && renderTemplates(); 'ok' })()`);
  await wait(200);
  const empty = await ex(`(function(){
    return { room: document.getElementById('rmList').textContent, nodes: document.getElementById('ndList').textContent,
      tp: document.getElementById('tpList').textContent };
  })()`);
  check('C 三处空态文案不再出现「从左侧」',
    empty.room.indexOf('从左侧') < 0 && empty.nodes.indexOf('从左侧') < 0 && empty.tp.indexOf('从左侧') < 0,
    JSON.stringify(empty));

  const bad = results.filter(r => !r.ok);
  console.log('========================================');
  console.log('E2E r63：' + (results.length - bad.length) + '/' + results.length + (bad.length ? '  FAILED' : '  ALL PASS'));
  await app.quit();
  process.exit(bad.length ? 1 : 0);
}
main().catch(e => { console.error(e); app.quit(); process.exit(1); });
