const fs=require('fs');const {JSDOM,VirtualConsole}=require('jsdom');
const ROOT='/Users/dengychen/WorkBuddy/2026-09-26-11-28-19/tencent-live-workbench';
const html=fs.readFileSync(ROOT+'/renderer/preview.html','utf8');
const results=[];const check=(n,ok,d)=>{results.push(ok);console.log((ok?'PASS ':'FAIL ')+n+(ok?'':'  -> '+d));};
const vc=new VirtualConsole();vc.on('jsdomError',e=>console.log('  [jsdomError]',e.message));
const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://localhost/',pretendToBeVisual:true,virtualConsole:vc,
  beforeParse(w){w.mpegts={};w.Hls=function(){};w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});}});
const w=dom.window,doc=w.document,ex=js=>w.eval(js),wait=ms=>new Promise(r=>setTimeout(r,ms));
const wd=setTimeout(()=>{console.log('[WATCHDOG]');process.exit(3);},20000);
let ran=false;w.addEventListener('load',run);setTimeout(()=>{if(!ran)run();},500);
async function run(){if(ran)return;ran=true;
 try{
  await wait(300);
  check('P1 状态栏 pstats 存在',!!doc.getElementById('pstats'));
  check('P2 分辨率/帧率/协议/尺寸比 四格齐全',
    !!doc.getElementById('stRes')&&!!doc.getElementById('stFps')&&!!doc.getElementById('stProto')&&!!doc.getElementById('stRatio'));
  // 注入假视频并调用 updateResStats
  ex("window.v={videoWidth:1920,videoHeight:1080}; if(typeof updateResStats==='function') updateResStats();");
  await wait(20);
  check('P3 分辨率显示 1920×1080',doc.getElementById('stRes').textContent==='1920×1080', doc.getElementById('stRes').textContent);
  check('P4 尺寸比显示 16:9',doc.getElementById('stRatio').textContent==='16:9', doc.getElementById('stRatio').textContent);
  // 竖屏
  ex("window.v={videoWidth:1080,videoHeight:1920}; updateResStats();");
  await wait(20);
  check('P5 竖屏 1080×1920 → 9:16',doc.getElementById('stRatio').textContent==='9:16' && doc.getElementById('stRes').textContent==='1080×1920');
 }catch(e){check('Px 异常',false,(e&&e.stack)||String(e));}
 clearTimeout(wd);const pass=results.filter(Boolean).length;
 console.log('\n======== preview e2e 汇总 ========\n通过 '+pass+' / '+results.length);
 process.exit(pass===results.length?0:1);
}
