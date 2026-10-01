#!/usr/bin/env bash
# build-native.sh —— macOS 编译 libobs（obs-studio）+ obs-bridge 原生桥接，产物落到 bin/obs-bridge 与 bin/obs。
#
# 关键：用 obs-studio 官方 CMake preset（macos），走「新构建系统」（OBS_CMAKE_VERSION=3.0.0），
#       该系统的 configure 阶段会【自动下载并解压 obs-deps 预编译依赖】，无需手动处理。
#       仅覆盖 ENABLE_UI/OFF、ENABLE_BROWSER/OFF、ENABLE_SCRIPTING/OFF，避免引入 Qt 与 CEF。
#
# 在 GitHub Actions 的 macOS 14(arm64)/macOS 13(x64) runner 上运行。
# 用法：OBS_VER=30.2.3 ARCH=arm64 bash scripts/build-native.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
OBS_VER="${OBS_VER:-30.2.3}"
ARCH="${ARCH:-$(uname -m)}"          # arm64 / x86_64
[ "$ARCH" = "x64" ] && ARCH="x86_64" # workflow 传 x64 → CMake 要 x86_64

TP="$SRC/third_party"
OBS="$TP/obs-studio"
BUILD="$OBS/build_macos"             # preset macos 的 binaryDir
BIN="$SRC/bin"

echo "==> 准备 third_party/"
mkdir -p "$TP"

# 1) clone obs-studio
if [ ! -d "$OBS/.git" ]; then
  git clone --depth 1 --branch "$OBS_VER" https://github.com/obsproject/obs-studio.git "$OBS"
fi
cd "$OBS"

# 2) 初始化编译必需的 submodule（FTL 输出）
git submodule update --init --depth 1 plugins/obs-outputs/ftl-sdk 2>/dev/null || true

# 3) 配置：走新构建系统（自动下载 obs-deps），关 UI/浏览器/脚本，钉死架构
cmake -S "$OBS" -B "$BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="$ARCH" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
  -DOBS_CMAKE_VERSION=3.0.0 \
  -DENABLE_UI=OFF -DENABLE_BROWSER=OFF -DENABLE_SCRIPTING=OFF \
  -DENABLE_HEVC=OFF

# 4) 只编译需要的 target（libobs + 编码/输出/采集插件）
cmake --build "$BUILD" --config Release --parallel --target \
  libobs obs-x264 obs-ffmpeg obs-outputs obs-transitions obs-filters \
  mac-avcapture mac-capture coreaudio-encoder

# 5) 编译 obs-bridge（node-gyp；npm install 已在 workflow 提前完成）
cd "$SRC/native/obs-bridge"
OBS_INCLUDE_DIR="$OBS/libobs" \
OBS_LIB_DIR="$BUILD/libobs" \
OBS_MODULE_DIR="$BUILD" \
npx node-gyp rebuild

# 6) 落盘到 bin/
mkdir -p "$BIN/obs-bridge" "$BIN/obs/bin/64bit" "$BIN/obs/data"
cp -f "$SRC/native/obs-bridge/build/Release/obs_bridge.node" "$BIN/obs-bridge/obs_bridge.node"
find "$BUILD" -name '*.dylib' -not -name '*.a' | while read -r f; do
  cp -f "$f" "$BIN/obs/bin/64bit/"
done
if [ -d "$BUILD/rundir" ]; then cp -R "$BUILD/rundir/." "$BIN/obs/data/"; fi

echo "==> 完成。bin/ 内容："
ls -R "$BIN" 2>/dev/null | head -40
