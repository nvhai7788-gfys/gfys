#!/bin/bash
# 用真实 ffmpeg 校验 compileSceneGraph 产出的 filter_complex 语法
# 绕开 Node spawnSync（沙箱会 EBUSY），改用 shell 直接调用 ffmpeg
set -u
SRC="$(cd "$(dirname "$0")/../.." && pwd)"

# ffmpeg 自动发现：优先环境变量 FFMPEG，其次 PATH，再次工作区 .tools/ffmpeg[.exe]
if [ -z "${FFMPEG:-}" ]; then
  if command -v ffmpeg >/dev/null 2>&1; then
    FFMPEG="ffmpeg"
  else
    for cand in \
      "$SRC/../../.tools/ffmpeg.exe" \
      "$SRC/../../.tools/ffmpeg" \
      "$SRC/tools/bin/ffmpeg.exe" \
      "$SRC/tools/bin/ffmpeg"; do
      if [ -x "$cand" ] || [ -f "$cand" ]; then FFMPEG="$cand"; break; fi
    done
  fi
fi
FF="${FFMPEG:-ffmpeg}"
NODE="${NODE:-node}"

if ! "$FF" -version >/dev/null 2>&1; then
  echo "跳过：未找到可用的 ffmpeg（设置环境变量 FFMPEG=/path/to/ffmpeg 后重试）"
  exit 0
fi

PASS=0; FAIL=0
run_case() {
  local name="$1" graph="$2" ninputs="$3"
  local args=(-hide_banner -loglevel error)
  args+=(-f lavfi -i "testsrc=size=1920x1080:rate=25:duration=1")
  local i=1
  while [ "$i" -lt "$ninputs" ]; do
    args+=(-f lavfi -i "testsrc=size=640x360:rate=25:duration=1")
    i=$((i+1))
  done
  args+=(-filter_complex "$graph" -map "[vout]" -t 1 -f null -)
  if "$FF" "${args[@]}" >/dev/null 2>/tmp/ff_err.txt; then
    echo "  OK   $name"; PASS=$((PASS+1))
  else
    echo "  FAIL $name"; sed -n '1,4p' /tmp/ff_err.txt | sed 's/^/       /'; FAIL=$((FAIL+1))
  fi
}

# 纯文字场景走 -vf（非 complex），单独用 -vf 方式校验
run_case_vf() {
  local name="$1" vf="$2"
  if "$FF" -hide_banner -loglevel error -f lavfi -i "testsrc=size=1280x720:rate=25:duration=1" \
       -vf "$vf" -t 1 -f null - >/dev/null 2>/tmp/ff_err.txt; then
    echo "  OK   $name"; PASS=$((PASS+1))
  else
    echo "  FAIL $name"; sed -n '1,4p' /tmp/ff_err.txt | sed 's/^/       /'; FAIL=$((FAIL+1))
  fi
}

echo "=== 滤镜图真实语法校验（ffmpeg） ==="

# 逐个生成滤镜图（Node 只做字符串生成，不做 spawn）
# 注意：node -e 时 process.argv = [node, o, s, m, src]，索引从 1 开始
gen() {
  "$NODE" -e "
    const path = require('path');
    const { compileSceneGraph } = require(path.resolve(process.argv[4], 'ffmpeg-args.js'));
    const o = JSON.parse(process.argv[1]);
    const s = JSON.parse(process.argv[2]);
    const m = JSON.parse(process.argv[3]);
    process.stdout.write(compileSceneGraph(o, s, m).complex);
  " "$1" "$2" "$3" "$SRC"
}

# 生成 -vf 路径（纯文字场景 compileSceneGraph 返回 plain.vf）
gen_vf() {
  "$NODE" -e "
    const path = require('path');
    const { compileSceneGraph } = require(path.resolve(process.argv[4], 'ffmpeg-args.js'));
    const o = JSON.parse(process.argv[1]);
    const s = JSON.parse(process.argv[2]);
    const m = JSON.parse(process.argv[3]);
    const r = compileSceneGraph(o, s, m);
    process.stdout.write((r.plain && r.plain.vf) || r.complex || '');
  " "$1" "$2" "$3" "$SRC"
}

C1=$(gen '{"outSize":"1920x1080"}' '[{"id":"m1","type":"ffmpeg_source","enabled":true,"settings":{"local_file":"x.mp4"},"transform":{"x":"20","y":"30","scale":{"x":0.5,"y":0.5}}}]' '{"m1":1}')
run_case "媒体源叠加（含缩放）" "$C1" 2

C2=$(gen '{"outSize":"1920x1080"}' '[{"id":"c1","type":"color_source","enabled":true,"settings":{"color":"#ff0000"},"transform":{"x":"0","y":"0"}}]' '{}')
run_case "色源整屏铺底" "$C2" 1

C3=$(gen '{"outSize":"1280x720"}' '[{"id":"d1","type":"av_capture_input","enabled":true,"settings":{"device":"0"},"transform":{"x":"10","y":"10"}},{"id":"i1","type":"image_source","enabled":true,"settings":{"file":"logo.png"},"transform":{"x":"W-w-10","y":"10"}},{"id":"t1","type":"text_ft2_source","enabled":true,"settings":{"text":"LIVE","color":"#ffffff"},"transform":{"x":"20","y":"20"}}]' '{"d1":1,"i1":2}')
run_case "摄像头+图片+文字 三源叠加" "$C3" 3

C4=$(gen '{"outSize":"1920x1080"}' '[{"id":"s1","type":"monitor_capture","enabled":true,"settings":{"monitor":"0"},"transform":{"x":"0","y":"0"}},{"id":"c1","type":"color_source","enabled":true,"settings":{"color":"0x0000ff"},"transform":{"x":"100","y":"100"}},{"id":"m1","type":"ffmpeg_source","enabled":true,"settings":{"local_file":"v.mp4"},"transform":{"x":"200","y":"200","scale":{"x":0.25,"y":0.25}}}]' '{"s1":1,"m1":2}')
run_case "显示器+色源+媒体源 混合" "$C4" 3

C5=$(gen '{"outSize":"1080x1920","inW":1920,"inH":1080}' '[{"id":"d1","type":"av_capture_input","enabled":true,"settings":{"device":"0"},"transform":{"x":"0","y":"0"}}]' '{"d1":1}')
run_case "竖屏画布 + 摄像头" "$C5" 2

C6=$(gen_vf '{"outSize":"1280x720"}' '[{"id":"t1","type":"text_ft2_source","enabled":true,"settings":{"text":"港丰影视","font_size":64,"color":"#ffcc00"},"transform":{"x":"20","y":"30"}}]' '{}')
run_case_vf "纯文字源（中文字形，走 -vf drawtext）" "$C6"

echo
echo "滤镜图语法校验: $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ]
