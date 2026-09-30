#!/usr/bin/env bash
# build-native.sh —— macOS 编译 libobs（obs-studio）+ obs-bridge 原生桥接，产物落到 bin/obs-bridge 与 bin/obs。
#
# 参考 obs-studio 30.2.3 官方构建：下载预编译 obs-deps（含 FFmpeg/x264/jansson 等），
# 只编译嵌入所需的 libobs 库与插件（关闭 UI/浏览器/脚本，避免引入 Qt 与 CEF）。
#
# 在 GitHub Actions 的 macOS 14(arm64)/macOS 13(x64) runner 上运行。
# 用法：OBS_VER=30.2.3 ARCH=arm64 bash scripts/build-native.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
OBS_VER="${OBS_VER:-30.2.3}"
DEPS_VER="${DEPS_VER:-2024-05-08}"
# 统一架构名：arm64 / x86_64（obs-deps 文件名用 arm64 / x86_64）
MACH="$(uname -m)"
ARCH="${ARCH:-$MACH}"

TP="$SRC/third_party"
OBS="$TP/obs-studio"
DEPS="$TP/obs-deps"          # obs-studio 默认在 ../obs-deps 找预编译依赖
BUILD="$OBS/build"
BIN="$SRC/bin"

echo "==> 准备 third_party/"
mkdir -p "$TP"

# 1) clone obs-studio（不拉 browser 等大 submodule）
if [ ! -d "$OBS/.git" ]; then
  git clone --depth 1 --branch "$OBS_VER" https://github.com/obsproject/obs-studio.git "$OBS"
fi
cd "$OBS"
git submodule update --init --depth 1 plugins/obs-outputs/ftl-sdk 2>/dev/null || true

# 2) 下载预编译 obs-deps（含 FFmpeg/x264/jansson 等），解压到 ../obs-deps
if [ ! -d "$DEPS/lib" ] && [ ! -d "$DEPS/bin" ]; then
  DEPSFILE="macos-deps-$DEPS_VER-$ARCH.tar.xz"
  echo "==> 下载 obs-deps：$DEPSFILE"
  curl -fsSL -o "$TP/$DEPSFILE" "https://github.com/obsproject/obs-deps/releases/download/$DEPS_VER/$DEPSFILE"
  mkdir -p "$DEPS"
  tar -xf "$TP/$DEPSFILE" -C "$DEPS" --strip-components=1
  rm -f "$TP/$DEPSFILE"
fi

# 3) CMake 配置：关 UI / 浏览器 / 脚本，只编库与插件
cmake -S "$OBS" -B "$BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="$ARCH" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
  -DENABLE_UI=OFF \
  -DENABLE_BROWSER=OFF \
  -DENABLE_SCRIPTING=OFF \
  -DENABLE_HEVC=OFF \
  -DENABLE_AJA=OFF \
  -DENABLE_WEBRTC=OFF \
  -DENABLE_VLC=OFF \
  -DBUILD_FOR_DISTRIBUTION=ON

# 4) 只编译需要的 target（libobs + 编码/输出/采集插件）
cmake --build "$BUILD" --parallel --target \
  libobs obs-x264 obs-ffmpeg obs-outputs obs-transitions obs-filters \
  mac-avcapture mac-capture coreaudio-encoder

# 5) 编译 obs-bridge 原生桥接（node-gyp；此时 npm install 已在 workflow 里完成）
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
# 预编译 deps 的运行时 dylib（FFmpeg 等）也带上
if [ -d "$DEPS/lib" ]; then find "$DEPS/lib" -name '*.dylib' -exec cp -f {} "$BIN/obs/bin/64bit/" \;; fi
if [ -d "$BUILD/rundir" ]; then cp -R "$BUILD/rundir/." "$BIN/obs/data/"; fi

echo "==> 完成。bin/ 内容："
ls -R "$BIN" 2>/dev/null | head -40
