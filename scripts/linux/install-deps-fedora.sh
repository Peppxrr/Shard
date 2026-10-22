#!/usr/bin/env bash
# Build dependencies for Shard's Linux core (libobs + plugins + shardcore) on
# Fedora with RPM Fusion enabled (full FFmpeg and x264). Run once:
#   sudo bash scripts/linux/install-deps-fedora.sh
set -euo pipefail

if ! rpm -q rpmfusion-free-release >/dev/null 2>&1; then
  echo "RPM Fusion (free) is required for ffmpeg-devel and x264-devel:" >&2
  echo "  https://rpmfusion.org/Configuration" >&2
  exit 1
fi

# qt6-qtbase-devel is only needed because OBS configures frontend-tools on
# Linux even with the frontend disabled; Shard never builds or ships it.
dnf install -y --allowerasing \
  cmake ninja-build gcc gcc-c++ git nasm patchelf pkgconf-pkg-config \
  ffmpeg-devel x264-devel \
  jansson-devel libcurl-devel mbedtls-devel zlib-ng-compat-devel simde-devel uthash-devel \
  libuuid-devel glib2-devel pciutils-devel speexdsp-devel \
  libX11-devel libxcb-devel libXcomposite-devel libXdamage-devel libXinerama-devel libXrandr-devel libXfixes-devel \
  libxkbcommon-devel wayland-devel mesa-libEGL-devel mesa-libGL-devel libglvnd-devel libdrm-devel \
  vulkan-headers vulkan-loader-devel \
  pipewire-devel pulseaudio-libs-devel libva-devel nv-codec-headers systemd-devel \
  qt6-qtbase-devel
