# Authentication, packets and character sessions

Read this before changing packet layouts, account admission or character publication. This describes implemented contracts and limitations, not a security assessment or proof of real-client compatibility. See the [project map](README.md).

## Owners and reading order

1. `src/Server.js`: TCP listener, frame reassembly and connection-local error handling.
2. `src/AuthenticationServer/Session.js` and `src/GameServer/Session.js`: session state and packet dispatch.
3. Each server's `Network/Opcodes.js`, `Network/Request/index.js` and `Network/Response/index.js`: registration/export wiring.
4. The concrete request handler, gameplay owner and response serializer.
5. `src/Packet/Receive.js`, `src/Packet/Send.js`, `src/Packet/WireD.js`: wire primitives, not business authorization.

Authentication and game connections have separate sessions but run in the same application. Game world membership belongs to `src/GameServer/World/World.js`; durable account/character state belongs to `src/Database.js`.

## Frame and dispatch contract

- `Server.packetReceiver` buffers fragmented TCP input and splits coalesced input using a two-byte little-endian total length, including the header.
- Lengths smaller than the header close the connection. Synchronous handler errors and returned promise rejections also destroy that socket rather than deliberately terminating the application.
- Authentication sessions strip the header and decrypt with the configured Blowfish key; the initial server handshake is sent without that encryption.
- Game sessions strip the header and dispatch the opcode directly. Do not assume they inherit authentication-session cryptography.
- `Packet/Receive.js` skips the opcode and reads byte/short/D fields, byte blocks and NUL-terminated UCS-2 strings. `Packet/Send.js` constructs fields, padding and optional tail data.
- The send helper's checksum-named option is not itself a checksum implementation. `WireD` bounds checks only apply where a caller uses them.
- Request registration and serializer exports are explicit. Adding a handler file alone does not route packets. Extended game requests have a separate subopcode dispatcher in `Network/Request/ExtendedRequest.js`.

The session trace name maps aid diagnostics; opcode tables and actual serializers determine wire behavior. During character entry, `enterWorldReady` defers subsequent game requests until preparation resolves and checks that the selected actor is still current.

## Account identity and handoff

`src/AccountName.js` normalizes account names by removing non-ASCII-letter/digit/underscore characters, preserves case, and rejects unusable results or names longer than 14 characters. This is normalization, not rejection of every input containing an invalid character.

The authentication flow in `AuthenticationServer/Network/Request/AuthLogin.js` decrypts credentials, compares the supplied password with stored data and may create an account when `[AuthServer] autoCreate` permits it. Database name queries use `COLLATE NOCASE`; stored credentials must not be described as password-hashed by this implementation.

Authentication login/game-selection responses issue and compare a session key pair. **The game-side handoff is incomplete:** `GameServer/Network/Request/AuthLogin.js::consume` still leaves key matching as a TODO and registers the normalized username before loading characters. Do not describe a game connection as having a redeemed authentication token merely because it supplies those fields. This local emulator's implemented admission is not a production authentication guarantee.

`GameServer.advertisedHostname` controls the IPv4 advertised to the client; it is separate from the TCP bind hostname. If unset, `AuthenticationServer/Network/Request/ServerList.js` retains legacy address detection. See [runtime configuration](runtime.md).

## Character lifecycle

1. `GameServer/Session.setAccountId` registers the game connection through `World.insertUser`.
2. Replacing an account session saves/retires the old actor before destroying the old socket. Session identity prevents stale close callbacks from removing the replacement. World account-string matching is not identical to database case-insensitive matching.
3. `Network/Shared.js` loads account-owned character rows and related data. Character selection re-fetches by account slot and guards asynchronous completion with selection/session identity.
4. `Session.setActor` retires old publication, resets native UI and quest state, then constructs the selected actor.
5. `Network/Request/EnterWorld.js` and `Actor/Generics/EnterWorld.js` restore inventory, skills, quests and status before final publication. Effects are restored before derived stats/vitals; this is not restoration of an arbitrary in-progress battle.
6. Logout/restart save and retire the actor. Restart returns to character selection while retaining the connection.
7. Socket cleanup resets UI, duel/trade state and actor resources, saves only for the current world session, and detaches companions using disconnect semantics rather than deleting ownership.

`Actor/Actor.js` owns actor teardown, including summons, timers and actions. Owner deletion is refused while vassals exist; see [vassal ownership](vassals.md). Buffered writes and durable status have separate owners; see [persistence](persistence.md).

## Connected-player automatic action boundary

`.autofight` dispatches through local chat to the stock-HTML `player-auto-fight` bypass; `NpcTalkResponse` dynamically maps that name to its handler. Hunt, paged Skills and Settings pages are bound to the actor and connection epoch/revision, independently of optional native-menu negotiation. Each accepted action consumes its revision before dispatch; stale/duplicate Start, New Session and edits cannot replay. Threshold inputs accept only four bounded integer percentages; enabling requires a learned supported skill. Initial preference load and asynchronous save responses have separate actor/lifecycle/edit fences; delayed redraws additionally require the same open page revision and session-wide NPC HTML display generation. `Session.dataSendToMe` advances that generation on each NPC HTML packet, so opening another dialog (including `.menu`) revokes an earlier settings completion's redraw. `NativeUiSession.reset` invalidates page state without discarding saved preferences. See [durable preference ownership](persistence.md#connected-player-auto-fight-preferences).

Automatic hunting requests carry explicit run/action ownership, not a fake bot account/session. Client attack/skill/movement and second-click/pickup/basic-action paths stop that run before their normal action is installed. First-click inspection remains separate; automatic native execution retains its explicit target. Passive `ValidatePosition`/`StopMove` are not takeover commands: owned waypoint movement reconciles position without allowing stale reports to rewind/complete the route. Outside the run the native player path is unchanged. See [world/combat](world-combat.md#connected-player-auto-fight) for scope, cancellation and pending C4-client evidence.

## Client publication is not observer projection

`World/ActorVisibility.js` tracks actual game-client recipients and emits `CharInfo`, movement information and `DeleteObject` as visibility changes. A character appearing in a [WorldObserver](world-observer.md) map or persisted search does not establish native client visibility, reachability or successful entry.

## Equipment appearance

`UserInfo` and `CharSelectInfo` populate their existing final hair object-ID/template-ID fields from native slot 16; `CharInfo` populates its existing final hair display field. Repeated right-hand fields and the reserved appearance field after class stay unchanged. Formal Wear uses the chest-10 display alias, not an appended packet field. No opcode, packet length or old slot number is changed.

UseItem/UnequipItem publish UserInfo to self and CharInfo to existing visible recipients, retaining inventory refresh. Explicit MCP equip/unequip publishes the same appearance after an actual successful change; authority, receipt meanings and queued-persistence status are unchanged. Existing bot-upgrade/Lord publication remains separate and is not duplicated in intermediate Backpack removals. Character selection and live reconstruction share the [equipment projection](economy.md#equipment-and-style-restoration); observer projections are not native appearance acceptance. Race/sex rendering, another client's view and reconnect/selection behavior still require separately authorized C4-client checks.

## Update together and open checks

- Packet changes: opcode table → request export/parser → gameplay validation → response export/layout → framing/session assumptions.
- Identity changes: account normalization → database collation → session replacement → authentication/game key handoff.
- Lifecycle changes: selection generation → entry deferral → publication/retirement → disconnect persistence and companion cleanup.

Malformed/coalesced framing, real-client handshake, character switching and disconnect timing need separately authorized behavioral checks. Source inspection and syntax checks do not prove those flows work against a C4 client.
