#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO/C4Client"
export WINEPREFIX="$ROOT/prefix"
export WINEARCH=win64
export WINEDLLOVERRIDES='mscoree,mshtml='
export WINEDEBUG='-all,err+all'
export DISPLAY="${DISPLAY:-:101}"
export XAUTHORITY="${XAUTHORITY:-$ROOT/runtime/Xauthority}"
export LIBGL_ALWAYS_SOFTWARE=1
export __GLX_VENDOR_LIBRARY_NAME=mesa
export LP_NUM_THREADS=2
# Restrict driver discovery to Mesa software backends without isolating the
# filesystem/network. Probing host GPU vendors can stall this legacy client.
export GALLIUM_DRIVER=llvmpipe
export VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.json
export __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json
cd -- "$ROOT/game/system"
# This is ordinary Wine with direct host networking, not a security boundary.
# Never start the server or an X display implicitly from a client launcher.
exec "$ROOT/tools/wine-11.0-amd64-wow64/bin/wine" "$@"
