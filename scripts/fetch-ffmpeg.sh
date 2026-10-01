#!/usr/bin/env bash
# fetch-ffmpeg.sh —— 下载内置 ffmpeg 静态二进制到 src/bin/，供 electron-builder extraResources 打包。
# 平台感知：Windows 下载 gyan 静态构建（ffmpeg.exe）；macOS 从 Homebrew 复制本机 ffmpeg（arch 匹配 runner）。
#
# 用法（在项目根 src/ 下执行）：
#   bash scripts/fetch-ffmpeg.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$SRC/bin"
mkdir -p "$BIN"

UNAME="$(uname -s)"
case "$UNAME" in
  Darwin)
    # 目标架构：优先 ARCH 环境变量（workflow 传 matrix.arch），缺省用 uname -m
    TARGET="${ARCH:-$(uname -m)}"
    [ "$TARGET" = "x86_64" ] && TARGET="x64"
    if [ "$TARGET" = "x64" ]; then
      # x64（原生 Intel 或 arm64 runner 交叉编译）：evermeet.cx 提供 x64 静态构建（可独立运行）
      echo "下载 x64 静态 ffmpeg（evermeet.cx）…"
      curl -fsSL -o /tmp/ffmpeg.zip "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip" || { echo "下载失败"; exit 1; }
      unzip -o /tmp/ffmpeg.zip -d /tmp/ffmpeg_ext
      FF="/tmp/ffmpeg_ext/ffmpeg"
    else
      # arm64：Homebrew 本机 ffmpeg（arch 匹配 runner）
      if command -v brew >/dev/null 2>&1 && [ -x "$(brew --prefix ffmpeg 2>/dev/null)/bin/ffmpeg" ]; then
        FF="$(brew --prefix ffmpeg)/bin/ffmpeg"
      elif [ -x /opt/homebrew/bin/ffmpeg ]; then
        FF="/opt/homebrew/bin/ffmpeg"
      else
        echo "未找到 arm64 ffmpeg"; exit 1
      fi
    fi
    cp -f "$FF" "$BIN/ffmpeg-darwin-$TARGET"
    chmod +x "$BIN/ffmpeg-darwin-$TARGET"
    echo "已写入 bin/ffmpeg-darwin-$TARGET"
    # 同时产出另一个 arch 的文件名（electron-builder extraResources 引用了 arm64+x64 两个具体文件，
    # 每个 runner 只产出一个 arch，为避免引用不存在的文件导致打包失败，复制一份到另一个名字）
    OTHER="x64"; [ "$TARGET" = "x64" ] && OTHER="arm64"
    cp -f "$FF" "$BIN/ffmpeg-darwin-${OTHER}"
    chmod +x "$BIN/ffmpeg-darwin-${OTHER}"
    echo "已写入 bin/ffmpeg-darwin-${OTHER}（冗余副本，规避 extraResources 缺失）"
    ;;
  *)
    # Windows / Linux 归为 win：下载 gyan.dev release essentials（含 ffmpeg.exe）
    ZIP="$BIN/ffmpeg-win.zip"
    echo "下载 ffmpeg（gyan.dev release essentials）…"
    curl -fsSL -o "$ZIP" "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" || { echo "下载失败"; exit 1; }
    EXTRACT="$BIN/_tmp_ff"
    rm -rf "$EXTRACT"; mkdir -p "$EXTRACT"
    unzip -o "$ZIP" -d "$EXTRACT" >/dev/null
    FOUND="$(find "$EXTRACT" -type f -name 'ffmpeg.exe' | head -1)"
    if [ -z "$FOUND" ]; then echo "解压后未找到 ffmpeg.exe"; exit 1; fi
    cp -f "$FOUND" "$BIN/ffmpeg-win32-x64.exe"
    rm -rf "$EXTRACT" "$ZIP"
    echo "已写入 bin/ffmpeg-win32-x64.exe"
    ;;
esac

echo "完成。当前 bin/ 内容："
ls -la "$BIN"
