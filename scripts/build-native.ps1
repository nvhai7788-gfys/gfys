# build-native.ps1 —— Windows 编译 libobs（obs-studio）+ obs-bridge 原生桥接
#
# 关键：用 -DOBS_CMAKE_VERSION=3.0.0 走新构建系统（configure 自动下载 obs-deps），
#       关 UI/浏览器/脚本，避免引入 Qt 与 CEF。
# 每步失败都通过 ::error 输出具体错误（供 check-run annotations API 读取定位）。
param(
  [string]$OBS_VER = "30.2.3"
)

$ErrorActionPreference = "Stop"
$SRC = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TP = Join-Path $SRC "third_party"
$OBS = Join-Path $TP "obs-studio"
$BUILD = Join-Path $OBS "build_x64"
$BIN = Join-Path $SRC "bin"

New-Item -ItemType Directory -Force -Path $TP | Out-Null

# 1) clone obs-studio
if (-not (Test-Path (Join-Path $OBS ".git"))) {
  Write-Host "==> git clone obs-studio $OBS_VER"
  $o = & git clone --depth 1 --branch $OBS_VER https://github.com/obsproject/obs-studio.git $OBS 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "::error::git clone 失败 (exit $LASTEXITCODE)"
    @($o) | Select-Object -Last 10 | ForEach-Object { Write-Host $_ }
    exit 1
  }
}

Push-Location $OBS

# 2) submodule
Write-Host "==> submodule init"
$o = & git submodule update --init --depth 1 plugins/win-dshow/libdshowcapture 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "::error::submodule libdshowcapture 失败 (exit $LASTEXITCODE)"
  @($o) | Select-Object -Last 10 | ForEach-Object { Write-Host $_ }
  exit 1
}
$o = & git submodule update --init --depth 1 plugins/obs-outputs/ftl-sdk 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "::error::submodule ftl-sdk 失败 (exit $LASTEXITCODE)"
  @($o) | Select-Object -Last 10 | ForEach-Object { Write-Host $_ }
  exit 1
}

# 3) cmake configure
Write-Host "==> cmake configure"
$o = & cmake -S $OBS -B $BUILD -G "Visual Studio 17 2022" -A x64 `
  -DOBS_CMAKE_VERSION=3.0.0 `
  -DENABLE_UI=OFF `
  -DENABLE_BROWSER=OFF `
  -DENABLE_SCRIPTING=OFF `
  -DENABLE_HEVC=OFF 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "::error::cmake configure 失败 (exit $LASTEXITCODE)"
  @($o) | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }
  exit 1
}

# 4) cmake build
Write-Host "==> cmake build libobs + plugins"
$o = & cmake --build $BUILD --config Release --parallel --target `
  libobs obs-x264 obs-ffmpeg obs-outputs obs-transitions obs-filters `
  win-dshow win-capture win-wasapi win-mf 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "::error::cmake build 失败 (exit $LASTEXITCODE)"
  @($o) | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }
  exit 1
}

Pop-Location

# 5) node-gyp 编译 obs-bridge
Write-Host "==> node-gyp build obs-bridge"
Push-Location (Join-Path $SRC "native\obs-bridge")
$env:OBS_INCLUDE_DIR = Join-Path $OBS "libobs"
$env:OBS_LIB_DIR = Join-Path $BUILD "libobs\Release"
$env:OBS_MODULE_DIR = $BUILD
$o = & npx node-gyp rebuild 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "::error::node-gyp rebuild 失败 (exit $LASTEXITCODE)"
  @($o) | Select-Object -Last 20 | ForEach-Object { Write-Host $_ }
  exit 1
}
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

Write-Host "::notice::build-native 完成"
