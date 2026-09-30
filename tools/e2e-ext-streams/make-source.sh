#!/usr/bin/env bash
# 生成外部地址流 E2E 用的本地 HTTP-FLV 测试素材（25 秒 1280x720@25，约 4.6MB，≈1.5 Mbps）
# 用法：bash tools/e2e-ext-streams/make-source.sh
# 说明：素材需与 harness 的限速下行（≈2080 kbps）配合 —— 限速让「FLV 下行字节数 → kbps」可稳定观测。
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/src.flv"

if [ -f "$OUT" ]; then
  echo "已存在，跳过：$OUT ($(du -h "$OUT" | cut -f1))"
  exit 0
fi

FFMPEG="$(command -v ffmpeg || true)"
if [ -z "$FFMPEG" ]; then
  # 回退到应用内置 ffmpeg（各平台二进制名不同）
  for c in "$DIR/../../bin/ffmpeg-darwin-arm64" \
           "$DIR/../../bin/ffmpeg-darwin-x64" \
           "$DIR/../../bin/ffmpeg-win32-x64.exe"; do
    [ -x "$c" ] && FFMPEG="$c" && break
  done
fi
if [ -z "$FFMPEG" ]; then
  echo "找不到 ffmpeg：请先安装（brew install ffmpeg），或确认 bin/ 下内置 ffmpeg 存在" >&2
  exit 1
fi

echo "使用 ffmpeg：$FFMPEG"
"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=25:duration=25" \
  -f lavfi -i "sine=frequency=1000:sample_rate=44100:duration=25" \
  -c:v libx264 -preset veryfast -b:v 1500k -pix_fmt yuv420p -g 50 \
  -c:a aac -b:a 128k -f flv "$OUT"

echo "已生成：$OUT ($(du -h "$OUT" | cut -f1))"
