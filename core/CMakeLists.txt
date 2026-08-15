cmake_minimum_required(VERSION 3.28...3.30)

project(shard-core VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")
endif()

# ---------------------------------------------------------------------------
# OBS Studio (libobs + plugins) as an embedded subdirectory.
# The obs-studio CMake downloads its own prebuilt deps (obs-deps) into
# vendor/obs-studio/.deps at configure time and registers them on
# CMAKE_PREFIX_PATH (see cmake/common/buildspec_common.cmake).
# ---------------------------------------------------------------------------
set(ENABLE_FRONTEND OFF CACHE BOOL "Disable Qt frontend (we embed libobs)" FORCE)
set(ENABLE_SCRIPTING OFF CACHE BOOL "Disable Lua/Python scripting" FORCE)
set(ENABLE_BROWSER OFF CACHE BOOL "Disable obs-browser (needs CEF)" FORCE)
set(ENABLE_WEBSOCKET OFF CACHE BOOL "Disable obs-websocket (needs Qt)" FORCE)
set(ENABLE_VLC OFF CACHE BOOL "Disable vlc-video plugin" FORCE)

add_subdirectory(../vendor/obs-studio obs-studio)

# ---------------------------------------------------------------------------
# Third-party deps (header-first, cross-platform, Linux-ready)
# ---------------------------------------------------------------------------
include(FetchContent)

FetchContent_Declare(
  nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG v3.11.3
  GIT_SHALLOW TRUE
)
set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(nlohmann_json)

FetchContent_Declare(
  ixwebsocket
  GIT_REPOSITORY https://github.com/machinezone/IXWebSocket.git
  GIT_TAG v11.4.5
  GIT_SHALLOW TRUE
)
set(USE_SSL OFF CACHE BOOL "" FORCE)
set(USE_WS_SSL OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(ixwebsocket)

# ---------------------------------------------------------------------------
# clipcore
# ---------------------------------------------------------------------------
add_executable(clipcore
  src/main.cpp
  src/app.cpp
  src/config.cpp
  src/sources.cpp
  src/encoders.cpp
  src/mux.cpp
  src/replay_ring.cpp
  src/recorder.cpp
  src/game_detect.cpp
  src/jsonrpc.cpp
  src/server.cpp
)

target_include_directories(clipcore PRIVATE src)

target_link_libraries(clipcore PRIVATE OBS::libobs ixwebsocket::ixwebsocket nlohmann_json::nlohmann_json)

target_compile_definitions(clipcore PRIVATE CLIPFORGE_VERSION="${PROJECT_VERSION}")

if(WIN32)
  target_compile_definitions(clipcore PRIVATE _CRT_SECURE_NO_WARNINGS WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(clipcore PRIVATE d3d11.lib dxgi.lib uuid.lib ole32.lib)
endif()
