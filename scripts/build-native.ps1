# build-native.ps1 -- Windows: compile libobs (obs-studio) + obs-bridge native addon.
#
# Key: use -DOBS_CMAKE_VERSION=3.0.0 to enter the NEW build system (configure auto-downloads obs-deps).
#      Disable UI/browser/scripting to avoid Qt and CEF.
# IMPORTANT: do NOT use $ErrorActionPreference="Stop" + "2>&1" capture -- native stderr (git progress)
#            gets wrapped as ErrorRecord and aborts the script during clone. Use "Continue" + check
#            $LASTEXITCODE after each native command.
# IMPORTANT: this file MUST stay pure ASCII (no CJK). Windows PowerShell 5.1 reads .ps1 as ANSI
#            unless a UTF-8 BOM is present; non-ASCII bytes break the parser.
param(
  [string]$OBS_VER = "30.2.3"
)

$ErrorActionPreference = "Continue"
# Catch any terminating exception and surface it as ::error (so annotations show it).
trap {
  Write-Host "::error::script exception: $($_.Exception.Message)"
  Write-Host "::error::at line $($_.InvocationInfo.ScriptLineNumber)"
  exit 1
}
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
  if ($LASTEXITCODE -ne 0) { Write-Host "::error::git clone failed (exit $LASTEXITCODE)"; exit 1 }
}

Push-Location $OBS
if (-not $?) { Write-Host "::error::Push-Location failed"; exit 1 }

# 2) submodule init
Write-Host "==> submodule init"
# --recursive: libdshowcapture has a nested submodule (external/capture-device-support) needed by win-dshow
git submodule update --init --recursive --depth 1 plugins/win-dshow/libdshowcapture
if ($LASTEXITCODE -ne 0) { Write-Host "::error::submodule libdshowcapture failed (exit $LASTEXITCODE)"; exit 1 }
git submodule update --init --depth 1 plugins/obs-outputs/ftl-sdk
if ($LASTEXITCODE -ne 0) { Write-Host "::error::submodule ftl-sdk failed (exit $LASTEXITCODE)"; exit 1 }
# obs-browser / obs-websocket are required to exist even with ENABLE_BROWSER=OFF (unconditional check)
git submodule update --init --depth 1 plugins/obs-browser
if ($LASTEXITCODE -ne 0) { Write-Host "::error::submodule obs-browser failed (exit $LASTEXITCODE)"; exit 1 }
git submodule update --init --depth 1 plugins/obs-websocket
if ($LASTEXITCODE -ne 0) { Write-Host "::error::submodule obs-websocket failed (exit $LASTEXITCODE)"; exit 1 }

# 2.5) patch: skip the Win32 sub-configure auto-triggered on 64-bit builds (we only need x64)
$defaults = Join-Path $OBS "cmake\windows\defaults.cmake"
$content = Get-Content $defaults -Raw
if ($content -match 'if\(CMAKE_SIZEOF_VOID_P EQUAL 8\)') {
  $content = $content -replace 'if\(CMAKE_SIZEOF_VOID_P EQUAL 8\)', 'if(FALSE AND CMAKE_SIZEOF_VOID_P EQUAL 8)'
  Set-Content -Path $defaults -Value $content -NoNewline
  Write-Host "==> patched defaults.cmake (skip Win32 sub-configure)"
}

# 2.6) patch: skip graphics-hook (game capture). It requires the Vulkan SDK shader compilers
#      (glslc / glslangValidator) which are NOT in obs-deps. We only need monitor capture.
$wc = Join-Path $OBS "plugins\win-capture\CMakeLists.txt"
$wcContent = Get-Content $wc -Raw
if ($wcContent -match 'add_subdirectory\(graphics-hook\)') {
  $wcContent = $wcContent -replace 'add_subdirectory\(graphics-hook\)', '# add_subdirectory(graphics-hook) disabled: needs Vulkan SDK'
  Set-Content -Path $wc -Value $wcContent -NoNewline
  Write-Host "==> patched win-capture (skip graphics-hook)"
}

# 2.7) patch: disable warnings-as-errors (/WX). Old C code (ftl-sdk) triggers C5286 in VS2022,
#      which becomes a hard error (C2220) under /WX. We are building a release, not CI-polish.
$cc = Join-Path $OBS "cmake\Modules\CompilerConfig.cmake"
$c = Get-Content $cc -Raw
if ($c -match '/WX') {
  $c = $c -replace '/WX', '/WX-'
  Set-Content -Path $cc -Value $c -NoNewline
  Write-Host "==> patched CompilerConfig.cmake (disable /WX)"
}

# 3) cmake configure
Write-Host "==> cmake configure"
$cmakeOutput = & cmake -S $OBS -B $BUILD -G "Visual Studio 17 2022" -A x64 `
  -DOBS_CMAKE_VERSION=3.0.0 `
  -DCMAKE_COMPILE_WARNING_AS_ERROR=OFF `
  -DENABLE_UI=OFF `
  -DENABLE_BROWSER=OFF `
  -DENABLE_SCRIPTING=OFF `
  -DENABLE_HEVC=ON `
  -DENABLE_AJA=OFF `
  -DENABLE_DECKLINK=OFF `
  -DENABLE_VLC=OFF `
  -DENABLE_WEBRTC=OFF `
  -DENABLE_VST=OFF `
  -DENABLE_NATIVE_NVENC=OFF `
  -DENABLE_NVAFX=OFF `
  -DENABLE_NVVFX=OFF `
  -DENABLE_RNNOISE=OFF `
  -DENABLE_SPEEXDSP=OFF 2>&1
$cmakeCode = $LASTEXITCODE

# Convert all output to plain strings (ErrorRecords -> .ToString()) for reliable searching
$cmakeLines = @($cmakeOutput | ForEach-Object { $_.ToString() })

if ($cmakeCode -ne 0) {
  Write-Host "::error::cmake configure failed (exit $cmakeCode)"
  # print each "CMake Error" line plus the next 3 lines (the error description)
  for ($i = 0; $i -lt $cmakeLines.Count; $i++) {
    if ($cmakeLines[$i] -match "CMake Error") {
      Write-Host "::error::[err] $($cmakeLines[$i])"
      for ($j = 1; $j -le 3; $j++) {
        if ($i + $j -lt $cmakeLines.Count) { Write-Host "::error::[ctx] $($cmakeLines[$i + $j])" }
      }
    }
  }
  exit 1
}

# 4) cmake build
Write-Host "==> cmake build libobs + plugins"
cmake --build $BUILD --config Release --parallel --target `
  libobs obs-x264 obs-ffmpeg obs-outputs obs-transitions obs-filters `
  win-dshow win-capture win-wasapi win-mf
if ($LASTEXITCODE -ne 0) { Write-Host "::error::cmake build failed (exit $LASTEXITCODE)"; exit 1 }

Pop-Location

# 5) node-gyp build obs-bridge
Write-Host "==> node-gyp build obs-bridge"
Push-Location (Join-Path $SRC "native\obs-bridge")
$env:OBS_INCLUDE_DIR = Join-Path $OBS "libobs"
$env:OBS_LIB_DIR = Join-Path $BUILD "libobs\Release"
$env:OBS_MODULE_DIR = $BUILD
npx node-gyp rebuild
if ($LASTEXITCODE -ne 0) { Write-Host "::error::node-gyp rebuild failed (exit $LASTEXITCODE)"; exit 1 }
Pop-Location

# 6) copy artifacts to bin/
New-Item -ItemType Directory -Force -Path (Join-Path $BIN "obs-bridge") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $BIN "obs\bin\64bit") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $BIN "obs\data") | Out-Null

Copy-Item -Force (Join-Path $SRC "native\obs-bridge\build\Release\obs_bridge.node") (Join-Path $BIN "obs-bridge\obs_bridge.node")
Get-ChildItem -Path $BUILD -Recurse -Filter *.dll | Where-Object { $_.FullName -notmatch "test" } | ForEach-Object {
  Copy-Item -Force $_.FullName (Join-Path $BIN "obs\bin\64bit\")
}
if (Test-Path (Join-Path $BUILD "rundir")) { Copy-Item -Recurse -Force (Join-Path $BUILD "rundir\*") (Join-Path $BIN "obs\data\") }

Write-Host "::notice::build-native done"
