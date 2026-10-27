# Bot MCP control and observation (P1–P2)

Read with [WorldObserver](world-observer.md), [runtime](runtime.md), [bot execution](bot-runtime.md) and [vassal ownership](vassals.md). This is an opt-in local development interface to **existing owned vassals**, not a provisioning tool, browser login, game client or second management frontend.

## Boundary and setup

```text
MCP host -> scripts/bot-mcp.js (SDK stdio)
         -> authenticated loopback management request
         -> generation-checked private game observer proxy
         -> Bot/Control/ControlService -> Authority / Actions -> native gameplay
```

- `scripts/bot-mcp.js` / `src/Mcp/{Server,Tools,GameBridge,Contracts}.js` own protocol framing, strict tool inputs and HTTP transport. They do not import game bootstrap, management startup or persistence. Stdout is protocol-only; diagnostics use stderr.
- `scripts/start.js` applies its normal access checks, then `src/WorldObserver/BotControlRoutes.js` handles only `/observer/api/bot-control/` and the exact typed allowlist in `Contracts.js`. The private game endpoint rechecks loopback peer/Host, absent browser Origin/Fetch Metadata, enablement and the dedicated secret. Browser management permissions do not grant MCP access. No arbitrary bypass, packet, handler name or privileged command is accepted.
- The parent proxies only to its current ready-IPC endpoint/generation. A stopped game or disabled private observer remains unavailable; the interface never starts the application or adds another listener. An older running revision is not evidence that new capabilities are deployed.
- `Control/{ControlService,Observation}.js` manage actor registration identity, observation attachments and compact self diagnostics. `Authority.js` owns leases/handoff, `Actions.js` owns typed native action continuations and pending holds, and `Results.js` bounds shared terminal evidence. `src/NodeL2.js` invokes control shutdown before normal game cleanup.

1. Leave `[BotControl] enabled = false` unless needed. Settings exposes this non-secret switch as game-restart-required. `WorldObserver.enabled` must remain enabled.
2. Supply the same `L2NODE_BOT_CONTROL_TOKEN` to management and the bridge through private environments: 32–256 random base64url characters. Never put it in tracked config, Settings, command arguments or MCP inputs. Managed children inherit the parent's environment; environment changes require an explicitly authorized restart of the appropriate owners.
3. Configure the MCP host to launch Node directly, with private environment injection:

   ```json
   { "command": "node", "args": ["/apps/L2Kingdom/scripts/bot-mcp.js"] }
   ```

   `L2NODE_BOT_CONTROL_URL` optionally selects the existing management origin, default `http://127.0.0.1:8088`. Only literal-loopback HTTP (`127.0.0.1` or `[::1]`) without credentials/path/query is accepted. Remote hosts can launch stdio through independently authorized SSH; do not widen HTTP exposure.
4. `npm run bot:mcp --silent` is a convenience command; ordinary npm banners must not enter the protocol stream. No bridge command starts/restarts the application.

Exact direct dependencies are `@modelcontextprotocol/server@2.4.0` and `zod@4.3.6`, compatible with CommonJS and Node >=22.5.0. The repository ignores `package-lock.json`; exact direct versions do not claim a pinned transitive graph. The SDK owns framing/negotiation; direct stdio inspection negotiated `2025-11-25`.

## Tools and identities

Inputs reject unknown fields. IDs are positive safe integers; registration/attachment/session/lease IDs are UUIDs. `runtimeEpoch` comes from `bot_status` and changes with the game process. `actorRef = {characterId, incarnation}` identifies one world registration, not just a persistent character. Retirement, replacement, world reset, offline state and shutdown invalidate its authority and attachments.

| Tool | Input / purpose |
| --- | --- |
| `bot_status` | `{}`: epoch, implemented/unsupported capabilities, limits, usage and bridge context; never starts the game |
| `bot_list` | `{runtimeEpoch, ownerCharacterId, offset?, limit?}`: exact-owner registry page, default 20/max 50, with labeled live/cached metadata and attachable actor refs; owner ID is a filter, not impersonation |
| `bot_attach` | `{runtimeEpoch, requestId, actorRef}`: read-only attachment; does not change AI |
| `bot_observe` | `{attachmentId}`: coherent `server_diagnostic` self sample, actual AI/plan, controller generation, lease clocks, foreground action and resumption blockers |
| `bot_control` | `{runtimeEpoch, requestId, attachmentId, mode, leaseId?, controlGeneration?}`: `manual` acquires; `keep_control` explicitly renews idle; `native_ai` returns authority without closing observation. The latter two require the exact grant when a lease exists. |
| `bot_action` | `{runtimeEpoch, requestId, attachmentId, leaseId, controlGeneration, timeoutMs?, command}`: one strictly typed action; gameplay request IDs are separate from control IDs |
| `bot_action_status` | `{actionId}` or `{leaseId, requestId}`: pending/retained gameplay receipt, including after attachment closure |
| `bot_cancel` | `{runtimeEpoch, requestId, attachmentId, leaseId, controlGeneration, actionId}`: control-sequenced cancellation of owned future work; accepted native effects may settle |
| `bot_release` | `{runtimeEpoch, requestId, attachmentId}`: close this attachment and revoke its lease; do not discard settlement holds |
| `bot_request_status` | `{requestId}`: retained control receipt from this bridge namespace, including after release |

Discovery enumerates registry metadata only on an explicit request, with at most 50 indexed live-registration lookups per page. It never wakes/spawns actors or builds a world snapshot. A busy actor can still be observed. Discovery/self busy flags are hints, not the complete manual admission validator.

Self observation is not client perception or a pathability guarantee. Nearby entities/drops, inventory/skill/effect detail pages, dialogues, semantic journals, cursors and waits remain unimplemented (P3/P4). The response labels these omissions; absence is not an empty world. No universal inventory/money revision is invented.

## Typed native commands

`bot_action.command` is a discriminated union, not `invoke(name, args)` or a scenario DSL. All native resource, timing, collision, ownership and eligibility checks still apply. `bot_status` lists capability gaps separately from actor eligibility.

| `kind` | Additional fields | Native boundary / completion |
| --- | --- | --- |
| `move` | `to:{locX,locY,locZ}`, `tolerance?` (1–64, default 32) | `Generics/MoveTo`: physical native route; measured XY tolerance and Z <=64, never route prediction/teleport as arrival |
| `approach` | `targetId`, `range?` (1–512, default 80) | Physical movement without activating the target; reports failure if the completed route no longer reaches the moving target |
| `stop` | none | Stops/cancels owned future work; returns any still-settling action ID rather than pretending committed work vanished |
| `target` | `targetId` or `null` | Native selection-only / clear; no double-click attack or NPC activation. Selection is limited to 2000 XY/512 Z. |
| `attack` | `targetId`, `until?` (`first_swing`, `target_dead`, `bounded`), `durationMs?` (default 10s/max 60s) | Native `AttackRequest/AttackExec/Attack`; first-swing completion uses the native cycle callback, not a guessed timer. Initially hostile NPCs/summons only, not PvP. Miss is not validation failure. |
| `cast` | `skillId`, `targetId?` | Existing learned/equipment skill via `SkillRequest/SkillExec/Attack`; self/party/ally/pet/friendly/enemy targets where supported. Native toggle result is measured explicitly; utility Spoil/Sweep, corpse/ground/travel adapters remain unavailable. |
| `state` | `property` (`seated`, `walking`), boolean `value` | Desired state through native basic actions, not an unsafe replayed toggle |
| `equip` | `itemId`, boolean `equipped` | Existing actor equipment through Backpack; native slot conflicts can unequip other gear. Live publication with queued persistence is not an atomic durable receipt. |
| `item` | `itemId` | Existing shots and consumable instant self skills only. Native item-skill outcome is captured at execution; timed/handler/nonconsumable/transport items are rejected before dispatch. |
| `pickup` | `groundItemId` | `PickupExec` plus native global claim/recipient serialization/capacity/party allocation. Must already be within native pickup radius/LOS; no remote award or repeated drop scan. Discovery/indexing is P3. |
| `summon` | `command` (`follow`, `stop`, `attack`), `targetId?` | Existing active summon; owned follow/stop or one native attack cycle. Skills, unsummon, mounts and pet inventory await their own adapters. |

Movement requests are bounded to 6000 XY from the actor, 4000 path nodes and 512 returned waypoints; no offscreen low-LOD relocation is enabled for an MCP-owned route. Default action deadline is 30 seconds, maximum 120 seconds. Bounded attack duration and the action deadline are separate. One foreground action is admitted per actor; dispatch serialization is not a hidden gameplay queue. Cancel/stop explicitly before conflicting work.

Example ordering: attach with control `requestId:1`; acquire `manual` with control `requestId:2`; submit an action with gameplay `requestId:1` and the returned lease/generation; read `bot_action_status`; return `native_ai` with control `requestId:3` and that grant; keep observing; release with control `requestId:4`. Cancellation, if used, also consumes the next control ID.

## Authority and native handoff

- At most four manual leases exist. Acquisition refuses native transaction/publication work, active combat settlement/animation, training/crafting/award/quest work, inference/conversation, custody/trade, payment/teleport, vassal admission/operation/receipt and summon settlement. No busy flag is cleared to force admission.
- Before granting authority, capture whether AI was active, advance the control generation, stop scheduled/dispatched AI, invalidate the vassal journey/route, clear queued/stored/selection continuations and stop existing summon commands. `PlayerActionOwner` recognizes **explicit `bot-mcp` ownership**, never a forged `player-auto-fight` tag. Async attack/skill/selection/pickup and summon callbacks capture generation/revision; old work cannot revive after lease closure.
- `BotAI` activation/scheduling/ticks and provider entry are gated while the handoff marker exists. Incoming damage, effects, regeneration, death, pet feeding/lifetime and unrelated actors remain native world work. SP-triggered autonomous training during a lease is deferred and reconciled before resumption; existing in-flight training prevents acquisition.
- Authorized lord duties, party admission/panel commands, trade ingress, party detach, native teleport and an external AI stop preempt at their native boundaries. Existing busy/publication rules remain: an owner command blocked by settlement must be retried after the visible busy response, not silently applied or made to discard a hold. External native AI stop overrides the remembered activation intent.
- Lease liveness is 120 seconds, renewed by the bridge heartbeat every 30 seconds. A **separate 10-minute idle deadline** is reset only by a new admitted gameplay command or explicit `keep_control`. Reads, automatic heartbeat and replay do not reset idle. Every native owned continuation checks current authority; shared cleanup polls at 250ms rather than allocating timers to ordinary bots.
- Revoke invalidates authority first, then cancels safe future work. Already accepted actor swings/casts retain native impact/cycle timers and their action correlation until settlement; native interruptions can cancel them. Summon command revisions safely invalidate cancelled future summon hits. No damage, loot, charges, MP or consumable is rolled back.
- Holds outlive leases, namespaces and attachments. Resumption uses current native orders/state, not copied plans/inventory/position/party. Only previously active eligible AI resumes, unless a later native stop vetoed it. Observation survives `native_ai`. A failed/uncertain publication remains visibly blocked; there is no MCP “clear hold”, refund or administrative recovery tool.

## Ordering, results and bounds

- First explicit attach opens one server-issued bridge namespace. An uncertain open is not retried under another identity in that process. Control `requestId` starts at 1 and is consecutive across attach/control/cancel/release/internal close. Domain rejection consumes the control ID; gaps report the next expected ID. Closed/expired namespaces are not silently reopened.
- Gameplay `requestId` is an explicit **increasing per-lease key**, independent of control IDs. The bridge serializes per-lease dispatch, assigns consecutive `sequence`, and retains its mapping before sending. A repeated retained key/payload returns the same action, changed payload conflicts, and an evicted older key cannot execute again through a fresh sequence. Authority-invalid calls cannot admit new work.
- Capacity/foreground/native-busy rejections are retained terminal gameplay results and consume that sequence, not idle renewal. Pending actions are recorded before native dispatch. One HTTP response loss is not disconnect/cancellation. Never retry an uncertain mutation with a fresh request ID. Use `bot_action_status` by lease/key when the original action ID was lost.
- Control and gameplay share **256 terminal receipts / 1 MiB / up to 15 minutes after completion**. Pending records are separate, capped at eight globally including revoked leases; receipt eviction cannot release their holds. At most 12 handoff states (four leases plus eight possible residual states) exist. New admission rejects capacity before native work; cancellation, release and evidence reads do not need a gameplay slot.
- Receipts distinguish status (`rejected/accepted/running/succeeded/failed/cancelled/interrupted/unknown`), phase, execution outcome, gameplay outcome, publication state, native/adapter reason, evidence, side effects and completion condition. The native hit/effect/cycle is correlated with its concrete owner, not a mutable session-wide “current action”. Accepted/path-found is not completed. Actual HP damage and requested damage are distinct; resources/reuse can be consumed even without an effective hit. Status queries can successfully return a failed domain action.
- Native pickup reports recipient outcomes, not inferred bag deltas. `award_failed` can mean partial/uncertain committed allocation and blocks conflicting resumption; presentation-only failure remains an awarded native result. Immediate equipment/item changes report live application with queued persistence, not durable DB acknowledgement. Inventory revisions remain unavailable in the compact view.
- Identical control acquisition returns the original grant with current `authorityState`, never reacquires it. Replayed attachment receipts report `resourceState`. Read-only result lookup remains authenticated but requires neither an active attachment nor a current lease. Epoch mismatch after restart is explicit; there is no persistent receipt store or cross-process exactly-once claim.
- Namespace liveness is also 120 seconds. EOF/signals stop queued bridge dispatch, await already-sent acknowledgements and request namespace closure using the server's actual next control ID. Failed cleanup is reported on stderr; server expiry remains the backstop. The bridge bounds sequencing metadata to 16 lease contexts/256 mappings each; evicted contexts return `bridge_sequence_expired`, never silently recreate old dispatch identity.
- Existing P1 bounds remain: 16 namespaces, 16 attachments, eight distinct observed actors, 16 concurrent HTTP calls/process, 16 KiB request bodies, 64 KiB upstream response/MCP input buffering and 12/14s proxy/bridge deadlines. One world listener exists only while attachments exist. One namespace cleanup timer and one bounded active-handoff timer replace per-bot polling; no semantic journals or new ground-item index are allocated in P2.

Raw HTTP additionally has exact `open`, `heartbeat`, `close`, `request-status`, `control`, `action`, `action-status`, `cancel` operations; only `status` is GET. The generic parent game proxy does not expose this namespace. All requests require the dedicated credential; diagnostic actor/registration refs are not a substitute for it.

## Remaining adapters and verification

P3 owns bounded local/detail queries, indexed nearby drops, journals, cursors and waits. P4 owns dialogue/NPC services/quests/social and remaining inventory/summon families. Legacy NPC purchases have delayed grants without a batch receipt; NPC sale is not the similarly named private-buy-store handler. Personal storage/clan withdrawal are per-line operations, craft booleans lose commit/publication detail, and autonomous training review is not a selected trainer transaction. These must not be exposed by wrapping a void/boolean call as success. Administrative free shops, bypass strings, grants, teleports, reset/lifecycle/data tools remain excluded.

Syntax, source inspection and MCP negotiation/tool-list inspection do not prove live exclusivity, idle/TTL, duplicate recovery, busy holds, damage/cast results, walking or safe AI resumption. Runtime acceptance requires separately authorized deployment of the changed parent/game and one exact existing test-world vassal; no running older revision validates this implementation. No automated suites or new test infrastructure are required or introduced.
