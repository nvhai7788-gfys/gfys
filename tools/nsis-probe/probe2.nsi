Unicode true
!define APP_EXECUTABLE_FILENAME "港丰影视直播工作台.exe"
!define PRODUCT_NAME "港丰影视直播工作台"
OutFile "/tmp/nsis_probe/probe2.exe"
!include "LogicLib.nsh"
!include "/Users/dengychen/WorkBuddy/2026-09-26-11-28-19/tencent-live-workbench/build/installer.nsh"

!ifmacrodef customCheckAppRunning
  !define OUR_MACRO_PRESENT
!else
  !error "customCheckAppRunning 未被定义——include 未生效"
!endif
!ifndef OUR_MACRO_PRESENT
  !error "unreachable"
!endif

Section "probe"
  !insertmacro customCheckAppRunning
  !insertmacro customCheckAppRunning   ; 连续两次插入：若标签非局部会在此报重复定义
SectionEnd
