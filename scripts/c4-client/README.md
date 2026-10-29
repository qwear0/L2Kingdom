# Exact-build native C4 client bridge

The P0 feasibility gate passed. The current **partial P1** adds session observations, native login, explicit server/existing-character selection, world-entry confirmation, bounded native movement/stop and a separate MCP adapter. Consent automation and the remaining P1 telemetry are not implemented. This is not a packet bot and does not replace `scripts/bot-mcp.js`. See the [project map](../../docs/README.md).

## Owners and boundaries

- `native/profile.h`: SHA-256 identities of the installed L2Solo C4 client, advertised as protocol 656; module-relative singleton and notify-subobject offsets. One exact profile, not general C4 support.
- `native/launcher.cpp`: validates client files, creates its own suspended `L2.exe -windowed`, loads `C4Agent.dll` into **only that child**, explicitly starts it outside `DllMain`, then resumes/waits. Setup failure terminates only that child. No attach-by-PID, unloading, hot replacement or server operations.
- `native/agent.cpp`: validates identities, replaces the exact exported UObject-side `UGameEngine` tick slot `+0x64` only if it matches the exported tick, and calls the original `thiscall Tick(float)` first. Samples at most every 200 ms using a non-waiting lock. No inline instruction patches.
- `native/session.h`: validates and hooks twelve exported auth/server-list/character/self callbacks through this exact Engine's notify vtable. Callbacks preserve their native arguments/return values and copy only observations on the game thread. A checked singleton must have the expected `UNetworkHandler` vtable and notify pointer to the current engine's `+0x38` subobject. The serial RPC worker hashes the actual loaded NWindow path once before allowing its exact console Start(index) wrapper; the game thread checks console identity and handler linkage. No global object scans.
- `native/movement.h`: included inside the session owner/receipt boundary. Resolves exact exported movement/stop functions and checks the native controller/pawn/viewport links on the game thread. Hooks only the validated outgoing native move vtable slot for manual takeover; agent dispatch calls the original export directly. It never writes actor coordinates or fabricates position validation.
- `src/Mcp/Client/`: independent stdio MCP → direct loopback RPC adapter, using the installed SDK. `scripts/c4-client-mcp.js` attaches to an explicitly provided private descriptor; it never launches a client/display/server, reads SQLite or calls WorldObserver. The existing bot MCP remains separate.

The DLL remains resident until its child exits. A killed launcher can leave that child running: inspect exact owned process identities before cleanup/relaunch. A descriptor is not proof that a client remains alive. Never reuse its path for concurrent launches. Ordinary Wine has the host user's normal filesystem/network access: **not a sandbox**.

## Build and explicit launch

No system-wide installation is required. The local toolchain is Clang/LLD 21.1.8 with MinGW-w64 12.0.0 x86 headers/import libraries. Client, SDK and generated binaries remain ignored under `C4Client/`. To provision the SDK explicitly, without starting Wine or a server:

```bash
mkdir -p /tmp/L2Kingdom/c4-p0-toolchain C4Client/tools/mingw-p0
(cd /tmp/L2Kingdom/c4-p0-toolchain &&
  apt-get download mingw-w64-common mingw-w64-i686-dev &&
  for package in ./*.deb; do
    dpkg-deb -x "$package" /apps/L2Kingdom/C4Client/tools/mingw-p0
  done)
bash scripts/c4-client/build.sh
```

Overrides: `C4_MINGW_ROOT` (the extracted `usr` directory), `C4_CLANG`, `C4_LLD`. Current output: `C4Client/runtime/c4-agent-p1/{C4Agent.dll,C4AgentLauncher.exe}`; old P0 binaries are not overwritten. No output is installed into `game/system`; original client binaries are not modified.

`wine.sh` uses direct host networking, the dedicated `C4Client/prefix`, software rendering and a caller-owned display. It creates no display/server. Defaults: `:101`, `C4Client/runtime/Xauthority`. Do not start over an occupied display. The ignored `C4Client/README.md` records local display setup and manual shutdown.

On this host Wine 11's default EGL path failed to create a pixel format even without the DLL. GLX reached the login scene after this explicit dedicated-prefix setting ([Wine release notes](https://github.com/wine-mirror/wine/blob/wine-11.0/ANNOUNCE.md)):

```bash
bash scripts/c4-client/wine.sh reg.exe add 'HKCU\Software\Wine\X11 Driver' \
  /v UseEGL /t REG_SZ /d N /f
```

After explicitly starting the owned display, build and launch from the repository root:

```bash
umask 077
SESSION_DIR="$(mktemp -d "$PWD/C4Client/runtime/p1-session-XXXXXX")"
touch "$SESSION_DIR/connection.json"
export C4_AGENT_SESSION="Z:${SESSION_DIR//\//\\}\\connection.json"
bash scripts/c4-client/wine.sh "$PWD/C4Client/runtime/c4-agent-p1/C4AgentLauncher.exe"
```

Keep the launcher alive until the child exits. The AGP warning may require manual OK; first scene loading can take minutes. Use the client's Exit button when available. Stop only this owned client/display after verifying identities; never use global `wineserver -k`. Leave management/game/frontend unchanged.

## Partial P1 MCP and credential contract

Start an adapter separately, with the **absolute Linux path** of the descriptor, not its contents:

```bash
C4_CLIENT_SESSION="$SESSION_DIR/connection.json" node scripts/c4-client-mcp.js
```

This process speaks MCP stdio, not an interactive shell. Only MCP messages go to stdout. Descriptor/credential files must be regular, single-link, current-user-owned, owner-private files in an owner-private immediate directory; final-component symlinks are rejected. The descriptor pins protocol `c4-agent/3`, profile `l2solo-c4-656-0293b3ed-p1`, Windows PID, `127.0.0.1`, ephemeral port and per-launch bearer token. Never print/copy its token into tool arguments, logs or evidence. A new client requires a new descriptor and adapter.

Tools:

| Tool | Current contract |
| --- | --- |
| `client_status` | Exact profile/PID, sequence/epoch/age/thread, native session observations, pawn availability, supported/unavailable capabilities and adapter ownership. No claim that auth acceptance means world entry. |
| `client_observe` | One bounded post-native-tick sample, including raw pawn/ray data below, separately labelled network session observations and receipt time. Cross-process clocks are not presumed synchronized. |
| `client_action` | UUID `requestId` and observed `expectedEpoch`; `login` uses an absolute local `credentialFile`; `select_server` uses an observed `serverId` plus `expectedRevision`; `select_character` uses `credentialFile` plus `expectedRevision`. `move` takes a bounded native floor `destination: {x,y,z}` and explicit `timeoutMs`; `stop` supersedes foreground movement. No password/name argument, account/character creation, agreement acceptance or security-pad bypass. |
| `client_action_status` | Original UUID → retained DLL receipt with action kind; `queued`/`dispatched` is not authenticated, entered-world or movement completion. Movement outcomes and native stop confirmation are separate fields. |

The credential JSON has exactly `login`, `password`, `character` string fields. Login/password currently support printable non-space ASCII, at most 14/16 characters, matching inspected native copy bounds. `select_character` matches the designated `character` exactly against the received native list, rejecting missing/ambiguous names. It cannot select an arbitrary caller-supplied index or create a character. Supply credentials locally; never put their values in MCP arguments. Node reads at most 4096 bytes, sends credentials only over the authenticated loopback socket and does not log them. Mutable byte buffers and the DLL mailbox/request buffers are cleared; JavaScript strings cannot be reliably zeroed, and the real client's own credential storage remains outside this guarantee.

Native `RequestAuthLogin(wchar_t*, wchar_t*)` executes only on the checked game tick after revalidating epoch, handler, no pawn, no observed transport and native login readiness. At most one native login dispatch is allowed per client lifetime in this slice. An auth callback is an independent decoded client observation, not a fabricated causal action result. `auth_accepted_consent_unverified` explicitly does **not** accept legal terms. New/changed terms need the user's decision; no accept-all or unverified repeated-prompt suppression exists. A repeated unchanged prompt need not become a new manual approval gate when the user's prior acceptance has been reconfirmed for that exact resource. The native `session.consent` marker describes the bridge's lack of consent tracking/automation; it does not invalidate an external user confirmation.

### Selection and world-entry observations

- `session.serverIds` and `session.characters` contain only the last received bounded native lists (at most 32 servers / 7 characters), not database queries. List validity, readiness and `revision` accompany them; stale revisions are rejected at submission and again on the game thread. Server addresses/ports come only from the native list, never caller input.
- `select_server` invokes `RequestServerLogin(L2ParamStack&)` with the observed ID/address/port values without consuming or retaining the callback's original stack. The alternate unverified server-list callback disables selection rather than fabricating endpoint data.
- `select_character` invokes the exact NWindow console Start(index) wrapper, which supplies the native game-start arguments and performs the matching selection/HUD transition. A security pad is unsupported: if enabled, selection is unavailable rather than supplying guessed answers.
- `session.worldEntered` requires native game-start acceptance (`gameStartAccepted == 1`), self `UserInfo` matching the selected name, a checked pawn and a live game transport. `world_ready` is independent observed evidence, not the native dispatch return. Loss of those prerequisites after confirmation changes state to `session_lost`; there is no automatic recovery/relogin.
- Names use bounded UTF-16LE hex on the native wire, decoded by Node to `characters` / `selectedCharacter`; values cannot inject JSON. Consent remains externally scoped as above. Observations do not claim calibrated geometry or complete map loading.

### Bounded movement and stop

- `move` requires an observed `expectedEpoch`, confirmed world entry and native walking physics (`physicsRaw == 1`); no selection revision or credential file. The destination is floor XYZ, not a pawn-origin coordinate: no automatic contact/feet conversion is applied. Submission and dispatch both enforce a 512-unit XY radius and ±256 Z relative to the current raw origin. The explicit real-time deadline is 1000–15000 ms; there is one foreground movement, not a route queue.
- The checked native `UNetworkHandler::MoveToLocation(Actor*, Vector, Vector, Actor*, int)` uses the actual pawn/source and caller destination, with the original mouse-move mode. This request alone is dispatch, not local movement. This exact client's original server-echo handler calls `AController::AddMoveTo`, leading to normal client movement/physics. Live observations of changed origin, nonzero native velocity and walking physics establish progress; no second packet client, transform write or fabricated `ValidatePosition` is used.
- `stop` calls the checked `ALineagePlayerController::StopMove` path, including its native network publication. It may supersede a foreground move; that original receipt becomes `interrupted`, while the new stop receipt owns confirmation. Both functions return void, represented by `nativeReturn: null`, never a fabricated success value.
- `client_observe.pawn` includes native `velocity`, `headingRaw` (Unreal yaw), `physicsRaw`, raw origin and cylinder dimensions. These are client-native observations, not server coordinates. `movement` exposes the last command's action/epoch/request ID, active flag, raw start/last origin, requested `targetFloor` (`null` for stop), observed sequence, progress and outcome. Samples remain bounded at at most 5 Hz; software rendering may be slower. No client/server clock alignment or correction attribution is claimed.
- After dispatch, `pending`/`moving` reflect native observations. `reached_xy_stopped` means XY distance ≤16 and consecutive stationary samples spanning at least 600 ms (velocity and sample displacement squared ≤1). It does **not** establish vertical arrival, floor identity, walkability, clearance or contact calibration. `stopped` applies to the explicit stop command. Stationary movement away from its target after 3 seconds becomes `stalled`; its cause remains unknown, not automatically collision. Deadline expiry is `timed_out`. Both request native stop; timeout does not mean success.
- `movement.stop` / receipt `stop` distinguish `not_requested`, `pending`, `dispatched`, `observed_stopped`, `unconfirmed`. A stop call is not stationary proof. Failure to observe stationarity within 5 seconds of the call becomes `unconfirmed` (the explicit stop outcome becomes `unknown`); an unresponsive game thread may leave a pending stop and stale sample instead. Epoch/world replacement revokes control with `world_lost` and never dereferences/stops the old pawn in the new world.
- Native manual movement through the checked outgoing intent slot revokes the owner and queued work before forwarding that intent. It attempts to stop the old foreground movement first and records `manual_override`; subsequent motion belongs to the native caller, so that stop is not given fabricated stationary confirmation. Passive position/server publications do not revoke ownership. Unrelated UI keys are not a universal cancellation capability. If the sample lock is contended, control is revoked on the next checked tick without stopping over the newer manual movement; the old stop remains `unconfirmed`.
- Contact/feet, clearance, fall/correction classification, native events/wait/capture and broader gameplay actions remain unavailable. An admin account or `physicsRaw == 1` is not proof that every possible GM/server movement bypass is disabled; no collision/route acceptance is claimed by this slice. Do not enable server auto-fight during client movement checks.

### Ownership, receipts and direct wire

- One random adapter owner; a 15-second native lease, renewed every 3 seconds while attached. Another owner is rejected. Explicit close revokes queued work and requests native stop for foreground movement; connection loss/expiry does so when next observed by the worker/tick. Read the movement stop state and sample age rather than treating release as stationary confirmation. A new owner cannot claim over an unresolved stop. Already-dispatched session actions are not undone.
- One fixed action mailbox; queued actions expire after 10 seconds. Submission rejects a stale epoch, stale selection revision or sample older than 5 seconds. The game tick checks epoch/revision/readiness again before dispatch. Receipt status distinguishes dispatch, stale epoch/revision, owner loss, expiry and native unavailability/rejection.
- Up to 32 accepted request receipts per client lifetime; no eviction/replay ambiguity from silent rollover. Reusing a key requires the exact owner/payload SHA-256 match; mismatches are rejected. Digests are not exported. An unknown receipt or transport loss never permits automatic retry under a fresh key. A new adapter may read an old receipt without reclaiming/replaying its action.
- One bounded line per connection, at most 511 request bytes, 1-second receive/send limits, loopback-only listener. The Node adapter bounds response bytes/time and verifies sample protocol/profile/PID. Protocol 3 deliberately rejects P0 and earlier protocol-1/2 descriptors; use a newly launched client and its own descriptor.
- Direct diagnostic commands remain `<token> sample`, `health`, `surface`; `session`, `claim`, `keep`, `release`, `login`, `server`, `char`, `move`, `stop`, `receipt` serve the adapter. Do not construct credential-bearing wire commands in retained shell/tool arguments. No arbitrary memory, console, packet, function-pointer or process-control endpoint exists.

## Native geometry inherited from P0

Viewport offsets `+0x58`, `+0x38/+0x3c`, `+0x3c` were inspected in this Engine's tick. `UObject::IsA` and `AActor::GetLevel` execute on the game thread. Controller pawn `+0x3a8` is checked against APawn and the current level; origin `+0x1bc`, cylinder radius/height `+0x2f0/+0x2f4` came from this build's `execFastTrace`/`GetCylinderExtent`. Pointer strings are opaque diagnostic identities, not reusable handles. A login-scene level/actor is not an authenticated player; null pawn is unavailable geometry, not an empty world.

The legacy direct `surface` command queues one downward ray from current origin to origin Z minus cylinder height minus 256, with zero extent/no caller coordinates. The game tick fences pawn/epoch and invokes `ULevel::SingleLineCheck`. The 48-byte FCheckResult, endpoint order, return convention (0 hit / 1 clear) and `0x86` mask came from this exact build's `execTrace(false)`/`SingleLineCheck`. It is not a swept cylinder, calibrated contact point, standing correction, walkability proof or complete map-loading claim.

Observe `surface.requestId`, `epoch`, `status` in a later sample; submission is not a result. Status: `unavailable`, `queued`, `hit`, `clear`, `stale_epoch`, `invalid_native_result`. Only `hit` exposes copied fields; linked native results are not retained. One pending ray, no automatic retry. Zero sample sequence has null age; otherwise use sequence/age/thread/epoch together. Software rendering can be slower than 5 Hz.

## Verification boundary

P0 passed for this exact client: handshake, direct auth/game/world entry with the designated existing character, checked native pawn geometry and one bounded downward native hit. Hit fraction/normal and continuing tick samples were cross-checked; the client exited normally. Wrong-token and missing/altered-identity checks were recorded earlier. Original client binaries/configuration and server admission were not patched. The user accepted the agreement manually; GM assignment had separate explicit approval.

The bounded partial-P1 check negotiated MCP, listed its four tools, rejected a stale epoch and queued one native login from the local credential file. Exact replay returned the same request; the later receipt was `dispatched` / native return 1. The client opened a direct auth connection and displayed its agreement without coordinate-based login input. A new adapter read the original receipt and advancing samples without replaying auth; ownership was released. After the user reconfirmed prior manual acceptance, the unchanged repeated prompt was continued once through the original UI, not a native auth bypass or generic consent capability. Subsequent MCP reads reported `server_list_ready` and one server-entry callback; the rendered list corroborated Bartz. That earlier login-only check did not cover explicit selection or world entry.

The protocol-2 slice subsequently selected an observed server and the designated existing character through actual MCP calls. Native receipts were dispatched/1; a later world observation independently confirmed game-start acceptance, matching self identity and a checked pawn. The rendered world no longer retained selection controls after routing through the native console wrapper. Stale epoch/revision, an unobserved server and changed-payload key reuse were rejected; exact replay returned the original receipts. A fresh MCP adapter recovered all three receipts and observed advancing world samples without claiming ownership or repeating an action. The unchanged previously accepted agreement was continued once through its original UI after checking its resource identity; this is not native consent automation. Failure callbacks, malformed/multi-server lists, ambiguous character names, enabled security pads and world-loss recovery were not exercised live.

The protocol-3 slice additionally exercised actual MCP move/stop, exact replay, changed-payload conflict, stale epoch and range rejection. Native origin/velocity/physics observations confirmed movement, short XY arrival and stationary stop; a released adapter's foreground move was interrupted and later observed stopped. Native manual Up movement revoked the agent owner before continuing through the normal client path. A new MCP adapter recovered final movement/stop receipts without replay. Forced lease expiry, unresponsive-thread stop, lock contention, world replacement and correction/fall classification were not live-verified.

P1 remains partial; native/MCP build and live-check evidence belong under ignored `tmp/investigations/c4-client-agent/`. Syntax/build success is not full P1 acceptance. Events/wait/capture, richer movement/correction/lifecycle telemetry, consent handling without UI assistance, calibrated contact/clearance and spawn coverage remain outstanding. No automated tests/test infrastructure are added or run. No server build/restart is part of this bridge's checks.
