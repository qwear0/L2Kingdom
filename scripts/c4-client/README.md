# Native C4 client feasibility gate (P0)

This is an exact-build P0 feasibility bridge, **not** the P1 client MCP server. It does not replace `scripts/bot-mcp.js`, emulate packets, automate login, move a character, or expose arbitrary memory/engine calls. See the [project map](../../docs/README.md).

## Owners and limits

- `native/profile.h`: SHA-256 identities of the installed L2Solo C4 client, advertised as protocol 656. This is a single profile, not general support for other C4 releases.
- `native/launcher.cpp`: validates client files, creates its own suspended `L2.exe -windowed`, loads `C4Agent.dll` into **only that child**, starts the agent explicitly outside `DllMain`, then resumes/waits for the child. Setup failure terminates only that child. There is no attach-by-PID, unloading, hot replacement, or restart of any server.
- `native/agent.cpp`: validates the loaded L2/Engine/Core file identities and the on-disk NWindow identity (NWindow loads later); replaces the exact exported UObject-side `UGameEngine` vtable slot `+0x64` only if it still points to the expected exported tick. It calls the original `thiscall Tick(float)` first. No inline instruction patching is used.
- The tick takes a bounded sample at most every 200 ms, with a non-waiting lock. Client viewport offsets `+0x58`, `+0x38`/`+0x3c`, `+0x3c` were inspected in this exact Engine's tick. `UObject::IsA` and `AActor::GetLevel` are called **on the game thread**, never by the RPC thread. A controller's pawn at `+0x3a8` is checked against APawn and the current level. Pawn origin `+0x1bc` and cylinder radius/height `+0x2f0/+0x2f4` come from this build's `execFastTrace` and `GetCylinderExtent`. Pointer strings are opaque diagnostic identities, not handles for later dereference.
- RPC binds an ephemeral port on `127.0.0.1` inside the DLL. It accepts only `health`, `sample` and `surface`, behind a random per-launch token. One bounded request per connection; newline framing; request limit 127 bytes, receive/send timeouts. This temporary P0 wire contract is not a committed P1 action protocol.
- `surface` queues one downward ray from the current pawn origin to origin Z minus native cylinder height minus 256, with zero extent and no caller-supplied coordinates. The game tick checks the queued pawn/epoch before executing `ULevel::SingleLineCheck`. The 48-byte FCheckResult layout, endpoint order, return convention (0 hit / 1 clear), and `0x86` mask were inspected in this exact build's `execTrace(false)` and `SingleLineCheck`. This is an experimental loaded-geometry ray, not a swept cylinder or proof of complete map loading. One stationary in-world native hit has been verified, including its return/time/normal and continued tick updates afterwards. Feet/contact conventions and movement/clearance remain uncalibrated.
- Request submission is not a result: inspect `surface.requestId`, `epoch` and `status` in the subsequent sample. Status is `queued`, `hit`, `clear`, `stale_epoch` or `invalid_native_result`; `unavailable` means no request has run. Only `hit` exposes copied hit fields; object IDs are never dereferenced later. One queued request at a time; no automatic retry.
- A login-scene viewport actor/level is **not** an authenticated player/pawn or proof of a standing surface. `pawn: null` means no checked pawn geometry is available. Zero sequence means no native tick has been observed; `ageMs: null` then avoids reporting a fresh sample. Otherwise use sequence, age, thread and epoch together; software rendering can make sampling slower than 5 Hz.

The DLL and its hook remain resident until its child exits. An unexpected launcher kill can leave that child running: inspect the owned process before any cleanup/relaunch. A descriptor is not evidence that a session is still alive. The launcher removes its descriptor after observing child exit; never reuse the same descriptor path across concurrent launches.

## Local toolchain and build

No system-wide installation is required. On this Debian host the selected toolchain is Clang/LLD 21.1.8 with MinGW-w64 12.0.0 x86 headers/import libraries. SDK files, compiled binaries and the client remain Git-ignored under `C4Client/`.

To provision the SDK explicitly (does not start Wine or any server):

```bash
mkdir -p /tmp/L2Kingdom/c4-p0-toolchain C4Client/tools/mingw-p0
(cd /tmp/L2Kingdom/c4-p0-toolchain &&
  apt-get download mingw-w64-common mingw-w64-i686-dev &&
  for package in ./*.deb; do
    dpkg-deb -x "$package" /apps/L2Kingdom/C4Client/tools/mingw-p0
  done)
bash scripts/c4-client/build.sh
```

Build inputs can be overridden with `C4_MINGW_ROOT` (the extracted `usr` directory), `C4_CLANG` and `C4_LLD`. Output: `C4Client/runtime/c4-agent-p0/{C4Agent.dll,C4AgentLauncher.exe}`. No compiled artifact is installed into `game/system` and the original client binaries are not modified. There is no bundled automated test runner.

## Explicit launch

`wine.sh` uses **ordinary Wine with direct host filesystem/network access**, the dedicated `C4Client/prefix`, software rendering and a caller-owned display. It is not a sandbox and creates neither a display nor a server. Defaults: display `:101` and `C4Client/runtime/Xauthority`. Do not start over an occupied display; the ignored `C4Client/README.md` records the local display setup and manual shutdown.

On this host Wine 11's default EGL path failed to create a pixel format even without the DLL. GLX reached the login scene after explicitly setting the following in the dedicated prefix (see [Wine 11 release notes](https://github.com/wine-mirror/wine/blob/wine-11.0/ANNOUNCE.md)):

```bash
bash scripts/c4-client/wine.sh reg.exe add 'HKCU\Software\Wine\X11 Driver' \
  /v UseEGL /t REG_SZ /d N /f
```

After explicitly starting your display, build first and launch from the repository root. The descriptor contains a bearer token: keep it private and never print, commit or copy it into evidence.

```bash
umask 077
SESSION_DIR="$(mktemp -d "$PWD/C4Client/runtime/p0-session-XXXXXX")"
touch "$SESSION_DIR/connection.json"
export C4_AGENT_SESSION="Z:${SESSION_DIR//\//\\}\\connection.json"
bash scripts/c4-client/wine.sh "$PWD/C4Client/runtime/c4-agent-p0/C4AgentLauncher.exe"
```

Keep the launcher alive until the client exits. The legacy AGP warning can appear behind the splash and require a manual OK; first map loading can take minutes. Use the client's Exit button when available. Inspect exact process identities before terminating a stuck owned client or its display; never use global `wineserver -k` or kill another display.

The descriptor holds protocol, profile, Windows PID (not the Linux PID), host, port and token. An RPC consumer reads it locally, connects directly to that loopback port, sends `<token> sample\n`, `<token> health\n` or `<token> surface\n`, reads one JSON line and closes. A surface request without a pawn is rejected; a queued request must be observed through a later sample. Do not include credentials in this RPC: no login method exists yet.

## Verification boundary

P0 feasibility passed for this exact profile: DLL handshake, direct loopback RPC, direct auth/game connections, selection/world entry of the designated existing character, checked native pawn geometry, and one bounded downward native surface hit. The returned fraction matched the hit distance along the ray, the normal was unit length, and subsequent samples advanced on the same native thread with stable pawn/epoch. The client stayed responsive and exited normally. No packet bot, observer projection or server geodata supplied the collision result.

Earlier bounded checks rejected missing/altered client identity and an incorrect RPC token. Normal client exit removed the descriptor and closed the listener; only the owned display/window manager were stopped. Management/game were not restarted. The designated character's GM flag was assigned through a separately approved one-character offline SQLite update. Credentials were supplied locally without logging their values; the existing encrypted client configuration already specified loopback auth and was not patched. The user accepted the client agreement manually.

This is one local feasibility result, not complete collision/mask coverage, a calibrated feet/contact offset, successful native walking/clearance, spawn-coverage acceptance, or P1 client MCP/login automation. No new automated tests or test infrastructure were added. Per-session evidence and resumable phase records belong under ignored `tmp/`, not in maintained docs. P1 must settle the typed action/session contract and native login/server/character selection before routine agent use.
