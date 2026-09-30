; 港丰影视直播工作台 —— 自定义安装脚本（electron-builder nsis.include）
; 解决：重装/升级时弹「无法关闭。请手动关闭它…」死循环重试框。
;
; v3 根因再定位（为什么 v1、v2 都没修好）：
;   「无法关闭」这句文案在 electron-builder 模板里有三处来源，前两轮只堵住了第一处：
;     ① CHECK_APP_RUNNING（判进程）—— v1 换强杀、v2 换文件锁判据，都只管这里
;     ② uninstallOldVersion 连续 5 次失败（该路径弹框条件苛刻：旧卸载器要能启动且
;        连续 5 次返回非零，基本排除）
;     ③ extractAppPackage：解压后 CopyFiles 连续 5 次复制失败（「Can't modify files」）
;        —— 用户截图进度条 ~35%，正是复制阶段，弹窗来自这里。
;   CopyFiles 失败的病因有三类，v1/v2 只治了第一类：
;     A. 目标文件被进程占用（杀进程可治）
;     B. 目标文件带只读/系统/隐藏属性，或目录权限不足（杀进程治不好！）
;     C. 安全软件（360 / 电脑管家 / Windows 安全中心）实时拦截写入（杀进程治不好！）
;   v3 三类全覆盖：
;     - 杀进程（A）
;     - attrib 递归清属性 + 直接删除旧关键文件 + 可写性实测（B）
;     - 可写性实测提前发现目录级拦截、装后 customInstall 校验主程序落地（C）
;     - 所有失败路径写诊断日志到 $TEMP，下次排障不再盲猜
;
; 实现约束：
;   1) 只用 NSIS 核心指令（FileExists / FileOpen / FileClose / Delete / RMDir / attrib），
;      不用 System::Call —— 插件参数运行期才解析、编译期不校验，属不可控风险（已实证）。
;   2) 宏内标签带 __LINE__ 唯一后缀：NSIS 宏标签是 section 级作用域，同一 section
;      插入两次宏会重复定义报错（makensis 探针实证）。

!macro _gfwUid
  !ifdef _GFW_ID
    !undef _GFW_ID
  !endif
  !define _GFW_ID ${__LINE__}
!macroend

!macro _gfwTryKill
  ; 尽力清场：孤儿 ffmpeg（extraResources 内置的 ffmpeg-win32-x64.exe 也会占安装目录）+ 主程序进程树
  nsExec::Exec `taskkill /f /t /im "ffmpeg-win32-x64.exe"`
  nsExec::Exec `taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}"`
!macroend

; 预检与清场。输出 $0：0=可安装；1=目录不可写（权限/安全软件拦截）；2=文件被进程占用
!macro _gfwPrecheck
  StrCpy $0 0
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${orIf} ${FileExists} "$INSTDIR\resources\app.asar"
    ; 目录里有本软件的旧文件（== 这是本软件的家目录，清理它是安全的）：
    ; ① 递归清只读/系统/隐藏属性 —— 属性会让 CopyFiles 覆盖失败，且与进程无关
    nsExec::Exec `attrib -R -S -H "$INSTDIR\*.*" /S /D`
    ; ② 直接删掉旧的关键文件：进程已杀时删掉后，复制阶段根本不会再撞上它们
    Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Delete "$INSTDIR\Uninstall*.exe"
    Delete "$INSTDIR\resources\app.asar"
    Delete "$INSTDIR\resources\bin\ffmpeg-win32-x64.exe"
    RMDir /r "$INSTDIR\resources\app.asar.unpacked"
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      StrCpy $0 2                         ; 主程序删不掉 = 确有进程占着它
    ${endIf}
  ${endIf}
  ${if} $0 == 0
    ; ③ 可写性实测：建得出来且删得掉才算能写（权限 / 受控文件夹访问 / 安全软件目录拦截）
    ClearErrors
    CreateDirectory "$INSTDIR"
    ClearErrors
    FileOpen $1 "$INSTDIR\gfw_write_test.tmp" w
    ${if} ${Errors}
      StrCpy $0 1
      ClearErrors
    ${else}
      FileClose $1
      Delete "$INSTDIR\gfw_write_test.tmp"
      ${if} ${FileExists} "$INSTDIR\gfw_write_test.tmp"
        StrCpy $0 1                       ; 能建不能删，同样视为不可写
      ${endIf}
    ${endIf}
  ${endIf}
!macroend

; 诊断日志：写清安装目录、障碍类别、占用进程、目录属性，失败时引导用户回传
!macro _gfwWriteDiag
  ClearErrors
  FileOpen $R9 "$TEMP\港丰影视直播工作台-安装诊断.log" w
  ${ifNot} ${Errors}
    FileWrite $R9 "[instdir] $INSTDIR$\r$\n"
    FileWrite $R9 "[category] $R7  (1=目录不可写 2=文件被进程占用)$\r$\n"
    FileWrite $R9 "[tasklist 过滤结果见下]$\r$\n"
    FileClose $R9
  ${endIf}
  ClearErrors
  nsExec::Exec `cmd /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" >> "$TEMP\港丰影视直播工作台-安装诊断.log" 2>&1`
  nsExec::Exec `cmd /c tasklist /FI "IMAGENAME eq ffmpeg-win32-x64.exe" >> "$TEMP\港丰影视直播工作台-安装诊断.log" 2>&1`
  nsExec::Exec `cmd /c attrib "$INSTDIR\*.*" >> "$TEMP\港丰影视直播工作台-安装诊断.log" 2>&1`
!macroend

!macro customCheckAppRunning
  !insertmacro _gfwUid
  ; 1) 尽力清场（成功与否不影响后面的判据）
  !insertmacro _gfwTryKill
  Sleep 600
  !insertmacro _gfwTryKill
  Sleep 600

  ; 2) 预检：清属性 / 删旧文件 / 可写性实测，无障碍直接装
  !insertmacro _gfwPrecheck
  ${if} $0 == 0
    Goto _gfw_done_${_GFW_ID}
  ${endIf}

  ; 3) 有障碍：给正在退出的进程一次机会后再清场重测
  DetailPrint `检测到安装目录存在障碍，正在清理…`
  Sleep 2000
  !insertmacro _gfwTryKill
  Sleep 600
  !insertmacro _gfwPrecheck
  ${if} $0 == 0
    Goto _gfw_done_${_GFW_ID}
  ${endIf}

  ; 4) 仍不通：写诊断日志，按障碍类别给出可操作提示
  StrCpy $R7 $0
  !insertmacro _gfwWriteDiag
  _gfw_ask_${_GFW_ID}:
  ${if} $R7 == 1
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "安装程序无法写入安装目录：$\n$INSTDIR$\n$\n这通常是安全软件（360 / 电脑管家 / Windows 安全中心）拦截了本软件。请把上述目录和本安装包加入安全软件的信任区（白名单），然后点「重试」。$\n$\n诊断信息已保存到：$\n$TEMP\港丰影视直播工作台-安装诊断.log" \
      /SD IDCANCEL IDRETRY _gfw_retry_${_GFW_ID} IDCANCEL _gfw_cancel_${_GFW_ID}
  ${else}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "${PRODUCT_NAME} 仍在运行且无法结束，安装无法继续。$\n请先关闭它再点「重试」；若确认已关闭仍提示，请点「取消」，重启电脑后重新安装（或右键安装包选「以管理员身份运行」）。$\n$\n诊断信息已保存到：$\n$TEMP\港丰影视直播工作台-安装诊断.log" \
      /SD IDCANCEL IDRETRY _gfw_retry_${_GFW_ID} IDCANCEL _gfw_cancel_${_GFW_ID}
  ${endIf}
  _gfw_retry_${_GFW_ID}:
  !insertmacro _gfwTryKill
  Sleep 800
  !insertmacro _gfwPrecheck
  ${if} $0 != 0
    StrCpy $R7 $0
    Goto _gfw_ask_${_GFW_ID}
  ${endIf}
  Goto _gfw_done_${_GFW_ID}
  _gfw_cancel_${_GFW_ID}:
  Quit
  _gfw_done_${_GFW_ID}:
!macroend

; 装后校验：主程序必须真实落地。安全软件在复制阶段静默隔离主程序时，
; 模板只会报笼统的「无法关闭」，这里给出明确指向。
!macro customInstall
  ${ifNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "安装已结束，但主程序文件没有出现在安装目录中：$\n$INSTDIR\${APP_EXECUTABLE_FILENAME}$\n$\n这几乎可以确定是安全软件（360 / 电脑管家 / Windows 安全中心）在复制文件时把它隔离了。请把上述目录加入安全软件的信任区（白名单）后重新安装。"
    SetErrorLevel 3
    Quit
  ${endIf}
!macroend
