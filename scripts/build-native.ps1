# build-native.ps1 —— Windows 编译 libobs（obs-studio）+ obs-bridge 原生桥接
#
# 参考 obs-studio 30.2.3 官方构建：下载预编译 obs-deps（含 FFmpeg/x264/jansson 等），
# 只编译嵌入所需的 libobs 库与插件（关闭 UI/浏览器/脚本，避免引入 Qt 与 CEF）。
#
# 依赖：Visual Studio 2022（MSVC）、CMake、Ninja、Git、Node.js（windows-latest 已具备）。
# 用法：powershell -ExecutionPolicy Bypass -File scripts/build-native.ps1
param(
  [string]$OBS_VER = "30.2.3",
  [string]$DEPS_VER = "2024-05-08"
)

$ErrorActionPreference = "Stop"
$SRC = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TP = Join-Path $SRC "third_party"
$OBS = Join-Path $TP "obs-studio"
$DEPS = Join-Path $TP "obs-deps"           # obs-studio 默认在 ../obs-deps 找预编译依赖
$BUILD = Join-Path $OBS "build_x64"
$BIN = Join-Path $SRC "bin"

New-Item -ItemType Directory -Force -Path $TP | Out-Null

# 1) clone obs-studio（不拉 browser 等大 submodule）
if (-not (Test-Path (Join-Path $OBS ".git"))) {
  git clone --depth 1 --branch $OBS_VER https://github.com/obsproject/obs-studio.git $OBS
}
Push-Location $OBS
git submodule update --init --depth 1 plugins/win-dshow/libdshowcapture 2>$null
git submodule update --init --depth 1 plugins/obs-outputs/ftl-sdk 2>$null

# 2) 下载预编译 obs-deps（含 FFmpeg/x264/libjansson 等），解压到 ../obs-deps
if (-not (Test-Path (Join-Path $DEPS "bin"))) {
  $zip = Join-Path $TP "windows-deps.zip"
  $url = "https://github.com/obsproject/obs-deps/releases/download/$DEPS_VER/windows-deps-$DEPS_VER-x64.zip"
  Write-Host "下载 obs-deps：$url"
  Invoke-WebRequest -Uri $url -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $TP -Force
  Remove-Item $zip -Force
}

# 3) CMake 配置：关 UI / 浏览器 / 脚本，走 legacy 构建（libobs + 插件）
cmake -S $OBS -B $BUILD -G "Visual Studio 17 2022" -A x64 `
  -DENABLE_UI=OFF `
  -DENABLE_BROWSER=OFF `
  -DENABLE_SCRIPTING=OFF `
  -DENABLE_HEVC=OFF `
  -DENABLE_AJA=OFF `
  -DENABLE_WEBRTC=OFF `
  -DENABLE_VLC=OFF `
  -DBUILD_FOR_DISTRIBUTION=ON

# 4) 只编译需要的 target（libobs + 编码/输出/采集插件）
cmake --build $BUILD --config Release --parallel --target `
  libobs obs-x264 obs-ffmpeg obs-outputs obs-transitions obs-filters `
  win-dshow win-capture win-wasapi win-mf

Pop-Location

# 5) 编译 obs-bridge 原生桥接（node-gyp；此时 npm install 已在 workflow 里完成）
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
# 预编译 deps 的运行时 DLL（FFmpeg 等）也要带上
if (Test-Path (Join-Path $DEPS "bin")) { Copy-Item -Force (Join-Path $DEPS "bin\*.dll") (Join-Path $BIN "obs\bin\64bit\") }
if (Test-Path (Join-Path $BUILD "rundir")) { Copy-Item -Recurse -Force (Join-Path $BUILD "rundir\*") (Join-Path $BIN "obs\data\") }

Write-Host "==> 完成"
