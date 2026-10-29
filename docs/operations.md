# Operations and verification boundaries

Use this as a side-effect guide, not an instruction to run commands automatically. Repository policy remains in [`AGENTS.md`](../AGENTS.md). See [runtime](runtime.md), [WorldObserver management](world-observer.md) and the [project map](README.md).

## Requirements and local setup

- Node.js `>=22.5.0`; persistence uses built-in `node:sqlite`.
- Install dependencies only when setup is requested. `node_modules/` and `package-lock.json` are ignored; syntax checking does not require importing application dependencies.
- The native client must speak Lineage II C4 protocol `656`; WorldObserver is not a replacement game client.
- Defaults/examples live in `config/default.ini`/`config/local.example.ini`; private overrides use ignored `config/local.ini` or the selected override file.
- The API-only management listener uses WorldObserver hostname/port (default loopback 8088), not the browser origin. A configured `publicOrigin` requires `hostname=127.0.0.1`; it enables only the selected same-host proxy contract. Browser sources are in `src/frontend/public/`, with Nginx/Docker/Compose packaging in `src/frontend/`. Do not treat source readiness or a new parent start as a working UI deployment; see [frontend inputs and independent commands](world-observer.md#frontend-configuration-and-independent-operations). Authentication/game TCP defaults still bind all interfaces. Host/Origin/private-peer checks and personal-key sessions are not permission for Internet exposure.

## Command side effects

These are existing commands, not checks executed by creating this document.

| Command | Effect and caution |
| --- | --- |
| `npm start` | Starts persistent WorldObserver management APIs, never browser-page delivery. Opens Settings at `publicOrigin` only when configured (unless `L2NODE_NO_BROWSER=1`); does not check frontend availability. Start gameplay with the separate Start action once the frontend is deployed; Stop keeps management APIs/logs/saves available. |
| `npm run observer:key -- "User name"` | Creates a named full-admin observer key in the runtime's separate auth SQLite and prints the raw key once. No server startup, restart or world database access. Names must be unique; keep the key private. |
| `npm run NodeL2` | Standalone geodata/runtime wrapper, not another full management UI. Starts gameplay, which may migrate/write SQLite and restore owned actors. Prefer `npm start` for the unified product. |
| `node scripts/run-simulations.js` | Creates isolated per-instance files as needed and starts management parents on 8181..8183, one origin per instance. Does not start games unless `--start-servers` (or `--restart-servers`) is explicitly selected. `--stop-servers` operates through management; `--count=1..3` and `--no-browser` remain supported. Lifecycle flags require `L2NODE_OBSERVER_KEY_<managementPort>` (for example `L2NODE_OBSERVER_KEY_8181`), or the fallback `L2NODE_OBSERVER_KEY`; the script logs in and reuses a session cookie. These are runtime operations, not checks. |
| `npm run geodata` | Prepares/checks geodata; may download/install a large archive. Does not start gameplay. |
| `npm run generate:knowledge-base` | Regenerates the five committed `data/KnowledgeBase/` outputs. |
| `npm run check:knowledge-base` | Rebuilds catalogue content in memory and compares outputs; not gameplay verification. |
| `npm run check` | Existing Node `--check` traversal of JavaScript under `src/`, `scripts/`, `tests/`; syntax only, no application startup. |
| `docker compose -f src/frontend/compose.yaml config --quiet` | Renders/checks Compose inputs only; all four `L2KINGDOM_*` inputs are required. Add `-f src/frontend/compose.dev.yaml` to inspect the read-only source-mount alternative. No build/start. |
| `docker compose -f src/frontend/compose.yaml build frontend` | Separately authorized frontend-only image build; may download the pinned Nginx base. No backend dependency install/build or management/game restart. |
| `docker compose -f src/frontend/compose.yaml up -d --no-deps --no-build --pull never --force-recreate frontend` | Separately authorized replacement of container `l2kingdom_frontend` only, using the built image. Requires agreed LAN/backend inputs and initial cutover; no broad Compose shutdown. |
| `node scripts/profile-spawn-placement.js --output tmp/profiles/<new-run> [--cold] [--cache <file>] [--seed <uint32>]` | Explicit offline territory preparation/CPU profiling. Reads config, datapack and geodata; writes a CPU profile, summary and derived cache under `tmp/`. No database initialization, listeners, world population or game workers. Can consume substantial CPU/RAM; not a routine syntax check. |
| `npm test` | Existing explicitly selected suite; not routinely authorized. |
| `npm run test:geodata` | Prepares geodata before the selected suite, including installation side effects. |
| `npm run load:mixed` | Writes scenario config/database artifacts and starts runtime processes. Legacy load-hook activation is constrained by owned-only policy. |
| `npm run wipe:bots` | Direct destructive `world-wipe.js` call, without management's stopped-state/typed-confirmation guards. Includes owned vassals, not just obsolete ambient bots. |

Simulation runtime/config/database/history/log/save/preset paths remain isolated below `tmp/simulations/<id>/`; shared configuration is loaded before instance overrides. The old separate launcher ports and old `/api/status`, `/api/start`, `/api/stop` requests are removed. Unavailable management is **not** evidence a game has stopped. New generated configs explicitly isolate history as well as world paths. Existing generated configs are preserved, not overwritten: before launch, confirm that any inherited shared `Database.historyPath` does not join instances, and keep customized public ports consistent with the consumer definition. No config/data is silently relocated.

Observer keys and sessions are isolated per runtime in `observer-auth/auth.sqlite` and are not part of game saves. Generate an instance's key with, for example, `L2NODE_RUNTIME_DIR=tmp/simulations/simulation-1 npm run observer:key -- "Administrator"`; use the corresponding key in that instance's browser or lifecycle-script environment. Do not place raw keys in configuration, shell command arguments, docs or committed files. The existing HTTP transport is unencrypted; keep the trusted-network restriction. See [observer authentication](world-observer.md#personal-keys-and-browser-sessions).

Other scripts can migrate, generate, benchmark or mutate data. Inspect the specific owner and side effects before invoking them; a file's presence is not an operating schedule.

## Frontend unavailable after a game restart

- Settings **Stop → Start** replaces only the gameplay wrapper/child. It neither reloads management's HTTP code nor builds/starts the Nginx frontend. Inspect the actual parent PID/binding and `docker ps --filter name=l2kingdom_frontend` rather than repeating game restarts.
- Management is API-only; a document 404 at its loopback address is expected, not a fallback UI. A 404 from `/observer/api/auth/session` instead indicates an older management process or wrong endpoint. A new unauthenticated auth endpoint returns JSON 401.
- Initial separation requires an authorized clean game stop, backup of affected private configuration, loopback management/publicOrigin configuration, management replacement and independent frontend deployment. Verify clean shutdown before replacement; never infer it from a disconnected UI. Use the owner's existing management launch environment, including any MCP secret; do not install a new supervisor or change ports unnecessarily.
- For Compose, provide the selected local environment file explicitly when values are not exported: `docker compose --env-file <local-env-file> -f src/frontend/compose.yaml config --quiet`, then use that same option for the independently authorized `build frontend` and `up ... frontend` commands above. Listener, client CIDR and backend port must agree with the actual deployment. Do not commit private inputs or credentials.
- Once deployed, later UI-only replacements operate on service `frontend` only. Check the same session and continued backend/game uptime; do not restart management/game merely to refresh pages.

## Offline territory profiling

Use only when profiling is requested; this executes the real preparation algorithm, not an automated test suite. It does not start or stop the game, download geodata, or touch SQLite. Prefer running without competing startup work when comparing timings.

```sh
node scripts/profile-spawn-placement.js --cold --output tmp/profiles/spawns-cold
node scripts/profile-spawn-placement.js --output tmp/profiles/spawns-warm --cache tmp/profiles/spawns-cold/spawn-placement.json
```

Each output directory must be new and below repository `tmp/`. The default cache is inside that output directory; `--cache` explicitly selects another file below `tmp/`. `--cold` bypasses a valid cache and atomically replaces it after preparation. A fixed seed (default `1`) affects only this profiling process, making cold comparisons reproducible while normal gameplay keeps its random source. Do not change geodata or algorithm sources during a run: cache publication is rejected if those inputs change.

`spawn-placement.cpuprofile` is a standard V8 CPU profile, sampled every 10 ms. `summary.json` reports cache hit/miss, territory/unavailable/point counts, `workWindows`, preparation elapsed time (including hashing, the fixed-position audit and diagnostic accounting), process CPU usage, memory and top self-time frames. DataCache/geodata initialization happens before profiling; these numbers are not complete server startup time or client acceptance. Compare availability as well as time, since faster rejection is not a successful optimization.

The profiler opts into `SpawnPlacement.init(..., { diagnostics: true })` and writes versioned `diagnostics.json` alongside the summary. Normal startup does not retain the detailed inventory. It includes:

- Definition indices/territory IDs and positive spawn-row mappings; shared pool keys, referencing definitions, declared slots, unique XY cells, XYZ extent (XY bounds and distinct Z values) and per-attempt sampling/search counters. Fixed slots are `total * coords.length`, not the sum of row totals or unique XYZ count.
- Authored root sources/coordinates, normalized surfaces and rejection reasons. `included: true` means considered, not necessarily accepted. Anchors from fixed-only/inactive definitions are admitted through the same support audit as other authored roots; `fixedOnlyAnchorsExcluded` is zero.
- Unique positive-count fixed monster coordinates, all definition/row/coordinate references, local failures/height-error buckets and cached global proof state/witness. Coalescing a global target by normalized cell/layer never removes authored-coordinate audits or reference counts. `invalid`, global `unknown` and `localUnknown` (budget-limited local audit) are distinct.
- Empty/one-cell-multiple-slot/underfilled/extent/budget adequacy flags. Automatic admission requires `min(128, shared declared random slots)` unique XY cells and 25% of each bounding-box axis spanning at least 256 units. Flagged pools are not used at runtime; an unflagged pool meets this mechanical rule, not a client/encounter-floor review. There is no implicit small-area override.
- Deterministic discovery completion, tested bounding-box cells and admissible layer observations. Observations include repeated discovery and are not a count of unique cells. `inventoryComplete: false` and null denominators expose capacity/early-inventory blockers instead of certifying truncated input.

Diagnostic/cache version 2 retains failure provenance on warm reuse. `sampling_miss_or_absence` describes incomplete discovery, never exhaustive absence; only completed cell-centre enumeration with all in-polygon cells decoded and no admissible layer permits `no_layer_in_z_interval`. An empty decode (including missing/malformed/obstacle-masked data) prevents that absence claim and retains `surface_unavailable`. `surface_unavailable` combines absent, malformed and obstacle-masked data. `root_unavailable` means no nearby admitted proof was considered; `connectivity_unknown` and `budget_exhausted` are not proofs that no route exists. Partial discovery, inadequate pools and unknown fixed proofs cannot satisfy offline acceptance.

Preparation enforces these non-configurable limits. Time/RSS and capacity limits apply to the whole preparation; aggregate work quotas apply to renewable windows. A quota boundary retains the current proof/scanner stack and starts a new work window, so earlier definitions cannot consume the only opportunity to prepare later territories. Target counters do not reset on window renewal, retry, queue wake or discovery batch:

| Work | Whole preparation / renewable work window | One random shared pool / fixed normalized-cell target |
| --- | ---: | ---: |
| Elapsed time | 900,000 ms wall for the whole preparation, including identity/cache work | 90,000 ms active work |
| Observed process RSS | 3,072 MiB hard stop for the whole preparation | Shared process limit |
| Native searches | 4,096 | 24 (initial random allowance 12) |
| Reserved node expansions | 16,000,000 | 300,000 |
| Strict walks / cardinal transitions | 250,000 / 64,000,000 | 4,096 / 1,000,000 |
| Decoded layers | 16,000,000 | 1,000,000 |
| Deterministic bounding-box cells | 2,000,000 | 262,144 |

The search, node, walk, transition, layer and deterministic-cell numbers above are per work window, not total-work ceilings. `work` counters remain cumulative across windows, with `work.windows` reporting their count; `enforcedLimits.renewableWorkWindows` is true and `globalWorkBudget` is false. A hard global blocker or incomplete inventory rejects runtime world initialization before NPC publication; the offline profiler still returns diagnostic evidence. Per-target unknown/limited results remain explicitly reported, not certified as inaccessible. Native-search/node exhaustion disables only A*: later selected direct witnesses and discovery can continue within the unchanged walk/layer/time limits. Direct entry witnesses are tried before native routes. Already sufficient strict points survive an optional later target-work stop; a hard global blocker still rejects initialization.

Fixed global witnesses are diagnostic and do not gate authored fixed NPC placement. Their native searches additionally share a non-renewable `fixedNodeAllowance` of 16,000,000 reserved expansions across the whole preparation (`work.fixedPathNodeAllowance`), leaving random retry work independent of that diagnostic workload. Exhaustion disables further fixed A* and records `budget_exhausted` with `limit: fixed:pathNodeAllowance` on unresolved fixed witnesses, not a global blocker or a successful proof. Their direct checks and relevant-proof wakes remain eligible while other target limits permit; a later successful direct proof clears that witness's failure reason/limit. Fixed connectivity additionally admits at most 262,144 memo entries over the whole preparation (`enforcedLimits.fixedPairAllowance`), without renewal when completed targets release their history. Reaching that allowance or needing to reclaim fixed history for random work disables further fixed connectivity, releases its history and leaves unfinished witnesses unknown; subsequently stopped fixed targets record `budget_exhausted` with `limit: fixed:capacity:pairs`. This is not a global blocker or a successful proof. Fixed local audits remain complete unless a hard limit stops preparation. Fixed targets enter the proof index/queue after random fast attempts, so they do not displace the first random retries.

A strict walk permits at most 8,192 cardinal transitions. Synchronous batch checkpoints retain scanner/walk/route-validation state, poll time/RSS and reset only batch counters: at most 4,096 tested XY cells and 65,536 decoded layers, with 4,096 resident candidate points per pool window. The decoder reserves room for 255 layers before reading a cell. Fixed local audits charge global work separately from grouped global targets. Native `findPath()` receives the existing budget callback; strict validation of its returned route uses the same context. No general pathfinder change or runtime per-actor search is introduced.

Capacity guards precede insertion: 8,192 loaded definitions, 4,096 random shared keys, 32,768 unique fixed XYZ, 65,536 fixed-coordinate references, 16,384 selected trusted points, 262,144 coarse-index memberships and 262,144 resident source/target attempt pairs shared by random/fixed work. Pair history is owned by each target and released only after the target is proven/sufficient, stopped or exhaustively has no candidate layers; such targets cannot wake again. Unresolved random history is never evicted to repeat unchanged failures. At the shared pair cap, fixed connectivity is disabled before its history is reclaimed; random work can use the freed space. If unresolved random history alone needs more than the cap, `capacity:pairs` remains a hard global blocker. The queue holds at most one pending entry per random/fixed target. `work.rememberedPairs` and `rememberedPairsByKind` report resident entries, `peakRememberedPairs` the combined high-water mark, `pairAdmissions` cumulative entries by kind, and `fixedPairLimitReached` whether fixed pair work was disabled. Normal startup logs also report the pair high-water mark, cumulative admissions by kind and the fixed-limit flag. Cache input/output is limited to 64 MiB, with bounded tables, integer packed XYZ, fixed state/witness consistency and exact definition/reference coverage validation before reuse/publication.

`pathNodeAllowance` reserves `20,001` expansions per request, including the native stopping iteration; it is not measured expansions. `strictWalkCalls` includes internal route validation and local audits; `directWalkCalls` remains the explicit connectivity-call subset. `skippedPathSearchRequests` counts disabled A* attempts without reserving nodes, `directProofsAfterSearchLimit` counts successful explicit direct checks after that target recorded A* exhaustion, and `retentionSkippedCandidates` counts full-pool candidates pruned before connectivity work. Deterministic prefixes interleave spatial tiles rather than scanning one narrow strip; only real bounding-box cells are charged, and completed no-candidate discovery is not woken by new connectivity alone. Decoded-layer accounting covers the strict surface reader; native search work is separately bounded by its reserved node allowance. Warm reuse has zero connectivity searches/walks and no fixed local audit, while root normalization and content hashing still run. Unknown cache rows remain unknown. `enforcedLimits` and explicit blocker/target-limit fields describe enforcement, not evidence that full-world coverage fits these budgets.

Full-world cold/warm coverage and real-client acceptance remain separate operations; a bounded subset is not a publishable runtime cache. Before separately authorized cache publication, establish the effective runtime/geodata paths, complete accepted offline coverage with matching final fingerprint, and stop the game through management. Use a same-directory temporary file and atomic replacement of the effective runtime cache only with publication authorization; do not overwrite an active cache as a profiling side effect. A subsequent authorized Start must actually report a v2 random/fixed cache hit within the existing complete-startup deadline. A cache miss is a blocker, not permission to extend that deadline.

## Persistent management and settings

Once the separate frontend is deployed, use `/observer/settings/server` at its single browser origin (`publicOrigin`), not at the loopback management binding. The backend-only separation step does not include that frontend artifact or authorize service changes. Full controls cover status/readiness/PID/uptime/last exit and cleanup, Start/Stop, Open map/full log, bounded output, explicit inference, named saves and typed-scope wipes. There is no separate old launcher page/listener, Restart/force-stop button or compatibility route.

Settings tab Save, the preset form and management actions are independent. Saved next-start values are not running values. Restart-only settings and saved-but-unapplied live changes require an explicit **Stop → wait for confirmed exit → Start**; saving never starts/restarts anything. Management hostname/port are externally restarted settings, not in-page Stop targets. See [runtime precedence, numeric bounds and pending recovery](runtime.md).

Start/Stop/save/load/delete/wipe reserve a single operation before awaits. Conflicts report busy; data mutations require confirmed fully stopped descendants and cross-process DB locks. An HTTP disconnect/timeout is not cancellation; inspect current/last operation outcome before another explicit attempt. No automatic destructive retry is offered. A wrapper exit without descendant confirmation stays unknown/error and blocks conflicting operations; investigate through the actual service owner rather than deleting locks or adopting unrelated processes.

Inference test sends one bounded synthetic request only on demand; loading Settings/saving config performs no provider requests. Sanitized results exclude keys, raw provider payloads and token-bearing URL paths. Connectivity is not gameplay-AI acceptance.

## Saved games and restore

Owners: `src/WorldObserver/ManagementController.js`, `scripts/saved-games.js`, `src/DatabaseRestore.js`, `scripts/database-access.js`.

1. Management permits create/load/delete only with the game fully stopped and exclusive operation ownership.
2. Saves contain a validated world DB, optional paired history DB and `save.json` metadata. Configuration and preset JSON are **excluded**.
3. Creation checkpoints stopped databases, copies through a pending directory, validates the pair and records digests before publishing.
4. Before invoking load, management clears all game-account associations from the separate observer auth database and invalidates outstanding verification replies. Keys/sessions are retained; links stay cleared even if loading fails. Load then validates copies and uses the existing paired restore/recovery protocol to replace current world/history; the game remains stopped.
5. Load creates **no automatic pre-load backup**. Delete permanently removes the selected save; UI confirmations remain mandatory.

Paths remain `tmp/saves`, or `saves` under `L2NODE_RUNTIME_DIR`; existing save discovery/format and configured world/history paths are retained. Application saves are not agent-created persistent backups, which belong only under `/data/!backups/L2Kingdom/`.

The persistent `<database>.access.sqlite` file defines the shared access-lock domain. Never unlink it to bypass busy: different processes could then hold different locks. Preserve restore markers/pending files for the recovery owner, not manual deletion.

## Wipes and history

`world-wipe.js` selects bots by `bot_` account prefix and players by its complement. It removes related character/clan/trade state, including player-owned vassals in bot scope. Active mixed bot/player trades can block partial wipe. Management requires exact WIPE BOTS / WIPE PLAYERS / WIPE ALL and a fully stopped/exclusive game.

Before invoking a managed wipe, management clears game-account associations in that account scope (`bot_` / non-`bot_` / all) and invalidates outstanding verification replies. Keys/sessions remain. This conservative clearing is not rolled back if deletion/history cleanup fails. Standalone wipe tools and out-of-band database replacement do not coordinate observer auth: stop management, clear affected rows from `observer_game_accounts` in its runtime-local `observer-auth/auth.sqlite`, then relink after restarting the intended world, before dashboard access. Never copy old links back merely because account names match.

World deletion commits **before** history cleanup. A committed outbox instruction permits later recovery; a history error does not mean deletion rolled back. Both immediate response and retained operation failure warn about this. The parent passes the same resolved world/history path snapshot protected by its world access lock into `WorldWipe.wipe`; history cleanup does not re-read a different config after world commit. SQL/outbox cleanup and standalone CLI selection remain owned by the existing wipe module. See [persistence](persistence.md). Prefer the guarded Server management flow; do not assume the standalone wipe CLI acquires the server's lock or has a dry run.

## Separately authorized acceptance/deployment

Code/docs and source/syntax checks do not authorize deployment. Before stop-and-replace cutover, confirm the actual service/start owner and trusted public binding; no live service configuration was inferred from defaults. Back up only threatened unique override/preset/service state under `/data/!backups/L2Kingdom/`, with restricted permissions and safe readability/parse checks. The original UI consolidation requires no world migration/new save format. Game-account linking separately creates its association table in the existing observer auth database on the next management start; it does not migrate world data.

Runtime acceptance remains separate: management assets without a DB; stopped reloads; required-listener and disabled-observer readiness; private endpoint/generation isolation and parent loss/deadlines; proxy ETag/204/compression/dynamic resources; LAN teleport denial; live/restart/stale/invalid/overflow/storage-error settings; AI queued dispatch suppression; navigation/drafts/themes/keyboard/narrow view; preset next-start behavior; log fallback; and explicitly authorized synthetic inference. Save/load/delete/wipe checks require disposable or separately protected consistent world/history data. Do not restore over newer personal state, probe destructive behavior on the live world, or describe source checks as runtime passes.

## Documentation and code checks

- Validate changed claims/paths/relative links; inspect final diff and `git diff --check`. JavaScript changes require `npm run check`, syntax only.
- Do not add/modify automated tests/test infrastructure or run suites by default. `tests/test_launcher_progression_memory.js` still assumes `/api/*`, `L2NODE_LAUNCHER_PORT`, old inline HTML and status shape. `tests/test_multi_launcher_isolation.js` still assumes separate launcher/observer ports and old URL/status fields. `tests/test_saved_games.js` and `tests/test_world_wipe.js` also contain old launcher API/HTML assumptions. These tests were not migrated or run; those assumptions are obsolete, not a reason to retain compatibility. Other legacy gateway tests may explicitly override enabled/model snapshots, now subordinate to the dispatch-time policy gate.
- No build/start/stop/restart is an incidental documentation, Git or syntax-check side effect. Independent review, runtime acceptance and deployment are distinct activities.

## One-commit upstream updates

Use the canonical [upstream-integrator skill](../skills/l2kingdom-upstream-integrator/SKILL.md) for incremental L2Solo and Mobius C4 updates, with one active proposal per source. It explains one exact commit's purpose, local compatibility, expected behavior, dependencies, performance impact and verification limits, then waits for user approval. L2Solo changes may be integrated as native patches; Mobius changes require native adaptations, not a Java subtree merge or rebase.

Separate source sessions may discover/analyze concurrently and implement disjoint file scopes with compatible contracts. Each source owns its progress and declares write paths; overlapping files/contracts wait for coordination and revalidation. A shared cooperative publication claim serializes stage/commit/integration/push operations. Existing sessions must adopt the protocol before concurrent implementation in one checkout; separate checkouts still require semantic conflict checks and an agreed shared progress root. These are agent instructions, not automatic locking or permission enforcement.

Invoke `/skill:l2kingdom-upstream-integrator next l2solo` or `next mobius-c4`; use `status` to resume and `refresh <source>` to discover new source tips. Each approval applies only to its saved proposal. After successful publication or an explicit skip/defer, the agent records the result and immediately prepares the next unreviewed commit's proposal in the same pinned source queue. It waits for separate approval before each integration and pauses on a blocker, an exhausted queue or a user request; source refresh/switching is not automatic.

Progress lives in ignored `tmp/upstream-integration/sources/<source>/state.md` and per-commit receipts; source/publication claims live under `tmp/upstream-integration/locks/`. The old combined `tmp/upstream-integration/state.md` remains a legacy recovery input: split only the selected source without overwriting another active session or changing saved decisions. Progress persists between local sessions, but is not pushed with Git and is lost if those files are deleted. Integration commit trailers retain source provenance, not skipped decisions. Read the skill's [record contract](../skills/l2kingdom-upstream-integrator/references/records.md) for ownership and recovery. Root restrictions on tests, runtime operations, backups and scoped commits still apply; a pushed code change is not evidence of live activation.

Local discovery follows the existing skill convention: `~/.agents/skills/l2kingdom-upstream-integrator` links to `skills/l2kingdom-upstream-integrator/`. Run `/reload` in Pi after installation. The skill is an instruction workflow, not an executable approval guard or background updater.

## Update together

Keep command effects, source/preset ownership, simulation consumers, operation locks, save/wipe failure semantics, README, [runtime](runtime.md), [persistence](persistence.md) and `AGENTS.md` synchronized. Do not turn historical tests or a successful parser check into evidence of runtime acceptance.
