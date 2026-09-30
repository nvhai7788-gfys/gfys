# obs-bridge —— 可选构建路径（cmake-js）
#
# 说明：主构建路径是 binding.gyp（node-gyp）。此 CMakeLists 是给 cmake-js 的等价路径，
#       libobs 头文件/库目录通过环境变量 OBS_INCLUDE_DIR / OBS_LIB_DIR 注入。
#
# 用法（在 src/native/obs-bridge 下）：
#   OBS_INCLUDE_DIR=... OBS_LIB_DIR=... npx cmake-js compile
cmake_minimum_required(VERSION 3.15)
project(obs_bridge)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_definitions(-DNAPI_VERSION=8)

if(NOT DEFINED OBS_INCLUDE_DIR)
  set(OBS_INCLUDE_DIR "$ENV{OBS_INCLUDE_DIR}")
endif()
if(NOT DEFINED OBS_LIB_DIR)
  set(OBS_LIB_DIR "$ENV{OBS_LIB_DIR}")
endif()
if(NOT DEFINED OBS_MODULE_DIR)
  set(OBS_MODULE_DIR "$ENV{OBS_MODULE_DIR}")
endif()

include_directories(
  ${OBS_INCLUDE_DIR}
  ${OBS_INCLUDE_DIR}/graphics
  ${OBS_INCLUDE_DIR}/util
)

add_library(${PROJECT_NAME} SHARED src/obs_bridge.cpp)
# 产物统一叫 obs_bridge.node（.node 供 Node require 加载）
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

if(WIN32)
  target_link_libraries(${PROJECT_NAME} PRIVATE ${OBS_LIB_DIR}/obs.lib)
  target_compile_definitions(${PROJECT_NAME} PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
elseif(APPLE)
  target_link_libraries(${PROJECT_NAME} PRIVATE ${OBS_LIB_DIR}/libobs.dylib)
  target_link_libraries(${PROJECT_NAME} PRIVATE
    "-framework Cocoa" "-framework CoreVideo" "-framework CoreMedia" "-framework AVFoundation")
else()
  target_link_libraries(${PROJECT_NAME} PRIVATE ${OBS_LIB_DIR}/libobs.so)
endif()
