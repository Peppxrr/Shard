cmake_minimum_required(VERSION 3.28...3.30)

project(shard-core VERSION 0.1.2 LANGUAGES C CXX)

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

# The target-side Game Capture payload is the official signed OBS release,
# staged separately from the embedded host plugin. win-capture verifies this
# directory and embeds its manifest values for runtime checks.
set(SHARD_OBS_HOOK_PAYLOAD_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../vendor/obs-hook-payload/32.2.1"
    CACHE PATH "Pinned official OBS Game Capture payload" FORCE)

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

if(WIN32)
  FetchContent_Declare(
    nasm_bin
    URL https://www.nasm.us/pub/nasm/releasebuilds/2.16.03/win64/nasm-2.16.03-win64.zip
    URL_HASH SHA256=3ee4782247bcb874378d02f7eab4e294a84d3d15f3f6ee2de2f47a46aa7226e6
  )
  FetchContent_MakeAvailable(nasm_bin)
  set(NASM_EXECUTABLE "${nasm_bin_SOURCE_DIR}/nasm.exe" CACHE FILEPATH "" FORCE)
endif()

# CPU HEVC encoder. Static libx265 keeps the runtime self-contained; its
# SIMD assembly is enabled on Windows with the pinned NASM tool above.
FetchContent_Declare(
  x265
  URL https://bitbucket.org/multicoreware/x265_git/downloads/x265_4.1.tar.gz
  URL_HASH SHA256=a31699c6a89806b74b0151e5e6a7df65de4b49050482fe5ebf8a4379d7af8f29
  SOURCE_SUBDIR source
  PATCH_COMMAND "${CMAKE_COMMAND}" "-DSOURCE_DIR=<SOURCE_DIR>"
                -P "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/patch-x265.cmake"
)
set(ENABLE_SHARED OFF CACHE BOOL "" FORCE)
set(ENABLE_CLI OFF CACHE BOOL "" FORCE)
set(ENABLE_HDR10_PLUS OFF CACHE BOOL "" FORCE)
set(ENABLE_ASSEMBLY ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(x265)

# ---------------------------------------------------------------------------
# shardcore
# ---------------------------------------------------------------------------
set(SHARDCORE_PLATFORM_SOURCES)
if(WIN32)
  set(SHARD_ICON_PATH "${CMAKE_CURRENT_SOURCE_DIR}/../app/build/icon.ico")
  configure_file(src/shardcore.rc.in "${CMAKE_CURRENT_BINARY_DIR}/shardcore.rc" @ONLY)
  list(APPEND SHARDCORE_PLATFORM_SOURCES "${CMAKE_CURRENT_BINARY_DIR}/shardcore.rc")
endif()

add_executable(shardcore
  src/main.cpp
  src/app.cpp
  src/config.cpp
  src/sources.cpp
  src/encoders.cpp
  src/x265_encoder.cpp
  src/mux.cpp
  src/replay_ring.cpp
  src/recorder.cpp
  src/game_registry.cpp
  src/launchers.cpp
  src/process_monitor.cpp
  src/detector.cpp
  src/game_session.cpp
  src/game_system.cpp
  src/jsonrpc.cpp
  src/server.cpp
  ${SHARDCORE_PLATFORM_SOURCES}
)

target_include_directories(shardcore PRIVATE src "${x265_SOURCE_DIR}/source" "${x265_BINARY_DIR}")

target_link_libraries(
  shardcore
  PRIVATE OBS::libobs
          x265-static
          ixwebsocket::ixwebsocket
          nlohmann_json::nlohmann_json
)
target_compile_definitions(shardcore PRIVATE CLIPFORGE_VERSION="${PROJECT_VERSION}")

if(WIN32)
  target_compile_definitions(shardcore PRIVATE _CRT_SECURE_NO_WARNINGS WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(shardcore PRIVATE d3d11.lib dxgi.lib dwmapi.lib PowrProf.lib uuid.lib ole32.lib wbemuuid.lib)
endif()

if(WIN32)
  # Animated target for the real Game Capture minimized/freshness smoke test.
  add_executable(shard_gc_d3d11_fixture WIN32 EXCLUDE_FROM_ALL tests/gc_d3d11_fixture.cpp)
  target_compile_definitions(shard_gc_d3d11_fixture PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(shard_gc_d3d11_fixture PRIVATE d3d11.lib dxgi.lib)
  add_executable(shard_gc_d3d12_fixture WIN32 EXCLUDE_FROM_ALL tests/gc_d3d12_fixture.cpp)
  target_compile_definitions(shard_gc_d3d12_fixture PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(shard_gc_d3d12_fixture PRIVATE d3d12.lib dxgi.lib)
endif()

# ---------------------------------------------------------------------------
# Unit tests (detection subsystem — pure logic, no OBS dependency)
# ---------------------------------------------------------------------------
add_executable(shard_tests
  tests/test_main.cpp
  src/game_registry.cpp
  src/launchers.cpp
  src/detector.cpp
  src/game_session.cpp
)

target_include_directories(shard_tests PRIVATE src)

target_link_libraries(shard_tests PRIVATE nlohmann_json::nlohmann_json)

if(WIN32)
  target_compile_definitions(shard_tests PRIVATE _CRT_SECURE_NO_WARNINGS WIN32_LEAN_AND_MEAN NOMINMAX)
endif()

# Pure capture recovery/crop invariants; no OBS or game-detection dependency.
add_executable(shard_capture_resilience_tests tests/capture_resilience_test.cpp)
target_include_directories(shard_capture_resilience_tests PRIVATE src)
