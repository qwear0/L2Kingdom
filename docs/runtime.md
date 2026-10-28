# Runtime, configuration and lifecycle

Read this when changing startup, effective configuration or shutdown behavior. See the [project map](README.md), [operations](operations.md) and [Settings/API guide](world-observer.md).

## Entrypoints and process boundaries

| Entrypoint | Responsibility |
| --- | --- |
| `package.json` → `scripts/start.js` (`npm start`) | Persistent API-only WorldObserver management parent. Owns auth/Settings APIs, configuration/preset writes and lifecycle/data operations; does not serve browser pages/assets. Does not start gameplay on launch. |
| `scripts/run-server.js` (`npm run NodeL2`) | Geodata/runtime wrapper. Spawns `src/NodeL2.js` with `--openssl-legacy-provider`, repository working directory and shutdown IPC; not another management frontend. |
| `src/NodeL2.js` | Owns SQLite, world, TCP listeners, bots and optional game observer API. Direct invocation bypasses geodata preparation. |
| `src/ConfigLoader.js`, `src/Global.js` | Shared INI loading; only the runtime installs `invoke`, utilities and global options. The parent does not import game singletons or open the world DB to serve auth/Settings APIs. |
| `src/Server.js` | TCP listener/session owner, with a `ready` promise and listener-error callback. |

`npm start` listens for APIs at `[WorldObserver] hostname/port` (committed default `127.0.0.1:8088`). It opens `/observer/settings/server` at the separate `publicOrigin` only when that origin is configured and `L2NODE_NO_BROWSER` is not `1`; it logs the backend binding separately and does not check frontend availability. Empty `publicOrigin` disables proxy trust/auto-open, not API access. A configured origin requires management to bind `127.0.0.1`; port changes are not required by separation.

Browser sources live in `src/frontend/public/`; `src/frontend/` owns independent Nginx/Docker/Compose packaging (service `frontend`, container `l2kingdom_frontend`). New parent processes do **not** serve pages, login HTML or frontend assets. Image build, listener/session checks and cutover require separate authorization; source changes do not change running processes. See [frontend configuration and operations](world-observer.md#frontend-configuration-and-independent-operations).

Browser APIs require a personal admin-key session; create the first key with `npm run observer:key -- "User name"` using the same `L2NODE_RUNTIME_DIR` as management (default `tmp`). Login uses only the key, with a persistent 30-day cookie; see [observer authentication](world-observer.md#personal-keys-and-browser-sessions) and the [proxy/direct boundary](world-observer.md#lan-and-peer-sensitive-boundary). There is no launcher page/listener on 8090 and no legacy `/api/*` management namespace or launcher host/port/name flags.

```text
independent Nginx frontend: browser pages/maps (image/deployment separately authorized)
                       `-> management parent /observer/api/* and item-icons/*
local MCP directly ------> |-- auth, Settings and all management actions
                           |-- sole local INI and preset JSON writer
                           `-- bounded known-route proxy -> private 127.0.0.1:<OS-assigned port>
                                                            wrapper -> NodeL2
                                   generation-bound readiness/settings/shutdown IPC
```

In managed mode the game observer binds loopback port **0**, reports the actual port through the wrapper, and never reuses the management listener. The frontend must never target this ephemeral endpoint. Direct `npm run NodeL2` retains the standalone observer binding/disabled/static behavior, reading moved browser resources, but has no persistent Settings management API or trusted-proxy mode. It is not a replacement management frontend/supervisor.

### WorldObserver.enabled

Under `npm start`, this controls the **game observer API only**, not the persistent management/auth/Settings APIs. When false there is no private observer listener or proxy readiness requirement; game readiness still requires authentication/game listeners and initialization. Settings, logs, saved-game management and explicit inference remain available. Live world/search/count routes return unavailable, not an empty world. Hostname/port still select the backend management listener. They and `publicOrigin` are read-only service-owned Settings fields, with active values captured at parent startup; their restart owner is external.

This is a migration in entrypoint ownership, not evidence that an existing service command, firewall or LAN binding has been changed. Confirm the real service owner/command and private binding before separately authorized stop-and-replace deployment.

## Configuration precedence and ownership

The parent and runtime use `ConfigLoader` with the existing `js-ini` parser and nested merge semantics:

1. `config/default.ini`.
2. Optional `L2NODE_SHARED_CONFIG_FILE`.
3. `L2NODE_CONFIG_FILE`, or `config/local.ini` when that variable is absent.

Optional missing files contribute no overrides. Paths resolve against the repository; wrappers use that working directory. Empty INI values use the parser's native undefined typing. `config/local.example.ini` is not automatically loaded. Private keys and machine-specific values belong in ignored overrides, never documentation.

Environment overrides are consumer-specific, **not** a universal final INI layer:

- `ProgressionRates` uses `L2NODE_PROGRESSION_RATE`; the managed parent passes the authoritative next-start preset to each child.
- `PopulationConfig` snapshots its environment/file values, then enforces owned-only policy. PvP, knowledge errors and diagnostics are restart fields. `BOT_PVP_AGGRESSION`, `BOT_KNOWLEDGE_ERRORS_ENABLED` and `BOT_DEVELOPER_DIAGNOSTICS` lock their controls, including explicitly supplied empty population overrides.
- Existing `[AI]` wins over `[OpenRouter]`. Model/router environment variables lock only the fields their gateway consumer actually owns. Provider URL/keys are never editable here; see [AI](ai-social.md).
- Geodata uses `L2NODE_GEODATA_DIR`; mirror/checksum controls belong to preparation, not the INI editor.

### Settings persistence and reconciliation

The curated parent API edits only permitted local scalar keys in `L2NODE_CONFIG_FILE`/`config/local.ini`, never shared/default layers or browser-selected paths. It validates the full submitted patch, preserves unrelated text/comments/keys and file mode, rejects ambiguous duplicate targeted sections/keys, reparses the result, stages/fsyncs in the same directory, rechecks layer revision and atomically replaces the local file. Ordinary single-link files are required for managed reads/writes; symlink/hardlink ambiguity is rejected. Revision checks detect edits but cannot coordinate arbitrary external editors in the final check/rename interval. Storage failures are explicit, not reported as successful saves.

`null` removes only a descriptor-permitted local override. Resolution then follows remaining layers before native sibling fallback: removing local SP may expose a shared SP value rather than inherit EXP. Runtime apply mutates only explicitly saved **live** keys on existing section objects, after persistence; restart fields are not applied. Rate/native-knowledge caches already track profile inputs and need no generic invalidation.

Disk persistence and IPC are not one transaction. Only an authoritative runtime read counts as active. Failed/uncertain live application or an externally changed saved live value remains **Saved, not applied; Stop → Start required**. There is no background retry, Apply saved endpoint/button or implicit restart. Another explicit save may apply its own fields, not unrelated pending values. When stopped, values are **Saved for next start**. Restart/service pending state is derived from actual observed values, not a browser acknowledgement.

### Separate preset store

`launcher-settings.json` retains its name/location under `L2NODE_RUNTIME_DIR` (default `tmp`) and `L2NODE_LAUNCHER_SETTINGS_FILE` override. It is not part of an INI tab save or a world snapshot.

- A non-empty parent `L2NODE_PROGRESSION_RATE` is forced/read-only; otherwise the stored `progressionRate` wins, or x1 if genuinely absent.
- Only exact x1/x10/x50 are accepted. Malformed JSON or invalid explicit environment/stored values leave the UI available with an actionable error; they are not replaced by x1.
- The dedicated revisioned mutation preserves unrelated JSON fields/mode and atomically replaces a same-directory staged file. Failed writes cannot change the saved selection.
- Saved next-start and child-captured active presets are distinct. Start rereads and validates the authoritative selection/rate combinations without rewriting an unchanged preset or saving drafts. Changing the selection never mutates a running child environment.
- `General.progressionPreset` remains a standalone-runtime input, not a second managed selector. INI and JSON writes are separate transactions.

## Curated numeric bounds and native limitations

`SettingsDescriptors.js` owns strict bounds for **new edits**. Reads do not clamp/rewrite existing overrides. Start validates rate combinations for every supported preset, including the selected next launch.

| Controls | Descriptor bound / source contract |
| --- | --- |
| Individual reward modifiers | 0..10; each preset product finite and ≤500. This is a conservative curated operational envelope, not a new native storage type or a global reward-safety proof. |
| Normal/blessed/crystal chances | 0..100 percent. |
| Enchant safe/max integers | 0..32767: `ItemsList`/trade/warehouse enchant fields reach signed `Packet/Send.writeH`. `Enchant.enchant` refuses further increments at 32767 even when configured max=0; existing items are not downgraded. |
| PK continuation / PvP aggression | 0..1; PK UI uses percent. Native policy semantics are unchanged. |
| Player warehouse slots | 1..1000, matching `PersonalWarehouseLimits`; contents and withdrawals survive reduction, bot capacity unchanged. |
| Request concurrency | 1..128, curated operational admission limit; existing in-flight work is not aborted. |
| Auth/game ports / advertised address | 1..65535 / IPv4 or permitted inheritance; bind hostname is read-only context. |

Why the rate bounds are not a universal guarantee:

- `Packet/Send.writeD` represents unsigned C4 D values through `0xffffffff`; console reward messages, SP and some warehouse paths do not all use a display saturation helper. Inventory list display saturation does not make arbitrary rewards safe.
- Static source inspection found NPC base SP up to 1,356,048 and normal reward quantities up to 400,000 with group overall up to 149.3019. At modifier 10/preset x50, the unmodified base SP award is 678,024,000 and an envelope for one base drop amount is 298,800,000 (ceil of 746.5095 repeats × 400,000), within D. These figures are **not** exhaustive effective reward maxima.
- NPC EXP is `level² × authored modifier`; NPC max-HP effects can multiply EXP/SP further (`Npc.fetchRewardMaxHpMultiplier`). `ExperienceReward`/`ProgressionCap` cap accepted character EXP at the C4 table boundary (level-78 upper boundary 2,099,275,834), but **cumulative SP has no corresponding native transport guard**, in both `ExperienceReward` and `Database.applyQuestStep`. Any positive reward can eventually exceed D. This pre-existing defect is not silently clamped or repaired by Settings.
- Quest specific modifiers use the shared profile in `QuestStep`, `QuestService` and authored handlers. Fixed rewards and variable-size hand-ins differ: `Q327_ReclaimTheLand` multiplies held counts for EXP/Adena. There is no finite positive modifier that proves all arbitrary legacy holdings or cumulative balances fit D. Objectives and held stock are not scanned/rebalanced here.

Exceptional legacy stock/effects/cumulative-SP behavior therefore remains a separately scoped native gameplay/protocol repair and acceptance risk. Do not describe bounded descriptor/product checks as proof of global numeric safety, or use a personal live world to probe these limits.

## Startup/readiness

NodeL2 initializes DB/data maintenance, clans/geodata/world, clan halls/AFK trades, personas/catalogues, TCP listeners and bots before optional observer and developer console readiness. Startup can migrate/write persistence; it is not a read-only check.

Managed **running** requires completed necessary initialization, awaited AuthServer and GameServer listening, and awaited private observer listening when enabled. The parent uses v1 generation-bound `ready` IPC, not a log marker. Required listener/startup failures initiate shutdown; an old generation cannot mark a new child ready. A 30-minute readiness deadline allows full-world geodata connectivity preparation and requests the same graceful shutdown chain on expiry, not a second process. Territory pools use an input-validated derived disk cache; a hit avoids cold sampling/path searches and reuses the validated fixed-position audit/proofs, but still performs input hashing and root normalization. See [accessible placement](content.md#accessible-monster-placement) and [offline profiling](operations.md#offline-territory-profiling). Cold preparation continues through renewable aggregate work quotas without discarding established proofs or per-target limits. The 900-second preparation deadline, RSS and capacity stops remain hard bounds; an incomplete inventory or hard blocker fails world initialization before NPC publication instead of reporting a budget-starved world as ready. Preparation reports bounded progress in the server log; progress messages do not establish readiness.

Settings IPC is independently available without observer HTTP: `settings.read`, `settings.apply`, `settings.reply`, current generation and bounded request IDs. Parent correlation is capped at 32 outstanding requests with a four-second reply bound; stale replies are ignored. Proxy requests have a 15-second deadline and endpoint/generation checks.

## Shutdown truthfulness

`shutdown-result` reports **clean / failed / timed_out** separately from process phase; missing evidence remains **unknown**. Code 0 alone is not clean-save evidence. NodeL2 waits for its bounded bootstrap step, stops new listeners, drains population/character writes, workers/tracing/social events and closes SQLite, carrying step failures into the outcome. Narrow optional failure callbacks also report previously swallowed journal/outbox/history-stop, final-checkpoint-result, tracing and pathfinding-termination failures without interrupting subsequent cleanup or changing existing callers' return shapes. The 15-second deadline exits nonzero with timed_out; the wrapper may force its runtime after 18 seconds but still waits for OS-confirmed child exit.

Before the final `CharacterWriteQueue.flushAll` and SQLite close, NodeL2 awaits `PopulationService.stop`: periodic owned-snapshot admission is closed, any already admitted snapshot settles, and a fresh final owned-actor snapshot saves the latest position/status and lifecycle posture/waiting metadata. Both snapshot passes and cold/local stop work must settle while the database is still open. A failed component does not short-circuit waiting for the other drains; the aggregate error marks shutdown failed through the existing shutdown owner. This is not a final full-world snapshot or complete gameplay quiescence, and the same 15-second forced-exit deadline still bounds cleanup.

The wrapper emits generation-bound `tree-exited` only after its runtime closes; the parent retains stopping/exclusion until wrapper close. It never kills the wrapper as a substitute for reaping the descendant. If descendant termination cannot be confirmed, status remains error/unknown and conflicting data/start operations stay blocked; investigate through the actual external service owner, not by adopting/killing unrelated processes or removing DB locks. A confirmed crash may be stopped at the OS level while cleanup is failed/unknown; that distinction is visible.

The wrapper reacts to loss of owning management IPC; a runtime with wrapper IPC reacts to disconnect as well. Direct execution with no parent IPC does not acquire this rule. Parent service shutdown awaits/reaps the existing chain and any reserved data operation. This is not a full native-client TCP drain or power-loss durability guarantee.

## Geodata preparation

`scripts/geodata-bootstrap.js` (CLI `scripts/ensure-geodata.js`) downloads the pinned archive only for missing/empty resources, verifies its checksum and stages installation. Region count/required sizes validate an existing directory, not a checksum of every region. Nonempty incomplete geodata is rejected, not overwritten. `npm run geodata` may download/write substantial data without starting gameplay; explicit authorization remains necessary for operations.

## Optional bot MCP process

`scripts/bot-mcp.js` is a separately host-launched SDK stdio bridge, not a runtime launcher. It connects only to the existing loopback management origin; a stopped game or disabled private observer remains unavailable. `[BotControl] enabled` is a Settings-managed, game-restart-required opt-in, while `L2NODE_BOT_CONTROL_TOKEN` belongs only to the private management/bridge environment and is inherited by managed children. No secret is exposed through Settings. See [bot MCP control and observation](bot-mcp.md) for P1–P4 tools, typed issued service offers, separate attachment/lease/idle/result/journal/cursor lifetimes and deployment prerequisites. Bounded read waits are awaited by the private route (max 9s); attachment closure cancels them without cancelling gameplay. Normal game shutdown invalidates manual authority and closes observation subscriptions before persistence cleanup; required native settlement is not a rollback. No MCP operation starts/stops the game.

## Update together

Keep entrypoints, Settings descriptors/runtime adapter, lifecycle IPC, README, [operations](operations.md), [persistence](persistence.md), configuration examples and agent entrypoint guidance synchronized. Syntax/source checks do not establish live readiness, queue suppression, failure recovery, browser behavior or deployment.
