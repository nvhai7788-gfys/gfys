// E2E r53：阿里云直播资源包管理 —— 页签合并 + 真实 BSS 查询 + 单位换算渲染
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail || '' }); }

async function main() {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  const ex = (js) => win.webContents.executeJavaScript(js);
  // 模拟登录态绑定（同 r51 修正后的做法：显式初始化依赖 enterApp 的绑定）
  await ex("localStorage.clear(); (function(){ state.cfg={}; bindWatchPrefs(); bindMonitorPrefs(); })(); 'ok'");

  // ---------- A. 页签合并结构 ----------
  const a1 = await ex(`(function(){
    var view = document.getElementById('view-package');
    var tabs = view.querySelector('.cloud-tabs');
    var pane = view.querySelector(':scope > .cloud-pane');
    var srcGone = !document.getElementById('view-al-package');
    return { hasTabs: !!tabs, hasPane: !!pane, paneHidden: pane ? pane.classList.contains('hidden') : null,
             tcTable: !!view.querySelector('#pkgBody'), alTable: pane ? !!pane.querySelector('#alPkgBody') : null, srcGone };
  })()`);
  check('A1 资源包页已合并云商页签：cloud-tabs + 阿里云 pane（初始隐藏）+ 原 al 视图已搬移',
    a1.hasTabs && a1.hasPane && a1.paneHidden && a1.tcTable && a1.alTable && a1.srcGone, JSON.stringify(a1));

  // ---------- B. 渲染逻辑（注入实测抓取的真实结构数据）----------
  const b1 = await ex(`(function(){
    renderAlPackage([
      { InstanceId:'liveflowbag-cn-7mx4x1nh9001', Remark:'全球通用流量包', CommodityCode:'liveflowbag', Status:'Available',
        EffectiveTime:'2026-08-16T10:00:00Z', ExpiryTime:'2027-08-16T10:00:00Z',
        TotalAmount:'1', TotalAmountUnit:'TB', RemainingAmount:'1', RemainingAmountUnit:'TB',
        ApplicableProducts:{ Product:['live','live_cainiao'] } },
      { InstanceId:'liveflowbag-cn-fpi4uo0kk002', Remark:'全球通用流量包', CommodityCode:'liveflowbag', Status:'Available',
        EffectiveTime:'2026-07-01T04:00:00Z', ExpiryTime:'2027-07-01T04:00:00Z',
        TotalAmount:'1', TotalAmountUnit:'TB', RemainingAmount:'202.196598', RemainingAmountUnit:'GB',
        ApplicableProducts:{ Product:['live'] } },
      { InstanceId:'liveflowbag-cn-6sz4sltra002', Remark:'全球通用流量包', CommodityCode:'liveflowbag', Status:'Available',
        TotalAmount:'1', TotalAmountUnit:'TB', RemainingAmount:'0', RemainingAmountUnit:'Byte',
        ApplicableProducts:{ Product:['live'] } }
    ]);
    var view = document.getElementById('view-package');
    var pane = view.querySelector(':scope > .cloud-pane');
    var rows = pane.querySelectorAll('#alPkgBody tr').length;
    return {
      rows,
      active: document.getElementById('alPkgActive').textContent,
      total: document.getElementById('alPkgTotal').textContent,
      used: document.getElementById('alPkgUsed').textContent,
      left: document.getElementById('alPkgLeft').textContent,
      statsShown: document.getElementById('alPkgStats').style.display === 'grid',
      // 第 2 行：剩余 202.196598GB / 总量 1TB(=1024GB) → 已用 821.8GB
      row2used: pane.querySelectorAll('#alPkgBody td')[6+11].textContent,   // 第2行第7列（已用）
      row3pct: pane.querySelectorAll('#alPkgBody td')[7+22].textContent     // 第3行使用率（0剩余=100%）
    };
  })()`);
  const b1ok = b1.rows === 3 && b1.active === '3 / 3' && b1.statsShown &&
    b1.total === '3.00 TB' && b1.used === '1.80 TB' && b1.left === '1.20 TB' &&
    b1.row2used.indexOf('821.8 GB') >= 0 && b1.row3pct.indexOf('100.0%') >= 0;
  check('B1 渲染 3 包 + 汇总卡 + 跨单位换算（GB剩余→字节已用 / 0剩余→100%）', b1ok, JSON.stringify(b1));

  // ---------- C. 空列表 ----------
  const c1 = await ex(`(function(){
    renderAlPackage([]);
    var pane = document.getElementById('view-package').querySelector(':scope > .cloud-pane');
    var t = pane.querySelector('#alPkgBody').textContent;
    return { empty: t.indexOf('暂无资源包') >= 0, active: document.getElementById('alPkgActive').textContent };
  })()`);
  check('C2 空列表不崩：显示「暂无资源包」，汇总归 0', c1.empty && c1.active === '0 / 0', JSON.stringify(c1));

  // ---------- D. 未配置 AK 兜底 ----------
  const d1 = await ex(`(function(){
    state.cfg.aliId=''; state.cfg.aliKey='';
    refreshAlPackage();
    var pane = document.getElementById('view-package').querySelector(':scope > .cloud-pane');
    return { hint: pane.querySelector('#alPkgBody').textContent.indexOf('未配置阿里云 AccessKey') >= 0 };
  })()`);
  check('D1 未配置 AccessKey：表格提示去设置页配置', d1.hint, JSON.stringify(d1));

  // ---------- E. 真实 API 查询（用户已配置 AK 的场景）----------
  const e1 = await ex(`(function(){
    state.cfg.aliId='LTAI_E2E_TEST_ID'; state.cfg.aliKey='ALI_KEY_E2E_TEST_SECRET';   // 占位符：真实 AK 不入库（历史真机验证用例）
    refreshAlPackage();
    return 'querying';
  })()`);
  await new Promise(r => setTimeout(r, 6000));
  const e2 = await ex(`(function(){
    var pane = document.getElementById('view-package').querySelector(':scope > .cloud-pane');
    var rows = pane.querySelectorAll('#alPkgBody tr');
    var first = rows[0] ? rows[0].textContent.slice(0, 120) : '';
    return { rowCount: rows.length, statsShown: document.getElementById('alPkgStats').style.display === 'grid',
             active: document.getElementById('alPkgActive').textContent, err: first.indexOf('查询失败') >= 0 ? first : '' };
  })()`);
  check('E1 真实 BSS 查询：渲染 ≥1 行（用户账号实测 6 个流量包）', !e2.err && e2.rowCount >= 1 && e2.statsShown, JSON.stringify(e2));

  const pass = results.filter(r => r.ok).length;
  results.forEach(r => console.log((r.ok ? '✅ PASS' : '❌ FAIL') + ' | ' + r.name + (r.ok ? '' : ' | ' + r.detail)));
  console.log('===== ' + pass + '/' + results.length + ' passed =====');
  app.exit(pass === results.length ? 0 : 1);
}
app.whenReady().then(() => setTimeout(main, 600));
