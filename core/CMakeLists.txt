cmake_minimum_required(VERSION 3.28...3.30)

# Application and core share one stable SemVer. CMake's configure dependency
# ensures `npm version` also rebuilds the core and its Windows resources.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/../app/package.json")
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../app/package.json" SHARD_PACKAGE_JSON)
string(JSON SHARD_APP_VERSION GET "${SHARD_PACKAGE_JSON}" version)
if(NOT SHARD_APP_VERSION MATCHES "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")
  message(FATAL_ERROR "Shard version must be stable major.minor.patch SemVer")
endif()
project(shard-core VERSION ${SHARD_APP_VERSION} LANGUAGES C CXX)

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
# libobs-d3d11 only contains its GPU scheduling priority code (set_priority:
# D3DKMTSetProcessSchedulingPriorityClass + IDXGIDevice::SetGPUThreadPriority)
# when built with a priority value, as OBS's release builds are. 7 is the
# documented maximum. libobs applies it when the device is created and it only
# succeeds in an elevated process (Recording priority); non-elevated cores log
# "D3D11 GPU priority setup failed (not admin?)" and run unchanged.
set(GPU_PRIORITY_VAL "7" CACHE STRING "libobs-d3d11 GPU thread priority (-7..7, 0 disables)" FORCE)

# The target-side Game Capture payload is the official signed OBS release,
# staged separately from the embedded host plugin. win-capture verifies this
# directory and embeds its manifest values for runtime checks.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/../runtime-dependencies.json")
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../runtime-dependencies.json" SHARD_RUNTIME_PINS)
string(JSON SHARD_HOOK_PAYLOAD GET "${SHARD_RUNTIME_PINS}" obs hookPayload)
string(JSON SHARD_OBS_VERSION GET "${SHARD_RUNTIME_PINS}" obs version)
set(OBS_VERSION_OVERRIDE "${SHARD_OBS_VERSION}" CACHE STRING "Pinned OBS release" FORCE)
set(SHARD_OBS_HOOK_PAYLOAD_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../${SHARD_HOOK_PAYLOAD}"
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
  src/log.cpp
  src/system_info.cpp
  src/gpu_engines.cpp
  src/perf_monitor.cpp
  src/priority_task.cpp
  src/priority_runtime.cpp
  src/app.cpp
  src/config.cpp
  src/audio_isolation.cpp
  src/audio_isolation_capture.cpp
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
target_compile_definitions(shardcore PRIVATE SHARD_VERSION="${PROJECT_VERSION}")

if(WIN32)
  target_compile_definitions(shardcore PRIVATE _CRT_SECURE_NO_WARNINGS WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(shardcore PRIVATE d3d11.lib dxgi.lib dwmapi.lib PowrProf.lib uuid.lib ole32.lib wbemuuid.lib mmdevapi.lib
    pdh.lib gdi32.lib taskschd.lib shell32.lib oleaut32.lib)
  # No console window. Electron, scripts and the supervisor give the core
  # pipes/files for stdio, which a GUI-subsystem process inherits normally;
  # the elevated helpers (UAC prompt, scheduled task) get no stdio and would
  # otherwise open an empty console window.
  set_target_properties(shardcore PROPERTIES WIN32_EXECUTABLE ON)
  target_link_options(shardcore PRIVATE /ENTRY:mainCRTStartup)
endif()

if(WIN32)
  # Opt-in process-tree teardown fixture (no OBS or GPU dependency).
  add_executable(shard_process_supervisor_fixture EXCLUDE_FROM_ALL tests/process_supervisor_fixture.cpp)
  # Animated target for the real Game Capture minimized/freshness smoke test.
  add_executable(shard_gc_d3d11_fixture WIN32 EXCLUDE_FROM_ALL tests/gc_d3d11_fixture.cpp)
  target_compile_definitions(shard_gc_d3d11_fixture PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(shard_gc_d3d11_fixture PRIVATE d3d11.lib dxgi.lib)
  # Opt-in GPU starvation fixture: pins the 3D engine on a schedule to check
  # recording lag attribution and recovery (docs/VERIFYING.md).
  add_executable(shard_gpu_stress_fixture WIN32 EXCLUDE_FROM_ALL tests/gpu_stress_fixture.cpp)
  target_compile_definitions(shard_gpu_stress_fixture PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(shard_gpu_stress_fixture PRIVATE d3d11.lib dxgi.lib d3dcompiler.lib)
  add_executable(shard_gc_d3d12_fixture WIN32 EXCLUDE_FROM_ALL tests/gc_d3d12_fixture.cpp)
  target_compile_definitions(shard_gc_d3d12_fixture PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(shard_gc_d3d12_fixture PRIVATE d3d12.lib dxgi.lib)
  # Opt-in GPU test of black-frame detection, actual scene fallback and retry.
  add_executable(shard_capture_backend_fixture EXCLUDE_FROM_ALL
    tests/capture_backend_fixture.cpp src/sources.cpp src/log.cpp src/audio_isolation.cpp src/audio_isolation_capture.cpp)
  target_include_directories(shard_capture_backend_fixture PRIVATE src)
  target_compile_definitions(shard_capture_backend_fixture PRIVATE _CRT_SECURE_NO_WARNINGS WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(shard_capture_backend_fixture PRIVATE OBS::libobs nlohmann_json::nlohmann_json
    d3d11.lib dxgi.lib dwmapi.lib PowrProf.lib uuid.lib ole32.lib mmdevapi.lib)
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

# Audio isolation routing/config invariants; no OBS, WASAPI or hardware.
add_executable(shard_audio_isolation_tests tests/audio_isolation_test.cpp src/audio_isolation.cpp src/config.cpp)
target_include_directories(shard_audio_isolation_tests PRIVATE src)
target_link_libraries(shard_audio_isolation_tests PRIVATE nlohmann_json::nlohmann_json)
if(WIN32)
  target_compile_definitions(shard_audio_isolation_tests PRIVATE _CRT_SECURE_NO_WARNINGS WIN32_LEAN_AND_MEAN NOMINMAX)
endif()

# Frame-loss attribution, clip lag segments and GPU engine counter parsing;
# no OBS or PDH collection.
add_executable(shard_perf_tests tests/perf_analysis_test.cpp src/gpu_engines.cpp)
target_include_directories(shard_perf_tests PRIVATE src)
if(WIN32)
  target_compile_definitions(shard_perf_tests PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(shard_perf_tests PRIVATE pdh.lib)
endif()

# Recording priority identity decisions, plus the protected runtime copy,
# manifest and swap recovery against temporary directories; no COM or UAC.
add_executable(shard_priority_tests tests/priority_policy_test.cpp src/priority_runtime.cpp)
target_include_directories(shard_priority_tests PRIVATE src)
target_link_libraries(shard_priority_tests PRIVATE nlohmann_json::nlohmann_json)

# Replay-save acceptance/worker lifecycle (clip.queued -> exactly one terminal
# event, also across concurrent stop/restart); no OBS.
add_executable(shard_save_queue_tests tests/save_queue_test.cpp)
target_include_directories(shard_save_queue_tests PRIVATE src)
