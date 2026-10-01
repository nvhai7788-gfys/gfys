# obs-bridge —— libobs 原生桥接（node-gyp）
#
# 说明：本 addon 依赖 libobs（OBS Studio 的 libobs 库 + 头文件）。
# libobs 由 CI（scripts/build-native.*）从 obs-studio 源码用 CMake 先行构建，
# 产出后通过 GYP_DEFINES 环境变量把「头文件目录 / 库文件目录」注入进来。
# 注意：node-gyp 的 gyp 不读普通 shell 环境变量，必须用 GYP_DEFINES 传变量，
#       在 binding.gyp 里用 <(VAR) 引用（不是 %(VAR)s）。
#
#   OBS_INCLUDE_DIR   —— obs-studio/libobs 头文件根（含 graphics/util 子目录）
#   OBS_LIB_DIR       —— libobs 库所在目录（Windows: obs.lib / mac: libobs.dylib / linux: libobs.so）
#   OBS_DEPS_INCLUDE  —— obs-studio/deps（可选的 FFmpeg 等头文件目录）
#   OBS_MODULE_DIR    —— libobs 运行时插件模块目录（obs-plugins 编译产物）
#
# 用法（在 src/native/obs-bridge 下，由 build-native.* 设置 GYP_DEFINES）：
#   npx node-gyp rebuild
#
{
  "targets": [
    {
      "target_name": "obs_bridge",
      "sources": [ "src/obs_bridge.cpp" ],
      "include_dirs": [
        "<(OBS_INCLUDE_DIR)",
        "<(OBS_INCLUDE_DIR)/graphics",
        "<(OBS_INCLUDE_DIR)/util",
        "<(OBS_DEPS_INCLUDE)"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "cflags_cc": [ "-std=c++17", "-fexceptions" ],
      "conditions": [
        [ "OS=='win'", {
          # Windows: libobs 目标设了 OUTPUT_NAME "obs"（见 libobs/cmake/os-windows.cmake），
          # 故导入库是 obs.lib（不是 libobs.lib）。
          "libraries": [ "<(OBS_LIB_DIR)/obs.lib" ],
          "defines": [ "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX" ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": [ "/std:c++17", "/EHsc" ],
              "RuntimeLibrary": "2",
              "ExceptionHandling": "1"
            }
          }
        }],
        [ "OS=='mac'", {
          "libraries": [ "<(OBS_LIB_DIR)/libobs.dylib" ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_LDFLAGS": [ "-framework", "Cocoa", "-framework", "CoreVideo", "-framework", "CoreMedia", "-framework", "AVFoundation" ]
          }
        }],
        [ "OS=='linux'", {
          "libraries": [ "<(OBS_LIB_DIR)/libobs.so" ]
        }]
      ]
    }
  ]
}
