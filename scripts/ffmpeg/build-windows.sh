#!/usr/bin/env bash
# Builds Shard's editor/export FFmpeg inside MSYS2 UCRT64 (started by
# build-windows.ps1) and packages it in the layout scripts/fetch-ffmpeg.ps1
# expects: <dir>/bin/{ffmpeg,ffprobe}.exe + FFmpeg DLLs, LICENSE, README.txt.
#
# Only what the editor uses is linked: x264, x265, SVT-AV1, NVENC, AMF and
# Quick Sync (libvpl) encoders; dav1d and D3D11VA/DXVA2 decoding. Native
# FFmpeg codecs/formats/filters stay enabled so no editor path loses a
# component. External libraries and the GCC runtime are linked statically, so
# the DLLs depend only on Windows system DLLs. GPL v2 or later.
#
# Usage (UCRT64 shell): build-windows.sh <work-dir> <version> <source-url> <source-sha256> <revision>
# The values come from scripts/ffmpeg/build-pins.json via build-windows.ps1.
set -euo pipefail
work=$(cd "$1" && pwd)
ver=$2 url=$3 sha=$4 rev=$5
name="shard-ffmpeg-$ver-$rev-win64"
cd "$work"

tarball="ffmpeg-$ver.tar.xz"
[[ -f $tarball ]] || { echo "missing $tarball (build-windows.ps1 downloads it)" >&2; exit 1; }
echo "$sha *$tarball" | sha256sum -c --quiet || { echo "FFmpeg source SHA-256 mismatch" >&2; exit 1; }
rm -rf "ffmpeg-$ver" build out shim "$name" "$name.zip"
tar -xJf "$tarball"
mkdir build shim
# x265.pc asks for -lgcc_s (the shared libgcc import library); an empty stub
# keeps libgcc static without editing the package.
ar rcs shim/libgcc_s.a

cd build
# gfxcapture (FFmpeg 9 WinRT screen capture) is C++/WinRT that needs the
# shared GCC unwinder; Shard never captures through FFmpeg.
../ffmpeg-$ver/configure --prefix="$work/out" --arch=x86_64 --target-os=mingw32 \
  --enable-shared --disable-static --enable-gpl \
  --disable-autodetect --enable-w32threads --enable-zlib \
  --enable-d3d11va --enable-dxva2 \
  --enable-ffnvcodec --enable-nvenc --enable-amf --enable-libvpl \
  --enable-libx264 --enable-libx265 --enable-libdav1d --enable-libsvtav1 \
  --disable-filter=gfxcapture --disable-ffplay --disable-doc --disable-network --disable-debug \
  --pkg-config-flags=--static \
  --extra-ldflags="-L$work/shim -static -static-libgcc -static-libstdc++" --extra-libs=-lstdc++ \
  > "$work/configure.log" 2>&1 || { tail -30 ffbuild/config.log >&2; exit 1; }
make -j"$(nproc)" > "$work/make.log" 2>&1 || { grep -E "error|undefined" "$work/make.log" | tail -20 >&2; exit 1; }
make install > "$work/install.log" 2>&1
cd "$work"

mkdir -p "$name/bin"
cp out/bin/ffmpeg.exe out/bin/ffprobe.exe out/bin/*.dll "$name/bin/"
# Anything outside Windows itself would be a missing runtime on user machines.
for f in "$name"/bin/*; do
  objdump -p "$f" | awk '/DLL Name/ {print $3}'
done | sort -u | grep -viE '^(api-ms-win-crt-.*|kernel32|user32|gdi32|advapi32|shell32|shlwapi|ole32|oleaut32|bcrypt|avicap32|av(codec|device|filter|format|util)-[0-9]+|sw(resample|scale)-[0-9]+)\.dll$' \
  && { echo "unexpected runtime DLL dependency (listed above)" >&2; exit 1; } || true
cp "ffmpeg-$ver/COPYING.GPLv2" "$name/LICENSE"
{
  echo "Shard editor/export FFmpeg $ver (build revision $rev), win64, GNU GPL v2 or later."
  echo
  echo "Built by scripts/ffmpeg/build-windows.ps1 from the Shard repository."
  echo "FFmpeg source: $url (SHA-256 $sha)"
  echo
  echo "Configuration:"
  out/bin/ffmpeg.exe -hide_banner -buildconf 2>/dev/null | sed -n 's/^ *--/  --/p' | sed "s#$work#<build>#g"
  echo
  echo "Statically linked libraries and toolchain (MSYS2 UCRT64 packages; the"
  echo "corresponding sources are published at https://repo.msys2.org/mingw/sources/):"
  pacman -Q mingw-w64-ucrt-x86_64-{x264,x265,dav1d,svt-av1,libvpl,ffnvcodec-headers,amf-headers,zlib,gcc,binutils} | sed 's/^/  /'
  echo
  echo "Upstream projects: https://ffmpeg.org  https://code.videolan.org/videolan/x264"
  echo "  https://bitbucket.org/multicoreware/x265_git  https://code.videolan.org/videolan/dav1d"
  echo "  https://gitlab.com/AOMediaCodec/SVT-AV1  https://github.com/intel/libvpl"
} > "$name/README.txt"
echo "PACKAGE $(cygpath -w "$work/$name")"
