// E2E r60：六项改动的确定性回归（纯页面内断言，不依赖真实云端 / 真实推流）
//  1) 日间 / 夜间主题（跟随系统 + 手动切换 + 图表配色跟随）
//  2) 菜单导航字号与侧栏宽度
//  3) 定时任务 / 录播管理已彻底删除（视图 / 导航 / 桥接 / i18n 均无残留）
//  4) 实时预览刷新到在线流后自动播放（含防重连、断流外部流不拉、开关关闭）
//  5) 地址生成 / 拉流转推等页面统一横版表单
//  6) 登录页管理员 / 普通用户身份 → 角色与菜单可见性差异 + 管理员口令
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..', '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '✅ ' : '❌ ') + name + (ok ? '' : '  → ' + (detail || '')));   // 实时打印，便于中途失败定位
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  const ex = (js) => win.webContents.executeJavaScript(js);
  await wait(400);
  await ex("localStorage.clear(); (function(){ state.cfg={}; })(); 'ok'");

  // ---------- 1. 主题：日间 / 夜间 ----------
  const t1 = await ex(`(function(){
    state.cfg.theme = 'dark'; applyTheme();
    var dark = { attr: document.documentElement.getAttribute('data-theme'),
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      text: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() };
    state.cfg.theme = 'light'; applyTheme();
    var light = { attr: document.documentElement.getAttribute('data-theme'),
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      text: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() };
    return { dark: dark, light: light, chartDark: (state.cfg.theme='dark', chartTheme()),
      chartLight: (state.cfg.theme='light', chartTheme()),
      lbl: [themeLabel('system'), themeLabel('light'), themeLabel('dark')],
      resolvedSys: (state.cfg.theme='system', resolvedTheme()) };
  })()`);
  check('T1 日间/夜间主题：data-theme 切换 + --bg/--text 变量实际改变 + 图表配色跟随',
    t1.dark.attr === 'dark' && t1.light.attr === 'light' &&
    t1.dark.bg !== t1.light.bg && t1.dark.text !== t1.light.text &&
    t1.chartDark === 'dark' && t1.chartLight === 'light' &&
    t1.lbl.join('/') === '跟随系统/日间/夜间' && (t1.resolvedSys === 'light' || t1.resolvedSys === 'dark'),
    JSON.stringify(t1));

  const t2 = await ex(`(function(){
    state.cfg.theme = 'system'; cycleTheme();
    var a = state.cfg.theme; cycleTheme();
    var b = state.cfg.theme; cycleTheme();
    var c = state.cfg.theme;
    return { seq: [a, b, c], btn: document.getElementById('themeBtn').textContent,
      sel: document.getElementById('stTheme').value };
  })()`);
  check('T1b 顶栏按钮循环切换 system→light→dark→system，设置页下拉同步',
    t2.seq.join(',') === 'light,dark,system' && t2.sel === 'system' && t2.btn.length > 0,
    JSON.stringify(t2));

  // ---------- 2. 导航字号 / 侧栏宽度 ----------
  const n1 = await ex(`(function(){
    var item = document.querySelector('.nav-item');
    var cs = getComputedStyle(item);
    var sb = document.querySelector('.sidebar');
    var span = item.querySelector('span');
    var scs = span ? getComputedStyle(span) : null;
    return { fs: parseFloat(cs.fontSize), pad: cs.padding, sw: sb ? Math.round(parseFloat(getComputedStyle(sb).width)) : 0,
      inlineW: sb ? (sb.getAttribute('style') || '') : '', ellipsis: scs ? scs.textOverflow : '' };
  })()`);
  check('T2 导航字号 ≥14.5px（r60 定 14.5，r62 加大为 15.5）/ 侧栏 212px / 长菜单名省略号不撑宽 / 无内联宽度覆盖',
    n1.fs >= 14.5 && n1.fs <= 16.5 && n1.sw === 212 && n1.ellipsis === 'ellipsis' && !/width\s*:/.test(n1.inlineW),
    JSON.stringify(n1));

  // ---------- 3. 定时任务 / 录播管理已删除 ----------
  const d1 = await ex(`(function(){
    var views = [].map.call(document.querySelectorAll('.view'), function (v) { return v.id; });
    var navs = [].map.call(document.querySelectorAll('.nav-item'), function (b) { return b.dataset.view; });
    var i18nKeys = Object.keys((window.I18N && window.I18N.zh) || {});
    return {
      hasSchedView: views.indexOf('view-sched') !== -1,
      hasRecordsView: views.indexOf('view-records') !== -1,
      navSched: navs.indexOf('sched'), navRecords: navs.indexOf('records'),
      bridge: typeof (window.tcapi && window.tcapi.schedList),
      fnRenderSched: typeof window.renderSched,
      fnFillRecordDefaults: typeof window.fillRecordDefaults,
      i18n: i18nKeys.filter(function (k) { return /^\\w+\\.(sched|records)$/.test(k) || k === 'sched' || k === 'records'; }),
      perms: (function () {
        var all = [];
        for (var r in window.ROLE_PERMS) all = all.concat(window.ROLE_PERMS[r]);
        return all.filter(function (v) { return v === 'sched' || v === 'records'; });
      })()
    };
  })()`);
  check('T3 定时任务/录播管理三层清除：视图、导航、tcapi 桥接、JS 函数、i18n 词条、角色权限清单均无残留',
    !d1.hasSchedView && !d1.hasRecordsView && d1.navSched === -1 && d1.navRecords === -1 &&
    d1.bridge === 'undefined' && d1.fnRenderSched === 'undefined' && d1.fnFillRecordDefaults === 'undefined' &&
    d1.i18n.length === 0 && d1.perms.length === 0, JSON.stringify(d1));

  // ---------- 4. 实时预览自动播放 ----------
  const p1a = await ex(`(function(){
    var calls = [];
    window.__orig = window.watchStartPlay;
    window.watchStartPlay = function (k) { calls.push(k); };
    window.__calls = calls;
    window._watchPlayers = {
      a: { live: true, s: { _prov: 'tencent' } },
      b: { live: true, s: { _prov: 'tencent' } },
      c: { live: true, s: { _prov: 'external', _extDown: true } },
      d: { live: false, s: { _prov: 'tencent' } }
    };
    document.getElementById('view-watch').classList.add('active');
    state.cfg.watchAutoPlay = true;
    watchAutoPlayAll();                       // 起播错峰（每路 350ms），需等落地
    return { startedA: !!window._watchPlayers.a.started, startedC: !!window._watchPlayers.c.started };
  })()`);
  await wait(1500);
  const p1b = await ex(`(function(){
    var first = window.__calls.slice();
    watchAutoPlayAll();                       // 第二次：不应重复起播（防重连）
    return { first: first };
  })()`);
  await wait(1200);
  const p1c = await ex(`(function(){
    var second = window.__calls.slice();
    window.watchStartPlay = window.__orig;    // 恢复真实实现
    return { second: second };
  })()`);
  const p1 = { first: p1b.first, second: p1c.second, startedA: p1a.startedA, startedC: p1a.startedC };
  check('T4 自动播放：刷新的在线流自动起播、已断流外部流不拉、不在线不拉、二次调用不重连',
    p1.first.length === 2 && p1.first.join(',') === 'a,b' &&
    p1.second.length === 2 && p1.startedA && !p1.startedC, JSON.stringify(p1));

  const p2 = await ex(`(function(){
    var calls = [];
    var orig = window.watchStartPlay;
    window.watchStartPlay = function (k) { calls.push(k); };
    window._watchPlayers = { x: { live: true, s: { _prov: 'tencent' } } };
    state.cfg.watchAutoPlay = false;
    watchAutoPlayAll();
    var off = calls.length;
    document.getElementById('view-watch').classList.remove('active');
    state.cfg.watchAutoPlay = true;
    watchAutoPlayAll();
    var hidden = calls.length;
    window.watchStartPlay = orig;
    return { off: off, hidden: hidden };
  })()`);
  check('T4b 自动播放开关关闭 / 页面不可见时都不起播',
    p2.off === 0 && p2.hidden === 0, JSON.stringify(p2));

  const p3 = await ex(`(function(){
    var el = document.getElementById('watchAutoPlay');
    return { exists: !!el, type: el ? el.type : '', checked: el ? el.checked : false };
  })()`);
  check('T4c 工具栏「自动播放」开关存在且默认开启',
    p3.exists && p3.type === 'checkbox' && p3.checked === true, JSON.stringify(p3));

  // ---------- 5. 横版表单 ----------
  // r61 起布局升级为 grid（label 右列对齐 + 控件同行占满），固定 116px 宽的断言由 r61 B1 接管；
  // 这里只保留「四页都应用了 .form-h 且是 grid 横版」的轻断言
  const f1 = await ex(`(function(){
    var cards = [].slice.call(document.querySelectorAll('.card.form-h'));
    var views = cards.map(function (c) { return c.closest('.view') ? c.closest('.view').id : ''; });
    var grids = cards.every(function (c) { return getComputedStyle(c).display === 'grid'; });
    return { count: cards.length, views: views.join(','), grids: grids };
  })()`);
  check('T5 横版表单：地址生成 / 拉流转推等页面应用 .form-h（r61 起为 grid 横版，同行断言见 r61 B1）',
    f1.count >= 4 && f1.grids && /view-genaddr/.test(f1.views) && /view-relay/.test(f1.views),
    JSON.stringify(f1));

  // ---------- 6. 登录身份权限 ----------
  const r1 = await ex(`(function(){
    state.cfg = { secretId: 'x', secretKey: 'y' };   // 单用户模式
    state.cfg.loginRole = 'admin';
    var adminRole = curRole();
    var adminCanSettings = canAccessView('settings');
    var adminCanRelay = canAccessView('relay');
    var adminNavs = [].filter.call(document.querySelectorAll('.nav-item'), function (b) { return canAccessView(b.dataset.view); }).length;
    applyPermissions();
    var adminVisible = [].filter.call(document.querySelectorAll('.nav-item'), function (b) { return b.style.display !== 'none'; }).length;

    state.cfg.loginRole = 'user';
    var userRole = curRole();
    var userCanSettings = canAccessView('settings');
    var userCanRelay = canAccessView('relay');
    var userCanWatch = canAccessView('watch');
    applyPermissions();
    var userVisible = [].filter.call(document.querySelectorAll('.nav-item'), function (b) { return b.style.display !== 'none'; }).length;
    return { adminRole: adminRole, userRole: userRole,
      adminCanSettings: adminCanSettings, adminCanRelay: adminCanRelay,
      userCanSettings: userCanSettings, userCanRelay: userCanRelay, userCanWatch: userCanWatch,
      adminVisible: adminVisible, userVisible: userVisible,
      adminText: (state.cfg.loginRole = 'admin', curRoleText()),
      userText: (state.cfg.loginRole = 'user', curRoleText()) };
  })()`);
  check('T6 登录身份 → 角色：管理员全可见，普通用户看不到设置/拉流转推等，仅保留只读页',
    r1.adminRole === 'admin' && r1.userRole === 'viewer' &&
    r1.adminCanSettings === true && r1.adminCanRelay === true &&
    r1.userCanSettings === false && r1.userCanRelay === false && r1.userCanWatch === true &&
    r1.adminVisible > r1.userVisible && r1.userVisible > 0 &&
    r1.adminText === '管理员' && r1.userText === '只读', JSON.stringify(r1));

  const r2 = await ex(`(function(){
    delete state.cfg.adminPass;
    var noPassEmpty = lgCheckAdminPass('');            // 未设口令 + 空输入 → 拒绝并提示设置
    var first = lgCheckAdminPass('abcd');              // 首次输入即设为口令
    var wrong = lgCheckAdminPass('xxxx');              // 错误口令
    var right = lgCheckAdminPass('abcd');              // 正确口令
    var has = !!lgAdminPassGet();
    return { noPassEmpty: noPassEmpty, first: first, wrong: wrong, right: right, has: has,
      tipAdmin: LG_ROLE_TIP.admin.length > 0, tipUser: LG_ROLE_TIP.user.length > 0 };
  })()`);
  check('T6b 管理员口令：未设置时提示设置 → 首次输入即设置 → 错误拒绝 → 正确通过',
    r2.noPassEmpty.ok === false && /请设置管理员口令/.test(r2.noPassEmpty.err) &&
    r2.first.ok === true && r2.first.first === true &&
    r2.wrong.ok === false && r2.right.ok === true && r2.right.first === false &&
    r2.has && r2.tipAdmin && r2.tipUser, JSON.stringify(r2));

  const r3 = await ex(`(function(){
    var seg = document.getElementById('lgRoleSeg');
    var btns = seg.querySelectorAll('button[data-role]');
    var roles = [].map.call(btns, function (b) { return b.dataset.role; });
    btns[1].click();                                   // 切到普通用户
    var afterUser = state.cfg.loginRole;
    var wrapUser = document.getElementById('lgAdminWrap').style.display;
    btns[0].click();                                   // 切回管理员
    var afterAdmin = state.cfg.loginRole;
    var wrapAdmin = document.getElementById('lgAdminWrap').style.display;
    return { roles: roles, afterUser: afterUser, wrapUser: wrapUser, afterAdmin: afterAdmin, wrapAdmin: wrapAdmin,
      tip: document.getElementById('lgRoleTip').textContent.length > 0 };
  })()`);
  check('T6c 登录页身份分段控件：切换写入配置、口令框随身份显隐、提示文案更新',
    r3.roles.join(',') === 'admin,user' && r3.afterUser === 'user' && r3.wrapUser === 'none' &&
    r3.afterAdmin === 'admin' && r3.wrapAdmin !== 'none' && r3.tip, JSON.stringify(r3));

  const r4 = await ex(`(function(){
    // 多用户模式优先于登录页身份
    state.cfg.users = [{ name: 'lisi', pass: '1', role: 'operator', enabled: true }];
    state.cfg.currentUser = 'lisi';
    state.cfg.loginRole = 'admin';
    var byUser = curRole();
    state.cfg.currentUser = '';
    var noLogin = curRole();
    var noLoginAccess = canAccessView('overview');
    state.cfg.users = [];
    state.cfg.loginRole = 'admin';
    var backToLogin = curRole();
    return { byUser: byUser, noLogin: noLogin, noLoginAccess: noLoginAccess, backToLogin: backToLogin,
      name: curUserName() };
  })()`);
  check('T6d 多用户账号角色优先于登录身份；多用户未登录时无任何权限',
    r4.byUser === 'operator' && r4.noLogin === '' && r4.noLoginAccess === false &&
    r4.backToLogin === 'admin', JSON.stringify(r4));

  const r5 = await ex(`(function(){
    var b1 = document.getElementById('usAdminPassBtn');
    var b2 = document.getElementById('usAdminClearBtn');
    var m = document.getElementById('usAdminPassMsg');
    delete state.cfg.adminPass;
    document.getElementById('usAdminPass1').value = 'ab';
    document.getElementById('usAdminPass2').value = 'ab';
    b1.click();
    var tooShort = m.textContent;
    document.getElementById('usAdminPass1').value = 'secret99';
    document.getElementById('usAdminPass2').value = 'secret98';
    b1.click();
    var mismatch = m.textContent;
    document.getElementById('usAdminPass1').value = 'secret99';
    document.getElementById('usAdminPass2').value = 'secret99';
    b1.click();
    var okMsg = m.textContent;
    var saved = lgAdminPassGet();
    var origConfirm = window.confirm;
    window.confirm = function () { return false; };      // 取消 → 不清除
    b2.click();
    var keepAfterCancel = !!lgAdminPassGet();
    window.confirm = function () { return true; };       // 确认 → 清除
    b2.click();
    var clearedAfterOk = !lgAdminPassGet();
    var clearMsg = m.textContent;
    window.confirm = origConfirm;
    return { tooShort: tooShort, mismatch: mismatch, okMsg: okMsg, saved: saved,
      keepAfterCancel: keepAfterCancel, clearedAfterOk: clearedAfterOk, clearMsg: clearMsg,
      exists: !!b1 && !!b2 };
  })()`);
  check('T6e 设置页管理员口令修改：过短拒绝 / 两次不一致拒绝 / 一致写入 / 取消不清除 / 确认后清除',
    r5.exists && /至少 4 位/.test(r5.tooShort) && /不一致/.test(r5.mismatch) &&
    /已保存/.test(r5.okMsg) && r5.saved === 'secret99' &&
    r5.keepAfterCancel === true && r5.clearedAfterOk === true && /清除/.test(r5.clearMsg),
    JSON.stringify(r5));

  // ---------- 汇总 ----------
  const pass = results.filter(r => r.ok).length;
  console.log('──────────────────────────────────────────');
  console.log('r60 汇总：' + pass + '/' + results.length + ' passed');
  console.log(pass === results.length ? 'R60 ALL PASS' : 'R60 HAS FAILURE');
  app.exit(0);
}
app.whenReady().then(main).catch(e => { console.error('运行异常：', e); app.exit(2); });
