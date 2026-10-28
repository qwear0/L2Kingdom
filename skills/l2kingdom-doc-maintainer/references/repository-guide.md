# Repository reading guide

These are starting anchors, not an exhaustive architecture map or a guarantee that a subsystem is active. Verify paths and wiring in the checkout before documenting behavior.

## Runtime and configuration

- `AGENTS.md`: execution, verification, artifact, language, and Git rules.
- `docs/README.md`: maintained project map and links to runtime, operations, protocol, persistence, vassals, bot execution, world/combat, economy, AI/social, observer and content guides. Read the affected feature before deep implementation.
- `README.md`: current fork overview and user-facing operations, alongside upstream material; cross-check affected claims against source.
- `package.json`: Node.js requirement, dependencies, and command definitions.
- `scripts/start.js`, `scripts/run-server.js`, `src/NodeL2.js`: launch/runtime entrypoints; read without starting the server.
- `src/Global.js`: configuration loading and shared runtime context. Inspect configuration precedence and environment handling before describing effective values.
- `config/default.ini`, `config/local.example.ini`: defaults and documented override examples. `config/local.ini` is ignored local configuration, not portable documentation evidence to copy verbatim.
- `src/GameServer/Bot/Population/PopulationConfig.js`: inspect enforced owned-only policy as well as INI defaults; historical settings need not remain effective after overrides.

## Responsibility boundaries to trace

| Area | Starting anchors | Documentation questions |
| --- | --- | --- |
| Authentication and connections | `src/AuthenticationServer/`, `src/Server.js` | Who validates identities, owns sessions, and hands connections to the game server? |
| Game runtime and world | `src/GameServer/` | Which subsystem owns world state, scheduling, combat, and progression? Which paths are actually active? |
| Castellan and vassals | `src/GameServer/Lord/`, `src/GameServer/Bot/` | Where are ownership, recruitment, commands, and persistence enforced? Which legacy population paths are bypassed? |
| Protocol | `src/Packet/` and the relevant server handler | Who dispatches a packet, validates input, changes state, and serializes a reply? |
| Persistence | `src/Database.js`, adjacent `src/Database*.js`, `src/History*.js`, `database/` | Who writes durable state, performs transactions/restores/checkpoints, and owns authored schema versus live database files? |
| WorldObserver backend / L2Kingdom frontend | `src/WorldObserver/`, `src/frontend/public/` | Trace API-only management, parent-only `publicOrigin`/client checks, game projections, browser consumers and shared atlas/icon files separately. Standalone/private-child static routing is retained; frontend packaging/deployment is not implied by the source move. Do not assume observer APIs are read-only. |
| AI and social behavior | `src/GameServer/Bot/AI/`, `src/GameServer/Social/`, AI sections in configuration | Which deterministic behavior, external requests, failure handling, and state updates are involved? |
| Authored resources | `data/`, relevant loaders in `src/GameServer/` | Which files are authored, generated, or downloaded? Which loader actually consumes the resource? |
| Maintenance and verification | `scripts/`, `tests/`, `package.json` | What does a command read/write, and could it start processes, fetch resources, or mutate state? |

These are areas within one repository; do not turn directory boundaries into invented services or deployment units.

## Existing documentation and historical material

Start with the maintained [project map](../../../docs/README.md), then discover relevant source-adjacent Markdown with a bounded `rg --files` query; not all documentation is under `docs/`.

Source-adjacent reading candidates include:

- `src/GameServer/Bot/AI/CLASS_POLICY.md`
- `src/GameServer/Bot/Population/COLD_COMPETITION.md`
- `src/GameServer/Clan/CLAN_SOCIAL.md`
- `src/GameServer/Social/INTERACTION_MEMORY.md`
- `src/GameServer/World/Generics/HTML_UI_KIT.md`

These documents may describe legacy or inactive behavior. Confirm applicability rather than presenting them as current runtime guarantees.

`planning/` contains existing planning material, not an authoritative implementation specification. New task plans belong in `tmp/plans/`. Keep `docs/` organized by durable flows and reading needs, not one map per source directory.
