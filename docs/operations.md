# Operations and verification boundaries

Use this as a side-effect guide, not an instruction to run commands automatically. Repository policy remains in [`AGENTS.md`](../AGENTS.md). See [runtime](runtime.md), [WorldObserver management](world-observer.md) and the [project map](README.md).

## Requirements and local setup

- Node.js `>=22.5.0`; persistence uses built-in `node:sqlite`.
- Install dependencies only when setup is requested. `node_modules/` and `package-lock.json` are ignored; syntax checking does not require importing application dependencies.
- The native client must speak Lineage II C4 protocol `656`; WorldObserver is not a replacement game client.
- Defaults/examples live in `config/default.ini`/`config/local.example.ini`; private overrides use ignored `config/local.ini` or the selected override file.
- The unified public management listener uses WorldObserver hostname/port (default loopback 8088). Authentication/game TCP defaults still bind all interfaces. Preserve the intended trusted LAN/firewall boundary; Host/Origin/private-peer checks are not LAN-user authentication or permission for Internet exposure.

## Command side effects

These are existing commands, not checks executed by creating this document.

| Command | Effect and caution |
| --- | --- |
| `npm start` | Starts persistent WorldObserver management and normally opens Settings → Server management. Start gameplay with its separate Start action; Stop keeps the same UI/logs/saves available. |
| `npm run NodeL2` | Standalone geodata/runtime wrapper, not another full management UI. Starts gameplay, which may migrate/write SQLite and restore owned actors. Prefer `npm start` for the unified product. |
| `node scripts/run-simulations.js` | Creates isolated per-instance files as needed and starts management parents on 8181..8183, one origin per instance. Does not start games unless `--start-servers` (or `--restart-servers`) is explicitly selected. `--stop-servers` operates through management; `--count=1..3` and `--no-browser` remain supported. These are runtime operations, not checks. |
| `npm run geodata` | Prepares/checks geodata; may download/install a large archive. Does not start gameplay. |
| `npm run generate:knowledge-base` | Regenerates the five committed `data/KnowledgeBase/` outputs. |
| `npm run check:knowledge-base` | Rebuilds catalogue content in memory and compares outputs; not gameplay verification. |
| `npm run check` | Existing Node `--check` traversal of JavaScript under `src/`, `scripts/`, `tests/`; syntax only, no application startup. |
| `node scripts/profile-spawn-placement.js --output tmp/profiles/<new-run> [--cold] [--cache <file>] [--seed <uint32>]` | Explicit offline territory preparation/CPU profiling. Reads config, datapack and geodata; writes a CPU profile, summary and derived cache under `tmp/`. No database initialization, listeners, world population or game workers. Can consume substantial CPU/RAM; not a routine syntax check. |
| `npm test` | Existing explicitly selected suite; not routinely authorized. |
| `npm run test:geodata` | Prepares geodata before the selected suite, including installation side effects. |
| `npm run load:mixed` | Writes scenario config/database artifacts and starts runtime processes. Legacy load-hook activation is constrained by owned-only policy. |
| `npm run wipe:bots` | Direct destructive `world-wipe.js` call, without management's stopped-state/typed-confirmation guards. Includes owned vassals, not just obsolete ambient bots. |

Simulation runtime/config/database/history/log/save/preset paths remain isolated below `tmp/simulations/<id>/`; shared configuration is loaded before instance overrides. The old separate launcher ports and old `/api/status`, `/api/start`, `/api/stop` requests are removed. Unavailable management is **not** evidence a game has stopped. New generated configs explicitly isolate history as well as world paths. Existing generated configs are preserved, not overwritten: before launch, confirm that any inherited shared `Database.historyPath` does not join instances, and keep customized public ports consistent with the consumer definition. No config/data is silently relocated.

Other scripts can migrate, generate, benchmark or mutate data. Inspect the specific owner and side effects before invoking them; a file's presence is not an operating schedule.

## Offline territory profiling

Use only when profiling is requested; this executes the real preparation algorithm, not an automated test suite. It does not start or stop the game, download geodata, or touch SQLite. Prefer running without competing startup work when comparing timings.

```sh
node scripts/profile-spawn-placement.js --cold --output tmp/profiles/spawns-cold
node scripts/profile-spawn-placement.js --output tmp/profiles/spawns-warm --cache tmp/profiles/spawns-cold/spawn-placement.json
```

Each output directory must be new and below repository `tmp/`. The default cache is inside that output directory; `--cache` explicitly selects another file below `tmp/`. `--cold` bypasses a valid cache and atomically replaces it after preparation. A fixed seed (default `1`) affects only this profiling process, making cold comparisons reproducible while normal gameplay keeps its random source. Do not change geodata or algorithm sources during a run: cache publication is rejected if those inputs change.

`spawn-placement.cpuprofile` is a standard V8 CPU profile, sampled every 10 ms. `summary.json` reports cache hit/miss, territory/unavailable/point counts, preparation elapsed time (including hashing, the fixed-position audit and diagnostic accounting), process CPU usage, memory and top self-time frames. DataCache/geodata initialization happens before profiling; these numbers are not complete server startup time or client acceptance. Compare availability as well as time, since faster rejection is not a successful optimization.

The profiler opts into `SpawnPlacement.init(..., { diagnostics: true })` and writes versioned `diagnostics.json` alongside the summary. Normal startup does not retain the detailed inventory. It includes:

- Definition indices/territory IDs and positive spawn-row mappings; shared pool keys, referencing definitions, declared slots, unique XY cells, XYZ extent (XY bounds and distinct Z values) and per-attempt sampling/search counters. Fixed slots are `total * coords.length`, not the sum of row totals or unique XYZ count.
- Authored root sources/coordinates, normalized surfaces and rejection reasons. `included: true` means the root was considered, not necessarily accepted. Non-random definitions' anchors are currently reported as `fixed_only_root_excluded`, without admitting them; this exposes the existing root-collection gap.
- Unique positive-count fixed monster coordinates, all definition/row/coordinate references, local failures and height-error buckets. Fixed `global: not_prepared` explicitly means that neither local success nor a warm random-pool cache certifies global fixed accessibility.
- Empty/one-cell-multiple-slot/underfilled-pool adequacy flags. Even an unflagged pool stays `unreviewed`; extents and counts do not establish the intended playable area/floor. An underfilled pool is a review signal, not a universal points-to-slots requirement.

`sampling_miss_or_absence` describes a bounded sample, never exhaustive absence; `surface_unavailable` combines absent, malformed and obstacle-masked data. `root_unavailable` means no admitted nearby root was considered in that attempt; `connectivity_unknown` is not proof that no route exists. Cached empty pools report `cached_unresolved` because the current cache does not retain failure provenance. `pathNodeAllowance` is an upper bound reserved by search requests (`20,001` per call, including the native stopping iteration), not measured expansions. Direct-walk counters cover build calls only, excluding internal route validation and the fixed local audit. Warm preparation counters are zero; fixed global proofs remain unprepared. `enforcedLimits` distinguishes current fast-path bounds from the still-unimplemented deterministic/global budgets and fixed-proof cache. These diagnostics do not change admission, content, minion placement or runtime cache format.

## Persistent management and settings

Use `/observer/settings/server` at the single public origin. Full controls cover status/readiness/PID/uptime/last exit and cleanup, Start/Stop, Open map/full log, bounded output, explicit inference, named saves and typed-scope wipes. There is no separate old launcher page/listener, Restart/force-stop button or compatibility route.

Settings tab Save, the preset form and management actions are independent. Saved next-start values are not running values. Restart-only settings and saved-but-unapplied live changes require an explicit **Stop → wait for confirmed exit → Start**; saving never starts/restarts anything. Management hostname/port are externally restarted settings, not in-page Stop targets. See [runtime precedence, numeric bounds and pending recovery](runtime.md).

Start/Stop/save/load/delete/wipe reserve a single operation before awaits. Conflicts report busy; data mutations require confirmed fully stopped descendants and cross-process DB locks. An HTTP disconnect/timeout is not cancellation; inspect current/last operation outcome before another explicit attempt. No automatic destructive retry is offered. A wrapper exit without descendant confirmation stays unknown/error and blocks conflicting operations; investigate through the actual service owner rather than deleting locks or adopting unrelated processes.

Inference test sends one bounded synthetic request only on demand; loading Settings/saving config performs no provider requests. Sanitized results exclude keys, raw provider payloads and token-bearing URL paths. Connectivity is not gameplay-AI acceptance.

## Saved games and restore

Owners: `src/WorldObserver/ManagementController.js`, `scripts/saved-games.js`, `src/DatabaseRestore.js`, `scripts/database-access.js`.

1. Management permits create/load/delete only with the game fully stopped and exclusive operation ownership.
2. Saves contain a validated world DB, optional paired history DB and `save.json` metadata. Configuration and preset JSON are **excluded**.
3. Creation checkpoints stopped databases, copies through a pending directory, validates the pair and records digests before publishing.
4. Load validates copies and uses the existing paired restore/recovery protocol to replace current world/history; the game remains stopped.
5. Load creates **no automatic pre-load backup**. Delete permanently removes the selected save; UI confirmations remain mandatory.

Paths remain `tmp/saves`, or `saves` under `L2NODE_RUNTIME_DIR`; existing save discovery/format and configured world/history paths are retained. Application saves are not agent-created persistent backups, which belong only under `/data/!backups/L2Siege/`.

The persistent `<database>.access.sqlite` file defines the shared access-lock domain. Never unlink it to bypass busy: different processes could then hold different locks. Preserve restore markers/pending files for the recovery owner, not manual deletion.

## Wipes and history

`world-wipe.js` selects bots by `bot_` account prefix and players by its complement. It removes related character/clan/trade state, including player-owned vassals in bot scope. Active mixed bot/player trades can block partial wipe. Management requires exact WIPE BOTS / WIPE PLAYERS / WIPE ALL and a fully stopped/exclusive game.

World deletion commits **before** history cleanup. A committed outbox instruction permits later recovery; a history error does not mean deletion rolled back. Both immediate response and retained operation failure warn about this. The parent passes the same resolved world/history path snapshot protected by its world access lock into `WorldWipe.wipe`; history cleanup does not re-read a different config after world commit. SQL/outbox cleanup and standalone CLI selection remain owned by the existing wipe module. See [persistence](persistence.md). Prefer the guarded Server management flow; do not assume the standalone wipe CLI acquires the server's lock or has a dry run.

## Separately authorized acceptance/deployment

Code/docs and source/syntax checks do not authorize deployment. Before stop-and-replace cutover, confirm the actual service/start owner and trusted public binding; no live service configuration was inferred from defaults. Back up only threatened unique override/preset/service state under `/data/!backups/L2Siege/`, with restricted permissions and safe readability/parse checks. No database migration/new save format is required by UI consolidation.

Runtime acceptance remains separate: management assets without a DB; stopped reloads; required-listener and disabled-observer readiness; private endpoint/generation isolation and parent loss/deadlines; proxy ETag/204/compression/dynamic resources; LAN teleport denial; live/restart/stale/invalid/overflow/storage-error settings; AI queued dispatch suppression; navigation/drafts/themes/keyboard/narrow view; preset next-start behavior; log fallback; and explicitly authorized synthetic inference. Save/load/delete/wipe checks require disposable or separately protected consistent world/history data. Do not restore over newer personal state, probe destructive behavior on the live world, or describe source checks as runtime passes.

## Documentation and code checks

- Validate changed claims/paths/relative links; inspect final diff and `git diff --check`. JavaScript changes require `npm run check`, syntax only.
- Do not add/modify automated tests/test infrastructure or run suites by default. `tests/test_launcher_progression_memory.js` still assumes `/api/*`, `L2NODE_LAUNCHER_PORT`, old inline HTML and status shape. `tests/test_multi_launcher_isolation.js` still assumes separate launcher/observer ports and old URL/status fields. `tests/test_saved_games.js` and `tests/test_world_wipe.js` also contain old launcher API/HTML assumptions. These tests were not migrated or run; those assumptions are obsolete, not a reason to retain compatibility. Other legacy gateway tests may explicitly override enabled/model snapshots, now subordinate to the dispatch-time policy gate.
- No build/start/stop/restart is an incidental documentation, Git or syntax-check side effect. Independent review, runtime acceptance and deployment are distinct activities.

## Update together

Keep command effects, source/preset ownership, simulation consumers, operation locks, save/wipe failure semantics, README, [runtime](runtime.md), [persistence](persistence.md) and `AGENTS.md` synchronized. Do not turn historical tests or a successful parser check into evidence of runtime acceptance.
