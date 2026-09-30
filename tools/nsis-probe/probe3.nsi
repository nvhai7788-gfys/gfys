Unicode true
!define APP_EXECUTABLE_FILENAME "港丰影视直播工作台.exe"
!define PRODUCT_NAME "港丰影视直播工作台"
OutFile "/tmp/nsis_probe/probe3.exe"
!include "LogicLib.nsh"
!include "/Users/dengychen/WorkBuddy/2026-09-26-11-28-19/tencent-live-workbench/build/installer.nsh"

!ifmacrodef customCheckAppRunning
!else
  !error "customCheckAppRunning 未定义"
!endif
!ifmacrodef customInstall
!else
  !error "customInstall 未定义"
!endif

Section "install"
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\港丰影视直播工作台"
  !insertmacro customCheckAppRunning
  !insertmacro customCheckAppRunning   ; 同 section 重复插入：标签 uid 化验证
  !insertmacro customInstall
SectionEnd
