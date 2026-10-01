#!/usr/bin/env bash
# build-native.sh —— macOS 编译 libobs（obs-studio）+ obs-bridge 原生桥接，产物落到 bin/obs-bridge 与 bin/obs。
#
# 关键（与 Windows 侧不同）：
#   1) macOS 强制 Xcode generator（cmake/macos/compilerconfig.cmake 里 `if(NOT XCODE) FATAL_ERROR`），
#      不能用 Ninja。
#   2) libobs 在 macOS 是 framework（libobs/cmake/os-macos.cmake `set_property FRAMEWORK TRUE`），
#      输出为 libobs.framework/，不是 .dylib；插件输出为 .plugin bundle。
#   3) 走「新构建系统」（OBS_CMAKE_VERSION=3.0.0），configure 阶段自动下载 obs-deps 预编译依赖。
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
BUILD="$OBS/build_macos"             # 与 preset macos 的 binaryDir 一致
BIN="$SRC/bin"

echo "==> 准备 third_party/"
mkdir -p "$TP"

# 1) clone obs-studio
if [ ! -d "$OBS/.git" ]; then
  git clone --depth 1 --branch "$OBS_VER" https://github.com/obsproject/obs-studio.git "$OBS"
fi
cd "$OBS"

# 2) 初始化编译必需的 submodule（browser/websocket 即使 ENABLE_BROWSER=OFF 也需存在；FTL 输出）
git submodule update --init --depth 1 plugins/obs-outputs/ftl-sdk 2>/dev/null || true
git submodule update --init --depth 1 plugins/obs-browser 2>/dev/null || true
git submodule update --init --depth 1 plugins/obs-websocket 2>/dev/null || true

# 3) 配置：Xcode generator + 新构建系统（自动下载 obs-deps），关 UI/浏览器/脚本/硬件 SDK 插件
#    必须显式设 CMAKE_OSX_SYSROOT（obs-studio 用它正则提取 SDK 版本，空会报 FATAL_ERROR）
SDKROOT="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || echo "")"
echo "==> macOS SDK：$SDKROOT"
cmake -S "$OBS" -B "$BUILD" -G Xcode \
  -DCMAKE_OSX_ARCHITECTURES="$ARCH" \
  -DCMAKE_OSX_SYSROOT="$SDKROOT" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
  -DOBS_CMAKE_VERSION=3.0.0 \
  -DENABLE_UI=OFF -DENABLE_BROWSER=OFF -DENABLE_SCRIPTING=OFF \
  -DENABLE_HEVC=ON -DENABLE_AJA=OFF -DENABLE_DECKLINK=OFF \
  -DENABLE_VLC=OFF -DENABLE_WEBRTC=OFF -DENABLE_VST=OFF \
  -DENABLE_RNNOISE=OFF -DENABLE_SPEEXDSP=OFF \
  -DENABLE_VIRTUALCAM=OFF

# 4) 只编译需要的 target（libobs framework + 编码/输出/采集插件）
cmake --build "$BUILD" --config Release --parallel --target \
  libobs obs-x264 obs-ffmpeg obs-outputs obs-transitions obs-filters \
  mac-avcapture mac-capture coreaudio-encoder

# 5) 编译 obs-bridge（node-gyp）
cd "$SRC/native/obs-bridge"

# libobs 是 framework，定位其父目录（供 node-gyp 用 -F 链接）。
# 注意：Xcode 15 会把「真正 dylib」与「.tbd 链接存根」分开存放（EagerLinkingTBDs/ 只含 .tbd，
#       且可能存在多个只含 .tbd 的 framework 目录）。必须找含真正 dylib（Versions/A/libobs 无扩展名）的那个。
FW_DIR=""
for _fw in $(find "$BUILD" -name 'libobs.framework' -type d | grep -v 'EagerLinkingTBDs'); do
  if [ -f "$_fw/Versions/A/libobs" ]; then
    FW_DIR="$_fw"
    break
  fi
done
if [ -z "$FW_DIR" ]; then
  echo "::error::未找到含真正 dylib 的 libobs.framework（只有 .tbd 存根），运行时加载会失败" >&2
  # 兜底：退化为任意非 EagerLinkingTBDs 的 framework（至少能链接）
  FW_DIR="$(find "$BUILD" -name 'libobs.framework' -type d | grep -v 'EagerLinkingTBDs' | head -1)"
fi
OBS_LIB_DIR="$(dirname "$FW_DIR")"
echo "==> libobs.framework 目录：$FW_DIR"
echo "==> -F 搜索目录：$OBS_LIB_DIR"

export OBS_INCLUDE_DIR="$OBS/libobs"
export OBS_LIB_DIR="$OBS_LIB_DIR"
export OBS_MODULE_DIR="$BUILD"
export OBS_DEPS_INCLUDE="$OBS/deps"
# 注意：node-gyp 内置 gyp 不读 shell 环境变量，binding.gyp 的 <(OBS_*_DIR)> 必须经 GYP_DEFINES 传入。
export GYP_DEFINES="OBS_INCLUDE_DIR=$OBS_INCLUDE_DIR OBS_LIB_DIR=$OBS_LIB_DIR OBS_MODULE_DIR=$OBS_MODULE_DIR OBS_DEPS_INCLUDE=$OBS_DEPS_INCLUDE"
# node-gyp 架构：交叉编译时 x86_64 → x64（arm64 runner 上编 Intel 版）
NODE_ARCH="arm64"
[ "$ARCH" = "x86_64" ] && NODE_ARCH="x64"
npx node-gyp rebuild --arch="$NODE_ARCH"

# 5.5) 设置 rpath：obs_bridge.node 链接了 @rpath/libobs.framework/...，打包后 framework 在
#      resources/obs/、.node 在 resources/obs-bridge/，需加 @loader_path/../obs 让 DYLD 能找到。
NODE_BIN="$SRC/native/obs-bridge/build/Release/obs_bridge.node"
if [ -f "$NODE_BIN" ]; then
  install_name_tool -add_rpath "@loader_path/../obs" "$NODE_BIN" 2>/dev/null || true
  install_name_tool -add_rpath "$OBS_LIB_DIR" "$NODE_BIN" 2>/dev/null || true
  echo "==> 已设置 obs_bridge.node rpath"
fi

# 6) 落盘到 bin/
mkdir -p "$BIN/obs-bridge" "$BIN/obs"
cp -f "$SRC/native/obs-bridge/build/Release/obs_bridge.node" "$BIN/obs-bridge/obs_bridge.node" 2>/dev/null || \
  cp -f "$SRC/native/obs-bridge/build/Release/obs_bridge.node" "$BIN/obs-bridge/obs_bridge.node"

# libobs.framework 整体复制（复用上面找到的含真正 dylib 的 FW_DIR）
if [ -n "$FW_DIR" ]; then
  cp -R "$FW_DIR" "$BIN/obs/libobs.framework"
fi

# 插件 .plugin bundle（排除 EagerLinkingTBDs 存根）
mkdir -p "$BIN/obs/obs-plugins"
find "$BUILD" -name '*.plugin' -type d | grep -v 'EagerLinkingTBDs' | while read -r p; do
  cp -R "$p" "$BIN/obs/obs-plugins/"
done

# data（obs 运行时需要的 locale / 主题等）——优先 build 目录，其次源码目录
if [ -d "$BUILD/rundir/data" ]; then
  mkdir -p "$BIN/obs/data"
  cp -R "$BUILD/rundir/data/." "$BIN/obs/data/"
elif [ -d "$OBS/data" ]; then
  mkdir -p "$BIN/obs/data"
  cp -R "$OBS/data/." "$BIN/obs/data/"
fi

echo "==> 完成。bin/ 内容："
ls -R "$BIN" 2>/dev/null | head -60
