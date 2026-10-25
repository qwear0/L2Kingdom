# Operations and verification boundaries

Use this as a side-effect guide, not an instruction to run commands automatically. Repository execution policy remains in [`AGENTS.md`](../AGENTS.md). See the [project map](README.md) and [runtime lifecycle](runtime.md).

## Requirements and local setup

- `package.json` requires Node.js `>=22.5.0`; persistence uses built-in `node:sqlite`.
- Install dependencies with `npm install` only when setup is actually requested. `node_modules/` and `package-lock.json` are ignored in this repository.
- The native game client must speak Lineage II C4 protocol `656`. WebObserver is not a replacement game client.
- Start from `config/default.ini` and `config/local.example.ini`; keep private overrides in ignored `config/local.ini` or an explicitly selected override file.
- Default interfaces differ: authentication/game TCP bind all interfaces, while launcher and observer bind loopback. Do not expose local HTTP control surfaces merely to make them remotely accessible.

## Command side effects

These are existing commands, not checks executed by creating this documentation.

| Command | Effect and caution |
| --- | --- |
| `npm start` | Starts the launcher and normally opens a browser. Starting gameplay is a separate launcher action. |
| `npm run NodeL2` | Prepares geodata, then starts the actual server. Startup may migrate/write SQLite and restore owned actors. |
| `npm run geodata` | Checks/prepares geodata; may download and install a large archive. Does not start gameplay. |
| `npm run generate:knowledge-base` | Regenerates the five committed `data/KnowledgeBase/` JSON outputs from source resources. |
| `npm run check:knowledge-base` | Rebuilds catalogue content in memory and compares it with committed outputs; does not establish gameplay correctness. |
| `npm run check` | `scripts/check-syntax.js` runs Node `--check` on JavaScript under `src/`, `scripts/` and `tests/`. No application startup or runtime validation. |
| `npm test` | Invokes the existing explicitly selected suite through `scripts/run-tests.js`; not all files are necessarily selected. Do not run by default. |
| `npm run test:geodata` | Prepares geodata before invoking the geodata-selected tests. Includes installation side effects. |
| `npm run load:mixed` | Writes load-scenario configuration/database artifacts and starts runtime processes. It is not a syntax check; legacy load-hook activation is additionally constrained by owned-only policy. |
| `npm run wipe:bots` | Destructively deletes bot-prefixed accounts, characters and associated state. Calls `scripts/world-wipe.js` directly, without the launcher's stopped-state/confirmation guards. Includes owned vassals, not just obsolete ambient bots. |

Other scripts under `scripts/` include migrations, content generators and benchmarks. Inspect a specific script's inputs, output paths and process/database effects before recommending or executing it. Their presence is not an operations schedule.

## Launcher saves and restore

Owners: `scripts/start.js`, `scripts/saved-games.js`, `src/DatabaseRestore.js`, `scripts/database-access.js`.

1. The launcher permits save/load/delete while its game server is stopped.
2. A save contains a validated world database, optional paired history database and `save.json` metadata. Configuration and launcher settings are not included.
3. Creation checkpoints the stopped databases, copies them through a pending directory, validates the pair and records file digests before publishing the save.
4. Load validates copies and uses the paired restore/recovery protocol to replace current world/history state. The server remains stopped.
5. Load creates **no automatic pre-load backup**. Delete permanently removes the selected save.

The launcher defaults to `tmp/saves` (or `saves` under its custom runtime directory). This is an existing application save feature, not the location for agent-created persistent backups: repository policy reserves those for `/data/!backups/L2Siege/`.

The persistent `<database>.access.sqlite` file defines the shared SQLite access-lock domain. Never unlink it to bypass a busy error: that can let different processes hold different locks. Preserve restore markers and pending files for the recovery owner rather than manually deleting them.

## Wipes and history

`world-wipe.js` selects bots by the `bot_` account-name prefix; player scope selects the complement. Wipes remove related character/clan/trade state, not only account rows. Active mixed bot/player trades can block a partial wipe.

World deletion commits before history cleanup. A committed outbox instruction allows history cleanup to resume later; a history error does not mean world deletion was rolled back. See [persistence](persistence.md).

Prefer the guarded launcher flow for manual operations. Do not infer that the standalone wipe wrapper acquires the server's access lock or provides a dry-run just because the launcher does.

## Documentation and code checks

- For documentation-only work, validate affected claims against source, check referenced paths and relative links, and inspect `git diff --check` and the final diff.
- JavaScript changes require the existing `npm run check`. It proves syntax parsing only.
- Automated suites, new tests and test infrastructure are not routine requirements; follow `AGENTS.md` and explicit task authorization.
- Do not build, start, stop or restart the server as a side effect of documentation, Git operations or syntax checks.
- An independent documentation review and live behavior verification are separate activities. Neither source research nor the existence of a test file proves those activities passed.

## Update together

Change this document when package commands, script side effects, save formats, access locking, wipe behavior or verification workflows change. Keep the [runtime guide](runtime.md), [persistence guide](persistence.md), root README and `AGENTS.md` consistent without duplicating the full policy here.
