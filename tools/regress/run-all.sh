#!/usr/bin/env bash
# 历史回归套件一键执行（r40 ~ r57 的确定性 E2E + 静态校验）
#
# 用法：
#   cd <项目根> && bash tools/regress/run-all.sh            # 跑全部
#   cd <项目根> && bash tools/regress/run-all.sh r54 r57b    # 只跑指定轮次
#
# 为什么需要它：这些脚本此前只存在于 /tmp，重启即丢。它们编码了 40~57 轮 bug 修复的
# 回归知识（阿里云播放域名串域、鉴权 Key 候选、看门狗、flv 字节统计、BSS 单位换算…），
# 每次改到预览观看 / 在线流 / 质量 / 带宽 / 播放候选相关代码都应先跑一遍。
#
# 依赖与坑：
#   * 必须清掉会话注入的 NODE_OPTIONS（broker fs shim 会破坏 electron）与 ELECTRON_RUN_AS_NODE，
#     并允许非沙箱：env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1
#   * 脚本内的 ROOT 常量硬编码为本项目路径；换目录 / 换机器需同步修改。
#   * 判定口径：每个脚本自己打印汇总，本 runner 按「❌ / FAIL」出现次数判定，不凭末行。
#
# 已知恒定失败（不是产品缺陷，别重复排查）——均已在 v1.1.16 打包产物上 A/B 复现，与后续改动无关：
#   e2e_r53.js 的 E1「真实 BSS 查询」恒定 FAIL —— 该脚本自建 main 进程，从未注册 main.js 的
#   `ac:call` IPC handler，也没有真实凭据/网络，故该断言在 mock harness 中必然报
#   "No handler registered for 'ac:call'"。已用 v1.1.13 打包产物里的渲染器做 A/B 复现同一条报错
#   （同为 4/5）。其余 4 项（A1/B1/C2/D1）是有效覆盖。
#   e2e_r41.js 的 B3「cn 流响应缺字段时从 PublishUrl 兜底」恒定 FAIL —— 基线 v1.1.16 同为 15/16，
#   同一条断言同一份 detail（r2pd 为空）。
#   e2e_r42.js 恒定 4/9 —— 基线 v1.1.16 同为 4/9，失败项完全一致（A2/B1/B2/C1/C2）。
#   e2e_r57.js 在本 runner 下「无判定输出」—— 基线 v1.1.16 同样无输出。该脚本需配合
#   tools/e2e-ext-streams/ 的自建 main 进程运行，单跑请用那个入口。
#   A/B 复现方法：asar extract dist/mac-arm64/*.app/Contents/Resources/app.asar /tmp/ab<版本>，
#   再把脚本里的 ROOT 常量 sed 成该目录即可用旧渲染器跑新脚本。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
ELECTRON="$ROOT/node_modules/.bin/electron"
# r70：本环境（macOS + 受限沙箱）必须用这两个开关，否则 Electron 起不来：
#   Failed to initialize sandbox → GPU process isn't usable. Goodbye.
# 原脚本只设了 ELECTRON_DISABLE_SANDBOX=1，实测无效，整套脚本会卡死不返回。
ELECTRON_FLAGS="--no-sandbox --disable-gpu"
# 单个脚本的超时秒数：老脚本（r40~r57）里有若干在本环境跑不完，
# 没有超时就会把整轮回归永久挂住（此前实测 19 分钟无任何输出）。
SCRIPT_TIMEOUT="${SCRIPT_TIMEOUT:-90}"

if [ ! -x "$ELECTRON" ]; then echo "找不到 electron：$ELECTRON（先在项目根 npm install）" >&2; exit 1; fi

if [ "$#" -gt 0 ]; then
  FILES=(); for n in "$@"; do FILES+=("$DIR/e2e_${n#e2e_}.js"); done
else
  # 仅跑 electron 套件（r40~r69 等自建 main 进程的脚本）。
  # jsdom 套件（*_jsdom.js，r71~r75）用 `node` 跑，不能交给 electron，单独执行：
  #   cd <项目根> && NODE_PATH=$PWD/../node_modules node tools/regress/e2e_r75_v1136_jsdom.js
  FILES=()
  for f in "$DIR"/e2e_r*.js; do
    case "$f" in *_jsdom.js) ;; *) FILES+=("$f") ;; esac
  done
fi

pass=0; fail=0; failed_list=()
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "跳过（不存在）：$f"; continue; }
  name="$(basename "$f" .js)"
  # 带超时执行：macOS 无 timeout 命令，用后台进程 + sleep 看门狗实现
  tmpout="$(mktemp)"
  ( cd "$ROOT" && env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1 \
      "$ELECTRON" "$f" $ELECTRON_FLAGS > "$tmpout" 2>&1 ) &
  pid=$!
  ( sleep "$SCRIPT_TIMEOUT"; kill -9 "$pid" 2>/dev/null ) &
  killer=$!
  wait "$pid" 2>/dev/null
  kill -9 "$killer" 2>/dev/null
  wait "$killer" 2>/dev/null
  out="$(cat "$tmpout")"
  rm -f "$tmpout"
  ok="$(printf '%s' "$out" | grep -cE '✅|PASS')"
  bad="$(printf '%s' "$out" | grep -cE '❌|FAIL')"
  sum="$(printf '%s' "$out" | grep -E 'passed|PASS|汇总' | tail -1)"
  if [ "$ok" = "0" ] && [ "$bad" = "0" ]; then
    printf '%-16s ⚠ 无判定输出（脚本未跑完 / 超时 %ss / 未启动）\n' "$name" "$SCRIPT_TIMEOUT"; fail=$((fail+1)); failed_list+=("$name:无输出")
  elif [ "$bad" != "0" ]; then
    printf '%-16s ❌ ok=%s bad=%s  %s\n' "$name" "$ok" "$bad" "$sum"
    printf '%s\n' "$out" | grep -E '❌|FAIL' | head -3 | sed 's/^/                  /'
    fail=$((fail+1)); failed_list+=("$name")
  else
    printf '%-16s ✅ ok=%s bad=0  %s\n' "$name" "$ok" "$sum"; pass=$((pass+1))
  fi
done

echo "──────────────────────────────────────────"
echo "回归结果：通过 $pass 个脚本，失败 $fail 个"
[ "$fail" != "0" ] && printf '失败清单：%s\n' "${failed_list[*]}"
[ "$fail" = "0" ] && echo "ALL SCRIPTS PASS（注意：e2e_r53 的 E1 为已知恒定失败，见本脚本头部说明）"
exit 0
