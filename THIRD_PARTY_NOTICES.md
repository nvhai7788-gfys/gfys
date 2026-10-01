# 第三方开源组件引用说明（THIRD-PARTY NOTICES）

本文件列出「港丰影视直播工作台」在开发与运行过程中引用的第三方开源组件、代码来源及其许可证。各组件版权归其原作者（组织）所有。

> 说明：本清单以「实际引入的组件」为准，许可证信息取自各组件官方仓库的 LICENSE 文件，如有版本升级请以对应版本的许可证为准。

## 运行时前端组件（renderer/vendor/）

| 组件 | 版本 | 用途 | 许可证 | 来源 |
|---|---|---|---|---|
| mpegts.js | 引入于 `renderer/vendor/mpegts.min.js` | FLV 直播流播放 | Apache-2.0 | https://github.com/xqq/mpegts.js |
| hls.js | 引入于 `renderer/vendor/hls.min.js` | HLS 直播流播放 | Apache-2.0 | https://github.com/video-dev/hls.js |
| Apache ECharts | 引入于 `renderer/vendor/echarts.min.js` | 数据可视化图表 | Apache-2.0 | https://github.com/apache/echarts |

## 桌面框架与构建

| 组件 | 用途 | 许可证 | 来源 |
|---|---|---|---|
| Electron | 桌面应用运行时框架 | MIT | https://github.com/electron/electron |
| electron-builder | 安装包（NSIS / ZIP / DMG）构建 | MIT | https://github.com/electron-userland/electron-builder |
| node-gyp | 原生模块（libobs 桥接）编译 | MIT | https://github.com/nodejs/node-gyp |
| node-addon-api (N-API) | C++ 原生桥接层接口 | MIT | https://github.com/nodejs/node-addon-api |

## 音视频与引擎

| 组件 | 用途 | 许可证 | 来源 |
|---|---|---|---|
| FFmpeg | 本地推流 / 录制 / 多源合成（内置 `ffmpeg` 二进制） | LGPL-2.1-or-later（具体取决于编译配置，含 GPL 组件时整体为 GPL） | https://ffmpeg.org / https://github.com/FFmpeg/FFmpeg |
| OBS Studio（libobs） | libobs 真引擎（场景图 / 源 / 推流输出） | GPL-2.0 | https://github.com/obsproject/obs-studio |
| obs-transitions | 场景过渡插件（`fade_transition` 等） | GPL-2.0（随 OBS Studio） | https://github.com/obsproject/obs-studio/tree/master/plugins/obs-transitions |
| obs-filters | 源滤镜插件（色彩校正 / 缩放等） | GPL-2.0（随 OBS Studio） | https://github.com/obsproject/obs-studio/tree/master/plugins/obs-filters |

## 引用的代码与接口（非运行时依赖，学习 / 对齐实现）

| 来源 | 说明 | 许可证 |
|---|---|---|
| obs-studio `libobs/obs-source-transition.h` | `obs_transition_set` / `obs_transition_start` / `obs_transition_set_size` 等过渡 API 的签名与语义（用于 `native/obs-bridge/src/obs_bridge.cpp`） | GPL-2.0 |
| obs-studio `libobs/graphics/graphics.h`、`texrender.h` | `gs_texrender_*` / `gs_stagesurface_*` 预览回读 API | GPL-2.0 |
| 腾讯云 / 阿里云 OpenAPI 签名规范 | TC3-HMAC-SHA256 / ACS3-HMAC-SHA256 签名算法实现 | 官方文档（服务条款见各云官网） |

## 许可合规提示

1. **libobs / OBS Studio 为 GPL-2.0**：本软件通过 `native/obs-bridge`（N-API 桥接）动态链接 libobs，或将 libobs 作为独立进程 / 模块使用，请遵循 GPL-2.0 的传染性要求，必要时向最终用户提供对应组件源码获取途径。
2. **FFmpeg**：内置的 `ffmpeg` 二进制为预编译产物，其许可证取决于编译时启用的编解码器（含 GPL 组件则整体 GPL，否则 LGPL）。分发时应附带 FFmpeg 的许可证文本与 configure 选项说明。
3. **Apache-2.0 / MIT 组件**：分发时需保留其 LICENSE 与版权声明（NOTICE 文件如有也需保留）。
4. 本软件自身代码许可见项目 `package.json`（`license: MIT`）及仓库 LICENSE 文件。

---

*本清单随版本更新维护；新增第三方组件时应同步在此登记来源与许可证。*
