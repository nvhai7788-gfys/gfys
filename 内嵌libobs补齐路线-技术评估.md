# 内嵌 libobs 补齐路线 —— 技术评估

> 评估对象：港丰影视直播工作台「本地推流模块」完全对齐 OBS 能力的剩余差距
> 评估日期：2026-10-01
> 前提结论：**"本地推流模块内嵌 libobs（引擎库，非完整 OBS UI）" 可行且已在大半路上了**；完整编译 OBS Studio（含 Qt UI）不可行也无必要。

---

## 一、先回答核心问题

**问题：本地推流模块内嵌或完全编译 OBS 代码，能否实现？**

| 路线 | 含义 | 结论 |
|---|---|---|
| **A. 内嵌 libobs（引擎库）** | 只编译 OBS 核心引擎 `libobs` + 必要插件，`ENABLE_UI=OFF` 不装 Qt，通过 N-API 桥接进 Electron | ✅ **可行，当前已完成约 70%，这是唯一正确路线** |
| **B. 完全编译 OBS Studio** | 编译整个 OBS 含 UI、Qt、全部插件 | ❌ 不可行也没必要：Qt UI 无法"嵌入" Electron 界面（两个 GUI 框架冲突），体积数百 MB，且你要的是引擎能力不是 OBS 界面 |

**你现在的项目走的就是路线 A**（Streamlabs Desktop 同款思路：fork OBS 引擎 + 自建 UI）。

---

## 二、当前真实实现度（基于代码事实，非印象）

### 2.1 已实现（v1.1.38 / 1.1.39，三平台 CI 编译通过）

`native/obs-bridge/src/obs_bridge.cpp` 共 **17 个 N-API 接口**，全部落地：

| 能力 | 接口 | 状态 |
|---|---|---|
| 引擎生命周期 | `startup` / `shutdown` / `available` / `getVersion` | ✅ 完整（含 video/audio reset、模块加载路径） |
| 场景图镜像 | `createScene` / `setProgramScene` / `destroyScene` | ✅ 完整 |
| 来源管理 | `addSource` / `updateSource` / `removeSource` / `reorderSource` | ✅ 完整（settings 走 `obs_data_create_from_json`） |
| 变换 | `setTransform`（pos/scale/rot/visible/crop） | ✅ 完整，布局数学在 JS 层算好 |
| 显隐 | `setEnabled` | ✅ |
| 设备枚举 | `enumDevices`（摄像头/显示器，平台化 dshow/av_capture） | ✅ |
| RTMP 推流 | `startStream` / `stopStream`（rtmp_common + obs_x264 + ffmpeg_aac） | ✅ |

**JS 适配器层** `libobs-engine.js`：颜色 `#rrggbb→ABGR`、来源 id 平台化、布局数学、addon 双路径加载、引擎不可用自动回退 ffmpeg——均已完成。

**ffmpeg 兜底引擎**：7 类来源全部真实出画（v1.1.37）。

### 2.2 未实现（差距项）

| 差距项 | 当前状态 | 涉及层级 |
|---|---|---|
| ① **实时预览回读**（`renderPreview`） | ⚠️ **占位**，返回 `{ok:false}` | 桥接层（核心） |
| ② **多源音频混音** | ❌ 完全缺失（libobs 有 `amix` 但未暴露；ffmpeg 侧也无 `amix`） | 桥接 + 渲染数据模型 |
| ③ **场景过渡** | ❌ 未镜像（`obs-transitions` 插件已编译，但桥接无 `transition` 接口） | 桥接 + 渲染数据模型 + UI |
| ④ **源滤镜** | ❌ 未镜像（`obs-filters` 已编译，但桥接无 filter 接口） | 桥接 + 渲染数据模型 + UI |

---

## 三、差距项逐一评估

### ③ ④ 前置发现（影响全局架构判断）

**渲染层 `scene-engine.js` 目前只有 7 类来源注册，没有过渡/滤镜/音频混音的数据模型。** 这意味着 ②③④ 不是"桥接层加几个接口"这么简单，而是**五层联动**：

```
渲染层数据模型(scene-engine.js) → UI(index.html) → IPC(preload.js) → 主进程(main.js) → 原生桥接(obs_bridge.cpp)
```

其中，桥接层反而是**最简单**的一层（libobs 的 C API 直接对应），难点在渲染层数据模型与 UI 交互设计。

---

### ① 实时预览回读（最关键，唯一"硬骨头"）

**目标**：把 libobs 合成好的帧实时送回 Electron 渲染进程显示。

**技术路径**（libobs 标准做法）：
1. 创建 `obs_view`（或复用 program 输出源），`obs_view_render` 触发渲染
2. `gs_stagesurface_create` + `gs_stage_texture` 把 GPU 纹理 staging 到可读内存
3. `gs_texture_map` 回读成 RGBA 缓冲
4. 通过 N-API 返回 `ArrayBuffer`，前端 `canvas.putImageData` 或 `webgl` 上屏

**关键约束与风险**（必须如实说明）：

| 约束 | 说明 |
|---|---|
| **GPU 上下文归属** | libobs 的 `obs_reset_video` 在**主进程**建立 D3D11/OpenGL 上下文；但 Electron 的窗口/渲染在**渲染进程**。跨进程共享纹理是核心难点（需 `gs_shared_texture` / 共享句柄 / 回读 CPU 缓冲跨 IPC 传输） |
| **性能** | 1080p RGBA 每帧约 8MB，30fps = 240MB/s，走 IPC 会压垮渲染进程。**必须降采样 + 用共享内存/零拷贝**，不能朴素 `napi_create_buffer` 每帧拷贝 |
| **沙箱不可验证** | 本机 `ELECTRON_RUN_AS_NODE=1` + 无 GUI + 无 GPU，**只能 CI 编译验证能过，运行时表现必须真机确认** |
| **线程安全** | libobs 渲染在专用线程，回读需在 `obs_source` 的 video tick 回调里做，N-API 跨线程需 `napi_threadsafe_function` |

**工作量评估**：**中-高**。这是唯一涉及图形 API 同步 + 跨进程 + 线程安全的硬骨头，需要真机 + GPU 迭代。

**降级方案（推荐先做）**：不必一开始做"真引擎实时预览"。可以先做 **ffmpeg 侧预览**（ffmpeg 输出到 `-f rawvideo` 或抽帧，读 JPEG 帧显示），因为 ffmpeg 兜底引擎已能出画。等 libobs 预览回读打磨成熟后再切。

---

### ② 多源音频混音

**目标**：多个来源（媒体源、摄像头、麦克风）的音频混合后推流。

**现状**：
- libobs 本身**自带音频混音**——所有 `obs_source` 的音频会自动混入 `obs_get_audio()`（`startup` 已 `obs_reset_audio` 建立 48kHz stereo）。所以 **libobs 引擎的音频混音其实是"免费"的**，只要来源带了音频。
- 真正缺的是**细粒度控制**：每个来源的音量（`obs_source_set_volume`）、静音（`obs_source_set_muted`）、音频源单独采集（麦克风）。

**技术路径**：桥接层补 `setSourceVolume` / `setSourceMuted` 等 3~4 个接口即可，纯逻辑，风险低。

**工作量评估**：**低**。可在本机 jsdom 验证逻辑，桥接层加接口 CI 编译即可。

---

### ③ 场景过渡

**目标**：切换 program 场景时用淡入淡出/滑动等过渡动画。

**现状**：`obs-transitions` 插件已在 CI 编译（build-native 明确列了 `obs-transitions`），**依赖已就绪**，只差桥接接口。

**技术路径**：
- `obs_transition_create("fade_transition", ...)` 等
- 桥接层补 `createTransition` / `setTransition` / `triggerTransition`
- 但**渲染层要有"预览场景 + 过渡配置"的数据模型**（OBS 的 studio mode：preview/program 双场景），这需要 UI 大改

**工作量评估**：**中**（桥接层简单，UI/数据模型中等）。

---

### ④ 源滤镜

**目标**：给单个来源加滤镜（色键、缩放、LUT 等）。

**现状**：`obs-filters` 插件已编译，依赖就绪。

**技术路径**：`obs_source_filter_add` / `obs_source_filter_remove`，桥接层补接口；渲染层补"来源属性面板 + 滤镜列表" UI。

**工作量评估**：**中**（桥接简单，UI 中等）。

---

## 四、补齐优先级与路线建议

### 推荐顺序（按 ROI 排序）

| 优先级 | 项 | 理由 | 能否沙箱验证 |
|---|---|---|---|
| **P1** | ② 音频混音控制 | ROI 最高、风险最低、libobs 天然支持 | ✅ 逻辑可 jsdom 验证 |
| **P2** | ④ 源滤镜 | 依赖已就绪，桥接简单 | ⚠️ 逻辑可测，效果需真机 |
| **P3** | ③ 场景过渡 | 依赖已就绪，但需 UI studio-mode 改造 | ⚠️ 需真机看动画效果 |
| **P4** | ① 实时预览回读 | 价值最高但最硬，需 GPU+真机 | ❌ 必须真机 |

### 关键结论

1. **"完全对齐 OBS" 的瓶颈不在 libobs，而在渲染层数据模型 + UI + 跨进程预览**。原生桥接层是五层里最简单的一层。
2. **预览回读（①）是唯一真正难啃的骨头**，且**沙箱无法验证**，建议最后做、配合真机迭代。
3. **音频混音（②）是"免费午餐"**——libobs 已自动混音，只需补音量/静音控制接口，性价比最高。
4. 若目标是"本地推流体验先能用"，**优先补 ② 音频控制 + ffmpeg 侧预览**，即可让"本地推流+录制+多源"闭环，不必等 libobs 预览回读。

---

## 五、明确不建议做的事

- ❌ **完整编译 OBS Studio（含 Qt UI）**：体积数百 MB，Qt 与 Electron 两个 GUI 框架冲突，无法嵌入，纯属浪费。
- ❌ **朴素每帧 IPC 拷贝预览帧**：1080p 30fps 会打爆渲染进程，必须降采样 + 共享内存。
- ❌ **在本机沙箱里试图验证预览回读**：`ELECTRON_RUN_AS_NODE=1` + 无 GPU，只能 CI 编译验证，运行效果必须真机。

---

## 六、后续动作（供决策）

若要推进，建议按以下节奏：

1. **本轮先做 P1（音频控制）**：桥接层补 `setSourceVolume`/`setSourceMuted` + 渲染层来源音量属性 + 回归测试。风险低、可沙箱验证、立竿见影。
2. **P2/P3（滤镜/过渡）** 视 UI 改造工作量决定是否合并做。
3. **P4（预览回读）** 单独立项，明确"必须真机 + GPU 迭代"，先出 ffmpeg 侧预览兜底。

> 本评估为方案性文档，未改动任何代码。是否进入 P1 实现，等你确认。
