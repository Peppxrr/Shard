#!/usr/bin/env bash
# Shard Linux core build: libobs + the plugins Shard uses + shardcore, staged
# into the Electron runtime directory (Wayland only).
#
#   bash scripts/linux/build.sh                    # Release -> app/resources/core-bin
#   bash scripts/linux/build.sh --config Debug     # Debug   -> app/resources/core-bin-dev
#   bash scripts/linux/build.sh --clean            # wipe build_linux first
#   bash scripts/linux/build.sh --skip-stage       # build only (tests, CI compile check)
#
# Dependencies: scripts/linux/install-deps-fedora.sh (RPM Fusion FFmpeg/x264).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config=Release
clean=0
stage=1
build_dir="$root/build_linux"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --clean) clean=1; shift ;;
    --skip-stage) stage=0; shift ;;
    --build-dir) build_dir="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$config" == Release || "$config" == Debug ]] || { echo "--config must be Release or Debug" >&2; exit 2; }
[[ "$(uname -s)" == Linux ]] || { echo "scripts/linux/build.sh runs on Linux" >&2; exit 2; }

obs_src="$root/vendor/obs-studio"
for sub in plugins/obs-browser plugins/obs-websocket; do
  # OBS's Linux plugin list requires both submodules to exist even though
  # Shard disables the browser source and websocket server.
  [[ -f "$obs_src/$sub/CMakeLists.txt" ]] || { echo "missing OBS submodule $sub (git submodule update --init --recursive)" >&2; exit 1; }
done

# OBS resolves deps/, shared/ and cmake/ against the root CMake project, which
# is core/ when embedded in Shard. Same links as scripts/setup-obs-links.ps1.
for name in deps shared cmake; do
  link="$root/core/$name"
  if [[ -L "$link" ]]; then
    [[ "$(readlink -f "$link")" == "$(readlink -f "$obs_src/$name")" ]] || { echo "unexpected link $link; expected it to point to $obs_src/$name" >&2; exit 1; }
  elif [[ -e "$link" ]]; then
    echo "unexpected directory at $link; expected a link to $obs_src/$name" >&2; exit 1
  else
    ln -s "../vendor/obs-studio/$name" "$link"
  fi
done

if [[ $clean == 1 ]]; then
  case "$build_dir" in "$root"/*) rm -rf -- "$build_dir" ;; *) echo "refusing to clean $build_dir" >&2; exit 1 ;; esac
fi

obs_version="$(node -e 'process.stdout.write(require(process.argv[1]).obs.version)' "$root/runtime-dependencies.json" 2>/dev/null ||
  sed -n 's/.*"version": *"\([0-9.]*\)".*/\1/p' "$root/runtime-dependencies.json" | head -1)"

echo "==> Configuring ($config)"
cmake -S "$root/core" -B "$build_dir" -G Ninja \
  -DCMAKE_BUILD_TYPE="$config" \
  -DENABLE_FRONTEND=OFF -DENABLE_SCRIPTING=OFF -DENABLE_BROWSER=OFF -DENABLE_WEBSOCKET=OFF -DENABLE_VLC=OFF \
  -DOBS_VERSION_OVERRIDE="$obs_version"

# Only modules whose sources/encoders/outputs the core creates are built and
# staged: the core loads every module in obs-plugins/64bit.
plugins=(linux-pipewire linux-pulseaudio obs-ffmpeg obs-x264 obs-nvenc)
tests=(shard_tests shard_capture_resilience_tests shard_audio_isolation_tests shard_perf_tests shard_priority_tests
       shard_save_queue_tests)
# obs-vkcapture: OBS-side source module plus the in-game Vulkan layer and
# OpenGL preload library (installed per user by the core at startup).
vkcapture=(linux-vkcapture VkLayer_obs_vkcapture obs_glcapture)
echo "==> Building"
# obs-nvenc probes NVENC through obs-nvenc-test, looked up next to shardcore.
cmake --build "$build_dir" --parallel --target shardcore libobs-opengl obs-ffmpeg-mux obs-nvenc-test "${plugins[@]}" \
  "${vkcapture[@]}" "${tests[@]}"

[[ $stage == 1 ]] || exit 0

if [[ $config == Debug ]]; then final="$root/app/resources/core-bin-dev"; else final="$root/app/resources/core-bin"; fi
staging="$final.staging"
rm -rf -- "$staging"
mkdir -p "$staging/obs-plugins/64bit" "$staging/data/obs-plugins"

rundir="$build_dir/obs-studio/rundir/$config"
find_one() { # find_one <dir> <name>: newest regular file or symlink named <name>
  find "$1" \( -type f -o -type l \) -name "$2" -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-
}

echo "==> Staging $final"
cp "$build_dir/shardcore" "$staging/shardcore"
# libobs and its OpenGL graphics module keep their sonames (libobs.so.30 plus
# compatibility links); copy every versioned file/link.
for lib in libobs.so libobs-opengl.so; do
  real="$(find_one "$rundir" "$lib*")"
  [[ -n "$real" ]] || { echo "missing $lib under $rundir" >&2; exit 1; }
  cp -P "$(dirname "$real")"/"$lib"* "$staging/"
done
# libobs dlopens its graphics module by the unversioned name
# ("libobs-opengl" -> libobs-opengl.so), which the rundir only has as .so.30.
if [[ ! -e "$staging/libobs-opengl.so" ]]; then
  opengl_real="$(cd "$staging" && ls libobs-opengl.so.* | head -1)"
  ln -s "$opengl_real" "$staging/libobs-opengl.so"
fi
mux="$(find_one "$rundir" obs-ffmpeg-mux)"
[[ -n "$mux" ]] || { echo "missing obs-ffmpeg-mux" >&2; exit 1; }
cp "$mux" "$staging/obs-ffmpeg-mux"
nvenc_test="$(find_one "$rundir" obs-nvenc-test)"
[[ -n "$nvenc_test" ]] || { echo "missing obs-nvenc-test" >&2; exit 1; }
cp "$nvenc_test" "$staging/obs-nvenc-test"

for plugin in "${plugins[@]}"; do
  so="$(find_one "$rundir" "$plugin.so")"
  [[ -n "$so" ]] || { echo "missing plugin $plugin.so" >&2; exit 1; }
  cp "$so" "$staging/obs-plugins/64bit/$plugin.so"
  data="$(find "$rundir" -type d -path "*/obs-plugins/$plugin" ! -path "*/64bit/*" -print -quit)"
  if [[ -n "$data" ]]; then cp -r "$data" "$staging/data/obs-plugins/"; fi
done

vkc_plugin="$(find_one "$build_dir" linux-vkcapture.so)"
vkc_layer="$(find_one "$build_dir" libVkLayer_obs_vkcapture.so)"
vkc_gl="$(find_one "$build_dir" libobs_glcapture.so)"
[[ -n "$vkc_plugin" && -n "$vkc_layer" && -n "$vkc_gl" ]] || { echo "missing obs-vkcapture build outputs" >&2; exit 1; }
cp "$vkc_plugin" "$staging/obs-plugins/64bit/linux-vkcapture.so"
mkdir -p "$staging/data/obs-plugins/linux-vkcapture" "$staging/vkcapture"
cp -r "$build_dir/_deps/obs_vkcapture-src/data/locale" "$staging/data/obs-plugins/linux-vkcapture/"
cp "$vkc_layer" "$vkc_gl" "$staging/vkcapture/"
cp "$build_dir/_deps/obs_vkcapture-src/LICENSE" "$staging/vkcapture/LICENSE" 2>/dev/null || true

libobs_data="$(find "$rundir" -type d -path '*/libobs' -exec test -f '{}/default.effect' \; -print -quit)"
[[ -n "$libobs_data" ]] || { echo "missing libobs data (default.effect)" >&2; exit 1; }
cp -r "$libobs_data" "$staging/data/libobs"
# The core starts libobs with the en-US locale; other translations are never read.
find "$staging/data" -path '*/locale/*.ini' ! -name en-US.ini -delete

# Runtime lookup stays inside core-bin: shardcore/libobs/mux resolve libobs
# beside themselves, plugins two levels up.
if command -v patchelf >/dev/null; then
  for f in "$staging"/libobs.so.* "$staging"/libobs-opengl.so* "$staging/obs-ffmpeg-mux"; do
    [[ -L "$f" ]] || patchelf --set-rpath '$ORIGIN' "$f"
  done
  for f in "$staging"/obs-plugins/64bit/*.so; do patchelf --set-rpath '$ORIGIN/../..' "$f"; done
else
  echo "warning: patchelf not found; the app sets LD_LIBRARY_PATH for the core" >&2
fi
if [[ $config == Release ]]; then
  strip --strip-unneeded "$staging/shardcore" "$staging/obs-ffmpeg-mux" "$staging/obs-nvenc-test" \
    "$staging"/obs-plugins/64bit/*.so 2>/dev/null || true
fi

cp "$root/runtime-dependencies.json" "$staging/runtime-dependencies.json"

# Replace the previous stage only after a complete copy.
previous="$final.previous"
rm -rf -- "$previous"
[[ -e "$final" ]] && mv -- "$final" "$previous"
mv -- "$staging" "$final"
rm -rf -- "$previous"
echo "==> Staged $final"
