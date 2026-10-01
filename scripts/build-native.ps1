# build-native.ps1 —— Windows 编译 libobs（obs-studio）+ obs-bridge 原生桥接
#
# 关键：用 obs-studio 官方 CMake preset（windows-x64），走「新构建系统」（OBS_CMAKE_VERSION=3.0.0），
#       该系统的 configure 阶段会【自动下载并解压 obs-deps 预编译依赖】，无需手动处理。
#       仅覆盖 ENABLE_UI/OFF、ENABLE_BROWSER/OFF、ENABLE_SCRIPTING/OFF，避免引入 Qt 与 CEF。
#
# 依赖：Visual Studio 2022（MSVC）、CMake、Git、Node.js（windows-latest 已具备）。
# 用法：powershell -ExecutionPolicy Bypass -File scripts/build-native.ps1
param(
  [string]$OBS_VER = "30.2.3"
)

$ErrorActionPreference = "Stop"
$SRC = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TP = Join-Path $SRC "third_party"
$OBS = Join-Path $TP "obs-studio"
$BUILD = Join-Path $OBS "build_x64"      # preset windows-x64 的 binaryDir
$BIN = Join-Path $SRC "bin"

New-Item -ItemType Directory -Force -Path $TP | Out-Null

# 1) clone obs-studio
if (-not (Test-Path (Join-Path $OBS ".git"))) {
  git clone --depth 1 --branch $OBS_VER https://github.com/obsproject/obs-studio.git $OBS
}
Push-Location $OBS

# 2) 初始化编译必需的 submodule（dshow 采集 / FTL 输出）
git submodule update --init --depth 1 plugins/win-dshow/libdshowcapture
git submodule update --init --depth 1 plugins/obs-outputs/ftl-sdk

# 3) 官方 preset 配置（自动下载 obs-deps），关 UI/浏览器/脚本
cmake --preset windows-x64 -DENABLE_UI=OFF -DENABLE_BROWSER=OFF -DENABLE_SCRIPTING=OFF

# 4) 只编译需要的 target（libobs + 编码/输出/采集插件）
cmake --build --preset windows-x64 --config Release --parallel --target `
  libobs obs-x264 obs-ffmpeg obs-outputs obs-transitions obs-filters `
  win-dshow win-capture win-wasapi win-mf

Pop-Location

# 5) 编译 obs-bridge（node-gyp；npm install 已在 workflow 提前完成）
Push-Location (Join-Path $SRC "native\obs-bridge")
$env:OBS_INCLUDE_DIR = Join-Path $OBS "libobs"
$env:OBS_LIB_DIR = Join-Path $BUILD "libobs\Release"
$env:OBS_MODULE_DIR = $BUILD
npx node-gyp rebuild
Pop-Location

# 6) 落盘到 bin/
New-Item -ItemType Directory -Force -Path (Join-Path $BIN "obs-bridge") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $BIN "obs\bin\64bit") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $BIN "obs\data") | Out-Null

Copy-Item -Force (Join-Path $SRC "native\obs-bridge\build\Release\obs_bridge.node") (Join-Path $BIN "obs-bridge\obs_bridge.node")
Get-ChildItem -Path $BUILD -Recurse -Filter *.dll | Where-Object { $_.FullName -notmatch "test" } | ForEach-Object {
  Copy-Item -Force $_.FullName (Join-Path $BIN "obs\bin\64bit\")
}
if (Test-Path (Join-Path $BUILD "rundir")) { Copy-Item -Recurse -Force (Join-Path $BUILD "rundir\*") (Join-Path $BIN "obs\data\") }

Write-Host "==> 完成"
