# Bot MCP observation (P1)

Read with [WorldObserver](world-observer.md), [runtime](runtime.md), [bot execution](bot-runtime.md) and [vassal ownership](vassals.md). This is an opt-in local development interface to **existing owned vassals**, not a provisioning tool, browser login, game client or second management frontend.

## Implemented boundary

```text
MCP host -> scripts/bot-mcp.js (SDK stdio)
         -> authenticated loopback management request
         -> generation-checked private game observer proxy
         -> Bot/Control/ControlService -> existing registered BotSession/Actor
```

- `scripts/bot-mcp.js` / `src/Mcp/{Server,Tools,GameBridge,Contracts}.js` own protocol framing, strict tool inputs and HTTP transport. They do not import game bootstrap, management startup or persistence. Stdout is protocol-only; diagnostics use stderr.
- `scripts/start.js` applies its existing peer/Host/Origin checks, then `src/WorldObserver/BotControlRoutes.js` handles only `/observer/api/bot-control/` and the exact action allowlist in `Contracts.js`. No browser-selected upstream, arbitrary bypass, handler name or privileged operation is accepted.
- The new handler rechecks loopback, loopback Host, absent browser Origin/Fetch Metadata, enablement and a dedicated secret in **both** parent and game. Only `x-l2-bot-control-token` is forwarded, alongside generated JSON headers. Existing browser management permissions do not grant MCP access.
- The parent uses only its current ready-IPC endpoint/generation and rejects a changed/stopping generation before returning results. A stopped game returns `server_unavailable` with phase/observer context; it is never started automatically. A running game without its private observer is also unavailable: enable `WorldObserver.enabled` and deploy explicitly rather than opening another listener.
- `src/GameServer/Bot/Control/{ControlService,Observation}.js` select current registered actors, manage transient observation subscriptions and return compact self diagnostics. They do not change AI scheduling, duty, inventory, ownership or world state. `src/NodeL2.js` closes subscriptions when shutdown begins.
- P1 exposes **no manual authority or gameplay action**. It also does not expose nearby entities/drops, dialogues, event journals, waits or detailed inventory/skills. Responses explicitly mark these sections omitted; absence is not an empty world.

## Configuration and host setup

1. Leave `[BotControl] enabled = false` unless this interface is needed. Settings exposes this one non-secret switch as restart-required. The private observer must remain enabled.
2. Supply `L2NODE_BOT_CONTROL_TOKEN` through the private environment of the management parent and MCP bridge. Use a randomly generated base64url secret of 32–256 characters; no tracked file, Settings field or MCP response contains its value. Managed children inherit the parent's environment. Changing that environment requires the appropriate explicit service/game restart; changing the saved enablement value alone is not proof of active runtime configuration.
3. In the MCP host, launch Node directly with an absolute script path, for example:

   ```json
   {
     "command": "node",
     "args": ["/apps/L2Kingdom/scripts/bot-mcp.js"]
   }
   ```

   Supply the token using the host's private environment mechanism. Optional `L2NODE_BOT_CONTROL_URL` selects the management origin, default `http://127.0.0.1:8088`. Only HTTP literal loopback (`127.0.0.1` or `[::1]`) is accepted, without credentials, paths or queries. Use the configured management port. Remote hosts can run this stdio command through an independently authorized SSH connection; do not widen HTTP exposure.
4. `npm run bot:mcp --silent` is a convenience command. Do not use ordinary npm banners on an MCP protocol stream. No bridge command starts or restarts the application.

Dependencies are exact direct versions in `package.json`: `@modelcontextprotocol/server@2.4.0` and `zod@4.3.6`, compatible with the project's CommonJS/Node >=22.5.0 boundary. The repository deliberately ignores `package-lock.json`; installation updates a local lockfile but it is not published. Exact direct versions do not claim a repository-pinned transitive dependency graph. The SDK owns negotiation and framing; the locally inspected stdio exchange negotiated protocol `2025-11-25`.

## Current tools and identity

All inputs reject unknown fields. IDs are positive safe integers; incarnation/attachment/session IDs are UUIDs. `runtimeEpoch` is returned by `bot_status`, changes with the game process and must accompany discovery and control-plane requests.

| Tool | Input | Result / purpose |
| --- | --- | --- |
| `bot_status` | `{}` | Runtime epoch, P1 capabilities, limits/usage and current bridge namespace context; structured error when unavailable |
| `bot_list` | `{runtimeEpoch, ownerCharacterId, offset?, limit?}` | Page of exact registered vassals; default 20, maximum 50; `nextOffset` and total. Owner ID is a selection filter, not impersonation of that character. |
| `bot_attach` | `{runtimeEpoch, requestId, actorRef}` | Control receipt containing `{attachmentId, actorRef, mode:"read_only"}`; no AI takeover |
| `bot_observe` | `{attachmentId}` | Synchronous `server_diagnostic` self sample, epoch/ref/time, actual AI activation/plan, selected busy flags and completeness/omission markers |
| `bot_release` | `{runtimeEpoch, requestId, attachmentId}` | Control receipt; closes only this bridge's attachment, without AI changes |
| `bot_request_status` | `{requestId}` | Retained control receipt from this bridge namespace, including after attachment closure |

`actorRef = {characterId, incarnation}` identifies a **world registration**, not merely an object ID or persistent character. Replacement, retirement, world reset, offline state and shutdown invalidate subscriptions. Each discovery row reports owner, availability, busy reasons and an actor reference only when attachable. Name/class come from the live actor or a labeled cached life-state snapshot; unavailable metadata is `null`, never fetched by waking/spawning a bot. Discovery enumerates existing registry metadata only on explicit requests and makes at most 50 O(1) live-registration lookups per page; it does not build a global observer snapshot or add per-bot polling.

Busy flags in P1 are diagnostic hints, **not** a complete manual-admission validator. A busy live bot can still be observed. The compact sample is not a client visibility, LOS, pathability or future action-success guarantee. Inventory revisions and event cursors are explicitly unavailable, not invented counters.

## Namespace, ordering and cleanup

- The first explicit attach establishes one server-issued namespace (`open`); no caller-supplied namespace can be reopened. If establishment has an uncertain reply, the bridge refuses another attempt in that process. Restart it explicitly and allow the possibly orphaned namespace to expire. No auto-reconnect/reacquire/replay under a new identity is performed.
- Within that namespace, `requestId` is the consecutive control sequence: start at **1**, then 2, 3, etc. Attach, release and internal close share it. The bridge serializes their dispatch and caps queued calls at 16; reads remain parallel. A domain-rejected control receipt still consumes its sequence; inspect the structured result rather than assuming success from HTTP/MCP execution.
- Identical retained `(sessionId, requestId, kind, payload)` returns the same receipt; changed payloads conflict. Older evicted IDs return `request_expired`; gaps return `request_out_of_order` and the next expected ID. High-water marks survive receipt eviction while the namespace is active. Closed/expired namespaces are not recreated.
- A duplicate attach for an already attached actor in the same bridge returns the existing attachment, not another subscription. Replay reports `resourceState: closed` if the original attachment no longer exists; it never reacquires it. Lookup of a known receipt does not require an active attachment or namespace, only the same authenticated epoch/session reference.
- Receipts identify `{runtimeEpoch, sessionId, requestId, kind, status, result}` and possible `error`. A completed attach/release is a **control-plane result**, not evidence of a gameplay effect. P1's `accepted` reservation settles synchronously; transport failures are separate and can leave the caller uncertain. No cross-process exactly-once claim or persistent receipt store exists.
- One bridge heartbeat every 30 seconds renews its namespace. No heartbeat for 120 seconds logically expires all its attachments; a request enforces expiry immediately and the idle resource sweep can lag by at most five seconds. Stdin EOF/signals request namespace closure; the bridge first reads the current high-water mark so a rejected/out-of-order earlier call does not prevent cleanup. If transport cleanup cannot be confirmed, stderr reports it and server expiry remains the backstop. Loss of one HTTP response is not an MCP disconnect.
- Initial runtime-wide caps: 16 namespaces, 16 attachments, 8 distinct observed bots; 256 retained terminal receipts / 1 MiB, for up to 15 minutes. Early eviction is explicit unknown/expired, not replay permission. Each process accepts at most 16 bot-control HTTP requests concurrently; request bodies use the existing 16 KiB JSON reader, upstream responses and MCP input buffering are capped at 64 KiB. Proxy/bridge deadlines are 12/14 seconds, below normal MCP tool deadlines.
- One shared world-publication listener exists only while attachments exist. One unref'd cleanup timer scans at most the bounded namespace/attachment maps; no per-bot timers or semantic event buffers are created. Disconnect/expiry removes unused listener state. Results can remain until their separate retention boundary.

The raw HTTP surface additionally has exact `open`, `heartbeat`, `close`, `request-status` actions; all except `status` use POST JSON, all require the dedicated token. The normal parent `gameRoute` proxy allowlist does not include this family. Unknown/manual actions are not routed to a generic dispatcher.

## P2 authority and adapter contract — specified, not implemented

Do not add an MCP action merely because a native method exists. Before manual capability is advertised:

- Control-plane acquire/renew/native-AI-return/release retain the P1 namespace/sequence protocol, including acquisition before any lease exists. Manual authority adds `{runtimeEpoch, actorRef, attachmentId, leaseId, controlGeneration}`; one actor has at most one current lease and the initial global manual cap is four.
- Gameplay requests add an action request ID and increasing per-lease sequence, expected native revisions only where verified, one foreground action per actor and explicit conflict/cancellation. Revoked generations cannot initiate or continue owned work. World damage, effects, regeneration, death and unrelated actors keep running.
- Authority and evidence have separate lifetimes. Revocation prevents new work immediately, but committed/publication operations retain their holds and minimal pending result until settlement. Initially admit at most eight in-flight gameplay records globally, including revoked owners; terminal receipt eviction must never discard pending holds. Result lookup remains read-only after release. A wait timeout/disconnect cannot roll back money, consumed items, damage or social effects.
- Native action receipts must distinguish `rejected/accepted/running/succeeded/failed/cancelled/interrupted/unknown` and report action/request/actor/generation identity, phase/timestamps, execution outcome, gameplay outcome, publication state, reason/source, side effects, completion condition and cancellation support. Acceptance/path planning/menu issuance are not completion.
- Returning to native AI retains observation and resumes only the duty/AI that was eligible before takeover, after publication holds settle. Read-only attachment must never start inactive AI.

The P2 ingress audit starts at `BotAI.scheduleTick/stop/wakeup`, `HotAiDispatcher`, `AI/VassalOrders` operation/receipt callbacks, `Travel/JourneyExecutor` planning/payment/arrival continuations, owner orders in `Lord/VassalService.issueOrder` and `AI/PartyCompanionService`, chat/provider continuations, `Actor/Generics/{MoveTo,AttackRequest,SkillRequest,SkillExec}`, and summon target/skill/resume callbacks in `Npc/SummonControl`. Native training, crafting, pickup, warehouses, multisell and inventory publication have separate pending work. `Actor/PlayerActionOwner` accepts only player-auto-fight ownership: never forge that tag for MCP. Stopping `BotAI` alone is not proof of exclusivity.

The approved implementation plan's adapter matrix records exact native result gaps and per-family acceptance. In particular, legacy NPC purchases use delayed grants without a batch receipt; NPC sales are not the similarly named private-buy-store handler; personal storage and clan withdrawal are per-line operations; craft booleans lose commit/publication detail; training review is an autonomous reconciliation path, not automatically a player-like trainer action. P2/P4 must resolve the applicable native contract before exposing each family. Administrative free shops, arbitrary bypasses, grants, teleports, resets, lifecycle and data tools remain outside the bot-control surface.

## Verification boundary

Syntax checks do not establish runtime attachment, TTL, duplicate recovery, credentials, observer prerequisite, concurrency limits or unchanged AI behavior. MCP stdio negotiation/tool listing can be inspected without starting the game. End-to-end checks require separately authorized deployment of both changed parent and game, then an existing exact vassal on the designated test world. Do not claim a running older revision validates these changes. No automated suite or new test infrastructure is required or introduced by this interface.
