# SQLite, write ownership and durability

Read this before changing database writes, snapshots, worker handoffs or recovery. See the [project map](README.md), [economy contracts](economy.md) and [save operations](operations.md).

## Owners and schema sources

| Owner | Responsibility |
| --- | --- |
| `src/Database.js` | Main world connection, serialized application writes, transactions, migrations and native operation APIs. |
| `src/DatabaseStatements.js` | Bounded connection-local prepared-statement cache. |
| `src/GameServer/Persistence/CharacterWriteQueue.js` | Coalesced character/item patches and flush barriers. |
| `src/HistoryDatabase.js`, `src/HistoryWorker.js`, `src/HistoryStore.js` | Separate history database, outbox transfer, reads and retention. |
| `src/DatabaseCheckpointCoordinator.js`, `src/DatabaseCheckpointWorker.js` | Background WAL checkpoint work. |
| `src/DatabaseRestore.js` | Interrupted paired world/history replacement recovery. |
| `scripts/database-access.js`, `scripts/saved-games.js` | Cross-process access lock and stopped-database saves. |
| `src/WorldObserver/ObserverAuthStore.js` | Separate runtime-local `observer-auth/auth.sqlite`: named admin-key hashes, expiring session-token hashes and one-to-one game-account associations; no game passwords or world/history save content. |

`database/sql/sqlite.sql` is the SQLite bootstrap, but **not the complete evolved schema**. `Database.applySchemaMigrations` adds migrations transactionally with their receipts. Account warehouses additionally use `src/DatabasePlayerWarehouse.js`; Lord/vassal tables and capacity triggers use `src/GameServer/Lord/Repository.js`. `database/sql/database.sql` is legacy MySQL material, not the running SQLite bootstrap.

`Database.init` recovers an interrupted restore before opening the current files. `src/NodeL2.js` also performs data-dependent startup maintenance. Reading a schema file does not establish the state of a deployed world.

## Observer game-account associations

`ObserverAuthStore` creates `observer_game_accounts` in the existing auth database when the auth store opens, including management startup (no world-schema migration). Rows contain the frontend `key_hash`, canonical `account_name`, random UUID `revision` and `linked_at` milliseconds. A non-null primary key permits one association per key; `account_name COLLATE NOCASE UNIQUE` arbitrates claims across principals/connections. The key foreign key uses `ON DELETE CASCADE`. No submitted game password or reusable password equivalent is stored here.

`GameAccountService` asks the game-owned `Database.fetchUserPassword` to verify an existing account over bounded generation-bound IPC, without auto-creation/session login. Only afterward does a short `BEGIN IMMEDIATE` transaction recheck the expected link revision and replace the association. Failed credential checks, stale revisions and uniqueness conflicts preserve the previous row. Unlink cancels pending verification's commit permission; every successful link/replace receives a fresh revision, including the same account after unlink. Logout/password change does not revoke the durable association.

Auth data is excluded from world/history saves. Before managed load, clear all associations; before managed wipe, clear the affected `bot_`/non-`bot_`/all account scope. This conservative invalidation remains even if the world operation fails, and an in-memory epoch fences outstanding verification replies. Keys/sessions are untouched. Out-of-band replacement and standalone destructive tools require explicit clearing/relinking before dashboard access; name equality is not durable account identity. See the [HTTP/IPC contract](world-observer.md#game-account-linking-and-dashboard-transport-p1) and [operations](operations.md#saved-games-and-restore).

## Producer → write queue → world state

- `Database.enqueue` serializes synchronous `node:sqlite` work through the main query chain. Transaction helpers own commit/rollback.
- Position, experience and selected backpack mutations feed `CharacterWriteQueue`; it coalesces patches on a 750-ms delay rather than persisting every field change immediately.
- Failed patch snapshots merge back under newer pending values, so an older retry does not overwrite newer fields.
- `Database.applyBufferedCharacterStates` commits buffered batches. `withCharacterFlush` orders dependent native operations after relevant pending state.
- Inventory/service transactions also write directly through `Database`; the character queue is not the sole write producer.
- Live memory may change before a buffered write commits. A visible inventory or location change is not proof of immediate durability.

Owned vassals have an additional lifecycle snapshot path: `PopulationService.persistOwnedActors` queues location/experience, flushes character state, saves status and marks lifecycle state hot. Owned-only startup schedules this every 30 seconds, with one shared in-flight pass over the starting roster. Local elapsed-time checkpoints yield through `setImmediate` after a soft 2-ms slice, accounting for preparation, flush and status/lifecycle work. A synchronous operation remains non-preemptible; Promise-only awaits are not timer yields. The producer does not yield between status capture and database handoff, avoiding a newer buffered vitals update being flushed and then overwritten by a pre-yield status. This deliberately does not use `Database.cooperatively`, whose process-global budget can be inherited from another scope. No transaction batching or change to the ordinary 750-ms queue/direct-write failure barriers is introduced.

Owned lifecycle `statsJson.vassalState` stores sitting/standing posture, heading, recovery mode and completed service-duty waiting with the order revision; no schema migration is needed. Character coordinates remain the startup location source. `BotManager` restores this metadata before publication only when its revision still matches the duty; legacy rows without it retain normal duty initialization. Full routes, combat targets and party membership are not restored by this metadata.

After asynchronous boundaries, later actor work requires the same session actor and current vassal registry membership. Write failures propagate without claiming lifecycle success; lifecycle cache/notifications still belong to `BotLifeState.markHot`. `PopulationService.stop` closes periodic admission, clears its trigger and awaits the admitted pass, cold/local stop and the optional quiescence hook before a fresh final owned-actor pass. All admitted drains settle even when one rejects; a failed drain prevents final capture and rejects to the shutdown owner. Repeated stop calls share that drain and start cannot reopen admission while it is pending. NodeL2 supplies `GameplayShutdown.quiesce` to stop native producers and await accepted async mutations/teleport publication before final capture; a failed quiescence cannot proceed to a nominally clean flush/close.

Connected online real players have a separate final path in `GameplayShutdown.persistPlayers`: flush their buffered patches, recheck the current registered actor and directly await `Database.updateCharacterStatus(CharacterStatus.persistenceRecord(actor))`. HP/MP/CP, persistent effects and cooldowns are therefore captured even without a client disconnect; failure marks shutdown failed instead of being swallowed by the ordinary disconnect helper. Ephemeral actors and bots are excluded from this player pass. Final pet state is also awaited during quiescence without unsummoning pets or retiring their owners. See [runtime shutdown ordering](runtime.md#shutdown-truthfulness).

This is not a crash-atomic global world snapshot: shutdown deadlines still apply and forced termination recovers only committed state. Offscreen vassals remain hot; elapsed downtime is not simulated reward time. Runtime latency, failure/recovery and save/reload acceptance remain separately authorized checks.

## Retained clan goal transactions

`Database.updateAutonomousClanGoal` saves the selected goal section with optimistic revision checks and membership reconciliation in the existing transaction. When the main planner adopts the production goal, its save can pass `supersededProductionGoalKey`: only a main-section save matching that production key clears the production copy and production-owned recruitment metadata in the same transaction. Unrelated production goals remain intact; there is no bulk cleanup or schema migration. Producers also recognize a leftover production copy by the same nonempty goal key; cleanup still requires a qualifying goal save. This retained planner path does not enable autonomous clan scheduling under the [owned-only boundary](bot-runtime.md).

Equipment beneficiary rotation runs after a successful ordinary assignment; a full-roster goal already saved inside the service keeps early rotation. Roster-conflict reform still precedes assignment, and an ordinary goal is saved later by its caller. These steps are not one transaction: the change does not roll back conflicting-party reform or a later failed goal save.

`ClanReviewEvents` keeps review invalidations in RAM and drains a batch before `ClanActionService.scheduleReviews` schedules its actions. If scheduling throws, the failing and later batch entries are restored with their original causes before the error propagates. Shared `ClanRaidRoster.wakeCancelled` limits `raid_cancelled` to marked raid owner/source/not-opened cancellations. `cancelUnopened` calls it after saving the dissolution and awaiting the member-release attempt; successful worker-result and legacy cold commits also call it. Worker results are deduplicated per party within a batch before worker-epoch ACK filtering, because the database effect already committed. This does not reset the goal or prove that every member was released. This does not make the batch durable or atomic: already-created database actions remain, and stopping the service clears the in-memory events.

## Connected-player auto-fight preferences

`Actor/PlayerAutoFight.js` owns live preference state; `Actor/PlayerAutoFightSettings.js` validates the exact durable fields. `Database.fetchAutoFightSettings` and `saveAutoFightSettings` read/write through the main serialized queue with character/account ownership checks. Migration **69** and the fresh SQLite bootstrap define `character_auto_fight_settings`: one `characterId` primary/foreign key with `ON DELETE CASCADE`, plus valid JSON bounded to 8192 UTF-8 bytes. Ordinary character/account deletion and character wipes cascade through the foreign key; there is no bot-lifecycle or management-world-database writer.

- Durable fields: integer radius 1–6000, up to 512 unique skill IDs, basic-attack-only, pickup, and player HP/MP enter/resume percentages. Defaults are radius 1200, an empty whitelist, basic-only ON, pickup OFF, HP 35/95%, MP 20/95%. Each resource requires integer `1 <= enter < resume <= 100`. Unknown/missing fields, invalid types, duplicates or invalid bounds are rejected; unavailable learned skills remain non-executable under the live skill gate.
- Preferences load lazily when opening `.autofight` or first reading the linked Dashboard. Start/edits are refused while loading rather than queued for later replay. A missing row uses defaults, not a write. Existing saved radii, including former preset values, are retained; the wider numeric validation needs no schema migration. Invalid stored data or a read failure is visible and blocks Start, with explicit retry or replacement with defaults rather than a silent fallback.
- Every explicit preference edit queues a complete immutable snapshot. New snapshots serialize after old ones; only the latest edit completion can set the visible save result. A queued write rechecks the actor/lifecycle before execution, so an old connection cannot overwrite a later login's settings. Loads and callbacks cannot apply to a replaced actor, and UI redraws also require the same open page epoch/revision.
- `PlayerAutoFightControl` shares native/web desired-state edits and reports persistence separately from live acceptance (`clean` / `saving` / `saved` / `failed`). A satisfied setter does not queue another save. Dashboard polling only reads controller state after the initial lazy load; it does not save, journal, or query passwords. Account/session/actor ownership is rechecked on asynchronous load/save completion. Transient actor/card/run versions and party policy/membership epochs are not durable preferences.
- Save failure preserves the live edit, displays that it is not saved, offers retry and blocks a subsequent Start. Disabling a running skill takes effect before persistence finishes; a failed save does not re-enable it. Disconnect/teleport/teardown can invalidate pending work; pending edits are not a durability guarantee, and an interrupted save must be retried if the actor remains active.
- Coordinates, session/run flags, targets, routes, timers, stats and skill ownership are never part of this row. Reconnect loads preferences only, with no setup points or automatic combat. Party/vassal pull settings and native recovery policy are separate owners.

Migration application, save/relogin behavior and malformed-data recovery still require separately authorized runtime verification. Static implementation does not assert that migration 69 has run on the live world. See [controls and execution](world-combat.md#connected-player-auto-fight).

## Management settings and stopped-data operations

`src/WorldObserver/SettingsService.js` is the sole managed local INI writer; `ManagementPresetStore.js` owns the retained `launcher-settings.json` separately. These files are configuration, **not** new DB tables or part of saved worlds. Shared `ConfigLoader` preserves layering/parser semantics; curated writes validate/reparse, preserve unrelated content/mode, stage/fsync and atomically replace in the same directory after revision recheck. INI and preset JSON are not one transaction, and external editor coordination is limited to detected revisions.

Persisted configuration and runtime IPC are also not atomic. Only confirmed observed values count as applied. A successful save with failed/uncertain live apply remains saved and pending **Stop → Start**, without hidden retries or an Apply saved endpoint. Existing save/data formats and configured paths are unchanged; see [runtime](runtime.md).

The persistent management parent reserves lifecycle/save/load/delete/wipe operations before awaits, requires confirmed game-descendant exit for data operations and preserves the existing save-worker/access-lock protocol. Stop leaves metadata/logs/Settings available at the same origin; HTTP disconnect does not cancel or roll back a reserved operation. Load still makes no automatic backup and does not start the game. World-wipe history failure can follow committed deletion, not rollback. Cleanup outcome (clean/failed/timed_out/unknown) is separate from process exit code, and unknown descendant termination blocks conflicting operations.

## Retained cold ownership protocol

The cold worker architecture remains in source but is not started by the enforced owned-only policy. When tracing retained code, follow:

`ColdSimulationWorker` proposals → `ColdSimulationCoordinator` / `ColdCommitQueue` → main `Database` transaction → acknowledgement.

`ColdSimulationOwner` and database APIs compare owner, revision and lease before committing. Hot activation fences/drains worker work before handing ownership to the main process; stale cold snapshots cannot overwrite newer hot state. Explicit cooldown hands ownership back. Registered vassals are excluded from ordinary cooldown and legacy activation; see [bot runtime](bot-runtime.md).

Do not reuse a worker snapshot as authoritative inventory or bypass ownership fencing just because the cold scheduler is currently disabled.

## World → history outbox → projections

1. World mutations stage corresponding durable events through `Database.historyOutboxUnsafe` where that transaction owns an event.
2. The history worker reads world outbox rows and writes the separate history database, normally in batches at a 200-ms cadence.
3. `HistoryStore.transfer` commits history events and its cursor together; acknowledged source rows are then deleted by the main database owner.
4. World/history tokens and cursors guard pairing. Incompatible history is set aside as an orphan; legacy analytics tables can be migrated from world storage.

This is an asynchronous projection, not a cross-file atomic transaction. Unknown/malformed ordinary events can be skipped while advancing the cursor; world-wipe failures have different abort behavior. History reads attempt a flush barrier, but a warned flush failure can leave the read stale. Do not use the observer's history as current gameplay authority.

### Journals and retention

- `src/EconomyJournal.js` observes the main connection through temporary triggers and aggregates successful-operation deltas in memory.
- `src/PvpJournal.js` buffers combat history. Buffered journal data is volatile before outbox flush; it is not a complete crash-proof per-character audit.
- `Database.flushJournals` normally transfers these buffers to the outbox every 60 seconds, draining only after commit.
- `HistoryStore.retention` owns pruning/compaction: market trade/store history uses a 90-day window, hourly economy/PvP 14 days, raw PvP 12 hours, and terminal clan details compact after an hour. These are different histories, not a global retention promise.
- AI conversations and social memory have separate persistence/retention contracts; see [AI and social behavior](ai-social.md).

## Checkpoints, shutdown and recovery limits

World/history use WAL with `synchronous=NORMAL`; neither in-memory buffering nor this mode promises per-event survival of power loss.

- Passive checkpoint maintenance defaults to a five-second interval and a 4-MiB minimum WAL size. A passive checkpoint need not reset/shrink WAL, and busy results matter.
- `PopulationService.runAdaptiveWalReset` gates a truncate reset on player protection, an idle database queue, checkpoint completion and growth/cooldown thresholds. It is not permission to truncate WAL externally.
- Checkpointing is not backup. Copying only an active SQLite main file can omit WAL state.
- Shutdown attempts service drains and character flushes before closing the database, but has a forced-exit deadline. Database/history cleanup reports recoverable journal/outbox/history-stop and final-checkpoint-result failures to the lifecycle owner while preserving cleanup/SQL ordering and existing return values; these failures cannot become clean merely because the process exits code 0. See [runtime](runtime.md).
- Paired save loading uses validated copies, fsynced markers and rollback files to recover interrupted replacement. It is recoverable replacement, not an atomic world+history filesystem transaction.
- Preserve `.access.sqlite`, restore markers and pending files for their owner. Never unlink the shared lock file to clear a busy error.

Authored SQL/resources, generated catalogue exports and live SQLite/WAL/SHM/history/access/recovery files are distinct categories. Do not edit generated persistent state as though it were authored game content.

## Update together

Changes to buffered fields or transactional operations require checking producers, flush barriers, restore/status readers and economic commit guards. Changes to outbox events require checking `HistoryStore`, transfer cursors, pairing, retention and observer consumers. Save-format changes also affect [operations](operations.md) and Server management UI. Recovery, crash replay and restart durability require separately authorized runtime checks; source research alone does not certify them.
