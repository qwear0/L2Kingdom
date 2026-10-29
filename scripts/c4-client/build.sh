#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SDK="${C4_MINGW_ROOT:-$REPO/C4Client/tools/mingw-p0/usr}"
OUT="$REPO/C4Client/runtime/c4-agent-p0"
CC="${C4_CLANG:-clang++-21}"
LD="${C4_LLD:-/usr/bin/ld.lld-21}"
if [[ ! -d "$SDK/i686-w64-mingw32/include" || ! -f "$SDK/i686-w64-mingw32/lib/libkernel32.a" ]]; then
    printf 'Missing local MinGW SDK; see scripts/c4-client/README.md.\n' >&2
    exit 1
fi
mkdir -p -- "$OUT"
COMMON=(--target=i686-w64-windows-gnu -std=c++17 -O2 -Wall -Wextra -Werror
    -fno-exceptions -fno-rtti -fno-stack-protector -nostdlib
    -D__USE_MINGW_ANSI_STDIO=0
    -isystem "$SDK/i686-w64-mingw32/include" --ld-path="$LD"
    -L "$SDK/i686-w64-mingw32/lib")
"$CC" "${COMMON[@]}" "$REPO/scripts/c4-client/native/agent.cpp" \
    -shared -Wl,--entry,_DllMain@12,--kill-at -o "$OUT/C4Agent.dll" \
    -lws2_32 -lkernel32 -ladvapi32 -lmsvcrt
"$CC" "${COMMON[@]}" "$REPO/scripts/c4-client/native/launcher.cpp" \
    -Wl,--entry,_mainCRTStartup -o "$OUT/C4AgentLauncher.exe" \
    -lkernel32 -ladvapi32 -lmsvcrt
printf 'Built x86 P0 DLL and launcher in %s\n' "$OUT"
