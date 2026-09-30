# obs-bridge —— libobs 真引擎原生桥接

把港丰影视直播工作台的 OBS 场景/来源/变换数据模型，镜像进 **libobs（OBS Studio 引擎）**，
提供：引擎生命周期、场景图镜像、设备枚举、RTMP 推流输出。

## 依赖

- **libobs**：由 OBS Studio 源码（`obs-studio`）用 CMake 编译产出。本 addon 仅链接 `libobs`
  及必要插件模块（`obs-x264`、`obs-ffmpeg`、`rtmp-services`、`obs-outputs`、`dshow`/`av-capture`/`mac-*`）。
- **Node 原生工具链**：node-gyp（主路径）或 cmake-js（备选）。

> 本地沙箱**无法编译**本 addon（无 CMake / MSVC / Xcode）。编译在 **GitHub Actions CI**
> （macOS Xcode + Windows MSVC）上完成，见 `.github/workflows/build.yml`。

## 构建（CI 内执行）

```bash
# 1) 构建 obs-studio（产出 libobs + 插件模块）
bash scripts/build-native.sh        # macOS
# 或
powershell -File scripts/build-native.ps1   # Windows

# 2) 编译本 addon（binding.gyp 主路径）
cd src/native/obs-bridge
OBS_INCLUDE_DIR="$OBS_ROOT/libobs" \
OBS_LIB_DIR="$OBS_BUILD/libobs" \
npx node-gyp rebuild
```

## 暴露的 N-API 接口

| 方法 | 说明 |
|---|---|
| `startup(config)` | 启动 libobs + reset video/audio |
| `shutdown()` | 停推流、清场景、关引擎 |
| `available()` / `getVersion()` | 状态 / libobs 版本 |
| `createScene(name)` / `setProgramScene(name)` / `destroyScene(name)` | 场景管理 |
| `addSource(scene, typeId, name, settingsJson)` | 添加来源 |
| `updateSource(scene, name, settingsJson)` | 更新来源设置 |
| `setTransform(scene, name, x, y, sx, sy, rot, visible, cL, cT, cR, cB)` | 设置变换 |
| `setEnabled(scene, name, enabled)` | 显隐 |
| `removeSource(scene, name)` / `reorderSource(scene, name, to)` | 删除 / 排序 |
| `enumDevices(category)` | 枚举摄像头 / 显示器 |
| `startStream(url, key, bitrateKbps, fps)` / `stopStream()` | RTMP 推流 |
| `renderPreview()` | 预览帧回读（Phase 2 占位） |

## 待办

- **预览帧回读**（`renderPreview`）：需在 Electron 渲染线程建立 GPU 上下文后做
  `obs_view + gs_stagesurface` 回读 RGBA，当前为占位接口。
