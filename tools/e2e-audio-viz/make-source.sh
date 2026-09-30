#!/usr/bin/env bash
# 生成音频可视化实测素材 tone.flv：12 秒 320x180@25 + 440Hz 正弦音轨（AAC 128k/44.1k）
# 用法：bash tools/e2e-audio-viz/make-source.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/tone.flv"
[ -f "$OUT" ] && { echo "已存在，跳过：$OUT"; exit 0; }
FF="$(command -v ffmpeg || true)"
[ -z "$FF" ] && [ -x "$DIR/../../bin/ffmpeg-darwin-arm64" ] && FF="$DIR/../../bin/ffmpeg-darwin-arm64"
[ -z "$FF" ] && { echo "找不到 ffmpeg"; exit 1; }
"$FF" -f lavfi -i "sine=frequency=440:duration=12" \
      -f lavfi -i "testsrc=size=320x180:rate=25:duration=12" \
      -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
      -c:a aac -b:a 128k -ar 44100 -f flv -y "$OUT"
echo "已生成 $OUT ($(du -h "$OUT" | cut -f1))"
