# build-native.ps1 —— Windows 编译 libobs（obs-studio）+ obs-bridge 原生桥接
#
# 关键：用 -DOBS_CMAKE_VERSION=3.0.0 走新构建系统（configure 自动下载 obs-deps），关 UI/浏览器/脚本。
# 注意：不能用 $ErrorActionPreference="Stop" + "2>&1" 捕获——原生命令的 stderr（如 git 进度）
#       会被包装成 ErrorRecord 触发 Stop 导致脚本在 clone 阶段就中断。
#       这里用 "Continue" + 每个外部命令后检查 $LASTEXITCODE，失败输出 ::error 再 exit。
param(
  [string]$OBS_VER = "30.2.3"
)

$ErrorActionPreference = "Continue"
$SRC = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TP = Join-Path $SRC "third_party"
$OBS = Join-Path $TP "obs-studio"
$BUILD = Join-Path $OBS "build_x64"
$BIN = Join-Path $SRC "bin"

New-Item -ItemType Directory -Force -Path $TP | Out-Null

# 1) clone obs-studio
if (-not (Test-Path (Join-Path $OBS ".git"))) {
  Write-Host "==> git clone obs-studio $OBS_VER"
  git clone --depth 1 --branch $OBS_VER https://github.com/obsproject/obs-studio.git $OBS
  if ($LASTEXITCODE -ne 0) { Write-Host "::error::git clone 失败 (exit $LASTEXITCODE)"; exit 1 }
}

Push-Location $OBS
if (-not $?) { Write-Host "::error::Push-Location $OBS 失败"; exit 1 }

# 2) submodule
Write-Host "==> submodule init"
git submodule update --init --depth 1 plugins/win-dshow/libdshowcapture
if ($LASTEXITCODE -ne 0) { Write-Host "::error::submodule libdshowcapture 失败 (exit $LASTEXITCODE)"; exit 1 }
git submodule update --init --depth 1 plugins/obs-outputs/ftl-sdk
if ($LASTEXITCODE -ne 0) { Write-Host "::error::submodule ftl-sdk 失败 (exit $LASTEXITCODE)"; exit 1 }

# 3) cmake configure
Write-Host "==> cmake configure"
cmake -S $OBS -B $BUILD -G "Visual Studio 17 2022" -A x64 `
  -DOBS_CMAKE_VERSION=3.0.0 `
  -DENABLE_UI=OFF `
  -DENABLE_BROWSER=OFF `
  -DENABLE_SCRIPTING=OFF `
  -DENABLE_HEVC=OFF
if ($LASTEXITCODE -ne 0) { Write-Host "::error::cmake configure 失败 (exit $LASTEXITCODE)"; exit 1 }

# 4) cmake build
Write-Host "==> cmake build libobs + plugins"
cmake --build $BUILD --config Release --parallel --target `
  libobs obs-x264 obs-ffmpeg obs-outputs obs-transitions obs-filters `
  win-dshow win-capture win-wasapi win-mf
if ($LASTEXITCODE -ne 0) { Write-Host "::error::cmake build 失败 (exit $LASTEXITCODE)"; exit 1 }

Pop-Location

# 5) node-gyp 编译 obs-bridge
Write-Host "==> node-gyp build obs-bridge"
Push-Location (Join-Path $SRC "native\obs-bridge")
$env:OBS_INCLUDE_DIR = Join-Path $OBS "libobs"
$env:OBS_LIB_DIR = Join-Path $BUILD "libobs\Release"
$env:OBS_MODULE_DIR = $BUILD
npx node-gyp rebuild
if ($LASTEXITCODE -ne 0) { Write-Host "::error::node-gyp rebuild 失败 (exit $LASTEXITCODE)"; exit 1 }
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
