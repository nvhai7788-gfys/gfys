; 编译级探针：验证 build/installer.nsh 的宏语法 + 关键内容确实编入
Unicode true
!define APP_EXECUTABLE_FILENAME "港丰影视直播工作台.exe"
!define PRODUCT_NAME "港丰影视直播工作台"
!define APP_GUID "9f3e1a2b-0000-4000-8000-5f6e8a7b9c1d"
OutFile "/tmp/nsis_probe/probe.exe"
!include "LogicLib.nsh"
!include "${NSISDIR}\Include\MUI.nsh"
!include "/Users/dengychen/WorkBuddy/2026-09-26-11-28-19/tencent-live-workbench/build/installer.nsh"

Section "probe"
  !insertmacro customCheckAppRunning
  ; 探针：宏体确实展开（文件锁判据存在）
  DetailPrint "PROBE_OK"
SectionEnd
