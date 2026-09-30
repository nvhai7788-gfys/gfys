#!/usr/bin/env bash
# build-native.sh —— macOS 上编译 libobs（obs-studio）+ obs-bridge 原生桥接，并把产物落到 bin/obs-bridge 与 bin/obs。
#
# 依赖：Xcode CLT、cmake、ninja、git、node、brew（Qt6 仅当需要构建 OBS UI 时才装——本脚本只构建库与插件，不装 Qt）。
# 在 GitHub Actions 的 macOS 14(arm64)/macOS 13(x64) runner 上运行。
#
# 用法：
#   OBS_VER=30.2.3 ARCH=arm64 bash scripts/build-native.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
OBS_VER="${OBS_VER:-30.2.3}"
ARCH="${ARCH:-$(uname -m)}"          # arm64 / x86_64 → 统一 x64
[ "$ARCH" = "x86_64" ] && ARCH="x64"
OBS_ROOT="$SRC/third_party/obs-studio"
OBS_BUILD="$OBS_ROOT/build"
BIN="$SRC/bin"

echo "==> 编译 libobs + 插件（obs-studio $OBS_VER, arch=$ARCH）"
mkdir -p "$SRC/third_party"
if [ ! -d "$OBS_ROOT/.git" ]; then
  git clone --depth 1 --branch "$OBS_VER" https://github.com/obsproject/obs-studio.git "$OBS_ROOT"
fi
cd "$OBS_ROOT"

cmake -S . -B "$OBS_BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="$ARCH" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
  -DDISABLE_PYTHON=ON \
  -DENABLE_BROWSER=OFF \
  -DENABLE_SCRIPTING=OFF \
  -DENABLE_UI=OFF

# 只构建嵌入所需的库与插件（不构建 OBS UI，避免引入 Qt）：
#   libobs            —— 引擎核心
#   obs-x264          —— x264 编码器
#   obs-ffmpeg        —— ffmpeg_source 来源 + ffmpeg_aac 编码器
#   obs-outputs       —— rtmp_output / ffmpeg_muxer 输出
#   obs-transitions   —— 转场
#   obs-filters       —— 滤镜
#   mac-avcapture     —— av_capture_input 摄像头来源
#   mac-capture       —— 显示器捕获
#   coreaudio-encoder —— CoreAudio 音频编码
cmake --build "$OBS_BUILD" --parallel --target \
  libobs obs-x264 obs-ffmpeg obs-outputs obs-transitions obs-filters \
  mac-avcapture mac-capture coreaudio-encoder

echo "==> 编译 obs-bridge 原生桥接（node-gyp）"
cd "$SRC/native/obs-bridge"
OBS_INCLUDE_DIR="$OBS_ROOT/libobs" \
OBS_LIB_DIR="$OBS_BUILD/libobs" \
OBS_MODULE_DIR="$OBS_BUILD" \
npx node-gyp rebuild

echo "==> 落盘到 bin/"
mkdir -p "$BIN/obs-bridge" "$BIN/obs/bin/64bit" "$BIN/obs/data"
# 桥接
cp -f "$SRC/native/obs-bridge/build/Release/obs_bridge.node" "$BIN/obs-bridge/obs_bridge.node"
# libobs 与插件模块（.dylib）
find "$OBS_BUILD" -name '*.dylib' -not -name '*.a' | while read -r f; do
  cp -f "$f" "$BIN/obs/bin/64bit/"
done
# 插件数据文件
if [ -d "$OBS_BUILD/rundir" ]; then cp -R "$OBS_BUILD/rundir/." "$BIN/obs/data/"; fi
if [ -d "$OBS_BUILD/data" ]; then cp -R "$OBS_BUILD/data/." "$BIN/obs/data/"; fi

echo "==> 完成。bin/ 内容："
ls -R "$BIN"
