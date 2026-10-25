# Runtime, configuration and lifecycle

Read this when changing startup, effective configuration or shutdown behavior. See the [project map](README.md) for subsystem ownership and [operations](operations.md) for command side effects.

## Entrypoints and process boundaries

| Entrypoint | Responsibility |
| --- | --- |
| `package.json` → `scripts/start.js` (`npm start`) | Starts the local HTTP launcher, not the game immediately. The launcher starts/stops a child server and exposes configuration, logs, saves and wipe controls. |
| `scripts/run-server.js` (`npm run NodeL2`) | Prepares geodata, then spawns the actual runtime with `--openssl-legacy-provider` and repository working directory. |
| `src/NodeL2.js` | Initializes shared globals, database, world, TCP servers, bots and observer. Direct invocation bypasses wrapper geodata preparation. |
| `src/Global.js` | Defines `invoke`, shared utilities, constants and parsed configuration. `invoke('GameServer/...')` resolves a module under `src/`, not a separate service. |
| `src/Server.js` | Owns a TCP listener and constructs a session for each connection. Listening is asynchronous. |

The launcher defaults to `127.0.0.1:8090` and opens a browser unless `L2NODE_NO_BROWSER=1`. The game runtime is one application process with worker threads and an integrated observer; authentication, game and observer directories are not independently deployed services.

## Configuration precedence

`src/Global.js` merges nested INI sections in this order:

1. `config/default.ini`.
2. The optional file named by `L2NODE_SHARED_CONFIG_FILE`.
3. `config/local.ini`, or the file named by `L2NODE_CONFIG_FILE` **instead of** `local.ini`.

Missing optional files contribute no overrides. `config/local.example.ini` is an example, not an automatically loaded layer. Private keys and machine-specific values belong in ignored local configuration, never in maintained documentation.

Environment overrides are implemented by individual consumers; they are not a universal last merge layer. Examples:

- `src/GameServer/ProgressionRates.js` reads `L2NODE_PROGRESSION_RATE`. The launcher passes its selected `x1`, `x10` or `x50` profile to the child.
- Geodata preparation and runtime consume `L2NODE_GEODATA_DIR`; mirror/checksum controls belong to preparation, not INI parsing.
- AI provider and tracing overrides have their own consumers; see [AI and social behavior](ai-social.md).
- `PopulationConfig` applies the owned-only policy **after** ordinary configuration/environment handling. Old overrides cannot reactivate ambient population or autonomous clans; see [bot runtime](bot-runtime.md).

Paths used by the runtime are working-directory-sensitive. The supported wrapper sets the repository working directory; the launcher has its own root-relative configuration reader. Keep those readers synchronized when changing launch settings.

### Committed defaults, not deployment claims

| Setting | Default | Owner |
| --- | --- | --- |
| `[Database] path` | `tmp/nodel2.sqlite` | `src/Database.js` and database helpers |
| `[AuthServer] hostname/port` | `0.0.0.0:2106` | `src/Server.js`, authentication sessions |
| `[AuthServer] autoCreate` | `true` | Authentication login flow |
| `[GameServer] hostname/port` | `0.0.0.0:7777` | Game sessions |
| `[GameServer] advertisedHostname` | Unset | Address sent during server selection; distinct from listener binding |
| `[GameServer] playerWarehouseSlots` | `300` | Shared account warehouse capacity |
| `[General] protocol/maxLevel` | `656` / `78` | C4 protocol and progression |
| `[General] progressionPreset` | `x1` | `src/GameServer/ProgressionRates.js` |
| `[OpenRouter] enabled` | `false` | External inference client |
| `[Langfuse] enabled` | `false` | Optional tracing |
| `[WorldObserver] enabled/hostname/port` | `true`, `127.0.0.1:8088` | Integrated observer |

A committed default does not establish effective private configuration, network reachability or a running deployment.

## Startup flow

`src/NodeL2.js` is the ordering authority:

1. Load globals, acquire the database-access lock and initialize optional tracing.
2. Initialize the database and data cache; run stackable-inventory compaction and possible space reclamation.
3. Initialize clans, geodata and the world, then clan-hall and persistent AFK-trade runtimes.
4. Load bot personas and warm recipe/native knowledge catalogues.
5. Construct authentication and game TCP servers.
6. Await bot-manager initialization, then initialize WorldObserver and the developer console.

Startup can migrate and write persistent state; it is not a read-only health check. Owned-only startup skips autonomous clan planning and the legacy hot-load hook.

TCP listener construction is not an awaited all-subsystem readiness barrier. The launcher's game-server log marker can appear before bots and observer finish initialization. Do not interpret a launcher “running” indication as proof that every subsystem is ready.

## Geodata preparation

- owner: `scripts/geodata-bootstrap.js`; CLI: `scripts/ensure-geodata.js`.
- consumer: `src/GameServer/Geodata/GeodataEngine.js`.
- local resource: ignored `data/Geodata/`, unless `L2NODE_GEODATA_DIR` selects another directory.
- Missing/empty resources trigger download of the pinned archive, checksum verification and staged installation.
- An existing directory is accepted using region-count and required-file-size checks, not a checksum of every installed region.
- A nonempty incomplete directory is rejected rather than replaced automatically.
- `L2NODE_GEODATA_URL` and `L2NODE_GEODATA_SHA256` select an explicit alternate source/trust value. Changing a URL alone is not authorization to trust different bytes.

`npm run geodata` prepares files without starting gameplay, but may perform a large network download and disk writes.

## Shutdown and failure clues

`src/NodeL2.js::shutdown` handles signals and the wrapper's IPC shutdown request. It stops population work, flushes buffered characters, shuts down pathfinding/planning workers and tracing, drains interaction-memory events, then closes SQLite. Individual step failures are logged and later cleanup steps still run.

The runtime has a 15-second forced-exit deadline; the wrapper and launcher have longer termination deadlines. A timeout or logged flush failure means graceful durability is not proven. This flow does not provide an explicit full TCP connection-drain guarantee.

For failures, inspect the layer that owns the transition: geodata bootstrap before child startup; database access/recovery before world initialization; the specific initialization promise before observer startup; buffered-write and worker-drain messages during shutdown. Avoid deleting lock or recovery files to make startup proceed.

## Update together

Update this document when entrypoints, readiness, configuration precedence, environment consumers or shutdown ordering change. Also check `README.md`, [operations](operations.md), [persistence](persistence.md), `config/local.example.ini` and the launcher's configuration reader. Syntax checking alone cannot validate lifecycle behavior.
