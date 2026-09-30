# NSIS 编译探针（macOS 可用）

验证 build/installer.nsh 的宏能被编译、标签无冲突。

## 用法
export NSISDIR=~/Library/Caches/electron-builder/nsis/nsis-3.0.4.1
MK=~/Library/Caches/electron-builder/nsis/nsis-3.0.4.1/mac/makensis
$MK -V2 probe.nsi   # 基础：宏展开编译通过
$MK -V2 probe2.nsi  # 加强：断言宏已定义 + 同 section 重复插入不冲突（标签 uid 化）

NSISDIR 环境变量是关键（mac 版 makensis 前缀写死 /usr/local/share/nsis，
无 NSISDIR 会报 reading stub 错；解法来自 electron-builder NsisTarget.js L521）。
