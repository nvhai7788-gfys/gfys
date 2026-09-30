# build-native.ps1 —— Windows 上编译 libobs（obs-studio）+ obs-bridge 原生桥接，产物落到 bin/obs-bridge 与 bin/obs。
#
# 依赖：Visual Studio 2022（MSVC C++）、CMake、Ninja、Git、Node.js（无需 Qt，仅构建库与插件）。
# 在 GitHub Actions 的 windows-latest runner 上运行。
#
# 用法：
#   $env:OBS_VER="30.2.3"; powershell -ExecutionPolicy Bypass -File scripts/build-native.ps1
param(
  [string]$OBS_VER = "30.2.3"
)

$ErrorActionPreference = "Stop"
$SRC = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$OBS_ROOT = Join-Path $SRC "third_party\obs-studio"
$OBS_BUILD = Join-Path $OBS_ROOT "build_x64"
$BIN = Join-Path $SRC "bin"

Write-Host "==> 编译 libobs + 插件（obs-studio $OBS_VER, x64）"
New-Item -ItemType Directory -Force -Path (Join-Path $SRC "third_party") | Out-Null
if (-not (Test-Path (Join-Path $OBS_ROOT ".git"))) {
  git clone --depth 1 --branch $OBS_VER https://github.com/obsproject/obs-studio.git $OBS_ROOT
}
Push-Location $OBS_ROOT

cmake -S . -B $OBS_BUILD -G Ninja `
  -DCMAKE_BUILD_TYPE=Release `
  -DDISABLE_PYTHON=ON `
  -DENABLE_BROWSER=OFF `
  -DENABLE_SCRIPTING=OFF `
  -DENABLE_UI=OFF

# 只构建嵌入所需的库与插件（Windows 采集/音频/编码插件）：
#   libobs            —— 引擎核心
#   obs-x264          —— x264 编码器
#   obs-ffmpeg        —— ffmpeg_source + ffmpeg_aac
#   obs-outputs       —— rtmp_output / ffmpeg_muxer
#   obs-transitions   —— 转场
#   obs-filters       —— 滤镜
#   win-dshow         —— dshow_input 摄像头来源
#   win-capture       —— 显示器捕获
#   win-wasapi        —— 音频采集
#   win-mf            —— Media Foundation 编码
cmake --build $OBS_BUILD --parallel --target `
  libobs obs-x264 obs-ffmpeg obs-outputs obs-transitions obs-filters `
  win-dshow win-capture win-wasapi win-mf

Pop-Location

Write-Host "==> 编译 obs-bridge 原生桥接（node-gyp）"
Push-Location (Join-Path $SRC "native\obs-bridge")
$env:OBS_INCLUDE_DIR = Join-Path $OBS_ROOT "libobs"
$env:OBS_LIB_DIR = Join-Path $OBS_BUILD "libobs"
$env:OBS_MODULE_DIR = $OBS_BUILD
npx node-gyp rebuild
Pop-Location

Write-Host "==> 落盘到 bin/"
New-Item -ItemType Directory -Force -Path (Join-Path $BIN "obs-bridge") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $BIN "obs\bin\64bit") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $BIN "obs\data") | Out-Null

Copy-Item -Force (Join-Path $SRC "native\obs-bridge\build\Release\obs_bridge.node") (Join-Path $BIN "obs-bridge\obs_bridge.node")
Get-ChildItem -Path $OBS_BUILD -Recurse -Filter *.dll | Where-Object { $_.Name -notlike "*test*" } | ForEach-Object {
  Copy-Item -Force $_.FullName (Join-Path $BIN "obs\bin\64bit\")
}
if (Test-Path (Join-Path $OBS_BUILD "rundir")) { Copy-Item -Recurse -Force (Join-Path $OBS_BUILD "rundir\*") (Join-Path $BIN "obs\data\") }
if (Test-Path (Join-Path $OBS_BUILD "data")) { Copy-Item -Recurse -Force (Join-Path $OBS_BUILD "data\*") (Join-Path $BIN "obs\data\") }

Write-Host "==> 完成。bin/ 内容："
Get-ChildItem -Recurse $BIN | Select-Object FullName
