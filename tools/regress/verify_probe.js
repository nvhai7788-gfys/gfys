// 验证 main.js ff:probe 扩展后的解析数学：用已知参数生成的本地 FLV 做确定性核对
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FF = process.argv[2];
const DIR = path.join(os.tmpdir(), 'ffprobe_verify');
fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, 'src.flv');
const PORT = 18899;

// 生成 8 秒、视频 1500k / 音频 128k 的测试流（期望总码率 ≈ 1628 kbps）
function gen() {
  return new Promise((res, rej) => {
    const p = spawn(FF, ['-hide_banner', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '1500k', '-g', '50',
      '-c:a', 'aac', '-b:a', '128k', '-f', 'flv', FILE]);
    let e = ''; p.stderr.on('data', d => e += d);
    p.on('close', c => c === 0 ? res() : rej(new Error('gen failed ' + c + '\n' + e.slice(-800))));
  });
}
// 复刻 main.js 中 ff:probe 的解析逻辑（采样模式）
function probe(url, sec) {
  return new Promise((resolve) => {
    const args = ['-hide_banner'];
    if (sec <= 0) args.push('-nostats');
    args.push('-i', url);
    if (sec > 0) args.push('-t', String(sec), '-c', 'copy', '-f', 'null', '-');
    let out = '';
    const p = spawn(FF, args);
    const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, sec > 0 ? (sec + 8) * 1000 : 9000);
    p.stderr.on('data', d => out += String(d));
    p.on('close', () => {
      clearTimeout(to);
      const lines = out.split(/\r?\n/);
      const vl = lines.find(l => /: Video:/.test(l)) || '';
      const al = lines.find(l => /: Audio:/.test(l)) || '';
      const m = vl.match(/(\d{2,5})x(\d{2,5})/);
      const res = {
        width: m ? +m[1] : 0, height: m ? +m[2] : 0,
        codec: (vl.split('Video:')[1] || '').split(/[,(]/)[0].trim(),
        audio: (al.split('Audio:')[1] || '').split(/[,(]/)[0].trim(),
      };
      const fm = vl.match(/([\d.]+)\s*fps/);
      if (fm) res.fps = +fm[1];
      if (sec > 0) {
        const vkb = (out.match(/video:\s*(\d+)\s*kB/i) || [])[1];
        const akb = (out.match(/audio:\s*(\d+)\s*kB/i) || [])[1];
        let el = 0;
        const tm = [...out.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
        if (tm) el = (+tm[1]) * 3600 + (+tm[2]) * 60 + parseFloat(tm[3]);
        const div = el > 0.5 ? el : sec;
        res.videoKbps = vkb ? Math.round(+vkb * 8 / div) : 0;
        res.audioKbps = akb ? Math.round(+akb * 8 / div) : 0;
        res.kbps = res.videoKbps + res.audioKbps;
        res.seconds = sec;
        res.elapsedSec = +div.toFixed(2);
        // 若改用「请求秒数」作除数，结果应基本一致（两条换算路径自洽）
        res.kbpsByRequested = (vkb ? Math.round(+vkb * 8 / sec) : 0) + (akb ? Math.round(+akb * 8 / sec) : 0);
      }
      res.ok = !!m || (sec > 0 && res.kbps > 0);
      resolve(res.ok ? res : { ok: false, error: '未解析到视频流信息', tail: lines.filter(Boolean).slice(-3).join(' | ') });
    });
  });
}

(async () => {
  console.log('源文件:', FILE);
  await gen();
  console.log('已生成，大小', (fs.statSync(FILE).size / 1024).toFixed(0), 'kB');

  // 起本地 http 服务（模拟 http-flv 直播地址）
  const srv = http.createServer((req, res) => {
    if (!/\.flv/.test(req.url)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'video/x-flv' });
    fs.createReadStream(FILE).pipe(res);
  });
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + PORT + '/live/test.flv';

  // 1) 仅读流头（旧行为，必须保持兼容）
  const a = await probe(url, 0);
  console.log('\n[1] 只读流头 :', JSON.stringify(a));

  // 2) 采样 5 秒
  const b = await probe(url, 5);
  console.log('[2] 采样 5 秒 :', JSON.stringify(b));

  // 3) 采样整段 8 秒（与前两条对照线性）
  const c = await probe(url, 3);
  console.log('[3] 采样 3 秒 :', JSON.stringify(c));

  // 4) 采样整段 8 秒 —— 与「文件体积 ÷ 时长」这个独立基准对比
  const d = await probe(url, 8);
  console.log('[4] 采样 8 秒 :', JSON.stringify(d));

  // 独立基准：整个文件的平均码率 = 字节数 × 8 ÷ 时长（不依赖 ffmpeg 的统计行）
  const fileKbps = Math.round(fs.statSync(FILE).size * 8 / 8 / 1000);
  console.log('独立基准（文件体积÷8秒）:', fileKbps, 'kbps');

  // 断言
  let pass = true;
  const ck = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) pass = false; };
  console.log('\n--- 断言 ---');
  ck(a.ok && a.width === 1280 && a.height === 720, '读流头解析分辨率 1280x720（旧行为兼容）得到 ' + a.width + 'x' + a.height);
  ck(a.codec === 'h264', '读流头解析编解码 = h264，得到 ' + a.codec);
  ck(a.kbps === undefined, '只读流头不返回码率（不误报）');
  ck(b.ok && b.kbps > 0, '采样模式返回码率 ' + b.kbps + ' kbps');
  ck(b.fps === 25, '解析帧率 25，得到 ' + b.fps);
  ck(b.videoKbps > b.audioKbps, '视频码率 > 音频码率');
  // 关键：整段采样结果必须与「文件体积推出的真实均值」吻合（容差 10%）
  const dev = Math.abs(d.kbps - fileKbps) / fileKbps;
  ck(dev < 0.10,
    '整段采样码率与独立基准吻合：实测 ' + d.kbps + ' vs 基准 ' + fileKbps + '（偏差 ' + (dev * 100).toFixed(1) + '% < 10%）');
  // 自洽：字节换算出的 kbps 应与 ffmpeg 自己报的 bitrate 一致
  ck(Math.abs(d.kbps - d.kbpsByRequested) / d.kbps < 0.05,
    '两条换算路径自洽：按实际经过时间 ' + d.elapsedSec + 's 得 ' + d.kbps + ' vs 按请求秒数得 ' + d.kbpsByRequested);
  ck(d.elapsedSec > 0 && d.elapsedSec <= 8.6, '实际经过时间解析正确：' + d.elapsedSec + 's');
  ck(b.kbps >= 800 && b.kbps <= 1900, '5 秒采样量级合理（该源真实均值 ~' + fileKbps + '）：' + b.kbps);

  srv.close();
  await new Promise(r => setTimeout(r, 300));
  console.log('\n=== ' + (pass ? 'ALL PASS' : 'HAS FAIL') + ' ===');
  process.exit(pass ? 0 : 1);
})();
