# L2Kingdom project map

L2Kingdom is a private Lineage II C4 server derived from L2Solo / NodeL2. Package names, runtime identifiers and upstream material still use those names. This map explains where current behavior lives and what must change together; it is not a generated file inventory.

## Scope and current runtime

- `npm start` owns the persistent API-only WorldObserver management listener and launches a geodata/runtime wrapper on demand. Browser sources are in `src/frontend/public/`; `src/frontend/` owns Nginx/Docker/Compose packaging for container `l2kingdom_frontend`. Source readiness is not a built/deployed or runtime-accepted frontend. NodeL2 owns authentication/game TCP, world state, worker threads and an optional private loopback observer API. See the [frontend boundary](world-observer.md#l2kingdom-frontend-sources-and-deployment-boundary) before starting a new browser deployment.
- Built-in SQLite stores the world; a separate history database receives asynchronous projections. Authored resources, generated catalogues and live persistence are different sources of truth.
- **Owned-only policy is enforced after configuration overrides.** Live player-owned vassals remain active; ambient seeding, cold simulation, background parties and autonomous clan simulation are bypassed. Historical modules/options do not prove activation.
- External AI is optional. Native rule-based behavior and service validation remain responsible for game actions.
- Source-backed descriptions are not evidence of real-client acceptance, a live deployment's private settings or complete retail C4 compatibility.

## Reading order

1. Read [`AGENTS.md`](../AGENTS.md) for execution, language, artifact and Git policy; read the root [`README.md`](../README.md) for player-facing setup/current-fork context.
2. Read [runtime/configuration](runtime.md) and inspect `package.json`, `config/default.ini` and the relevant owner.
3. Choose the feature below; follow its entrypoint → state owner → persistence/asynchronous boundary → client/observer consumer.
4. Use CodeGraph for bounded cross-file discovery where available; validate dynamic wiring and critical negative claims against source/configuration. See the [retrieval policy](../skills/l2kingdom-doc-maintainer/references/semantic-retrieval-policy.md).

## Documentation by question

| Question | Document | Primary code anchors |
| --- | --- | --- |
| How does the application start, select config and shut down? | [Runtime and lifecycle](runtime.md) | `scripts/start.js`, `scripts/run-server.js`, `src/NodeL2.js`, `src/GameServer/GameplayLifecycle.js`, `src/GameServer/GameplayShutdown.js`, `src/ConfigLoader.js`, `src/Global.js` |
| Which commands download, write, delete or start processes? | [Operations and verification](operations.md) | `package.json`, `scripts/`, `AGENTS.md` |
| How are upstream changes reviewed one commit per source, including parallel source sessions? | [Upstream update workflow](operations.md#one-commit-upstream-updates) | `skills/l2kingdom-upstream-integrator/SKILL.md`, ignored `tmp/upstream-integration/` |
| Who admits accounts and dispatches client packets? | [Protocol and sessions](protocol.md) | `src/Server.js`, `src/AuthenticationServer/`, `src/GameServer/Network/`, `src/Packet/` |
| Which state is durable, and who can replace it? | [Persistence and durability](persistence.md), [auto-fight preferences](persistence.md#connected-player-auto-fight-preferences) | `src/Database*.js`, `src/History*.js`, `src/GameServer/Persistence/`, `src/GameServer/Actor/PlayerAutoFightSettings.js` |
| Who owns a vassal, its orders and interrupted duties? | [Castellan and vassals](vassals.md) | `src/GameServer/Lord/`, `src/GameServer/Bot/AI/VassalOrders.js`, `src/GameServer/Bot/AI/PartyCompanionService.js` |
| Which bot work actually runs, and what is retained legacy code? | [Bot execution boundary](bot-runtime.md), [independent duty journeys](bot-runtime.md#journey-planning-catalogue) | `src/GameServer/Bot/BotManager.js`, `src/GameServer/Bot/BotAI.js`, `src/GameServer/Bot/Population/PopulationConfig.js`, `src/GameServer/Bot/Travel/JourneyPlanner.js`, `src/GameServer/Bot/Travel/JourneyExecutor.js` |
| Who publishes actors, resolves movement and applies combat/effects? | [World and combat](world-combat.md) | `src/GameServer/World/`, `src/GameServer/Actor/` (including `PlayerAutoFight.js` bounded hunting/support/pickup), `src/GameServer/Model/`, `src/GameServer/Effects/`, `src/GameServer/Geodata/` |
| Who validates item/Adena transfers and owns custody? | [Economy and storage](economy.md) | `src/GameServer/Inventory/`, `src/GameServer/World/GroundItemVisibility.js`, `src/GameServer/World/Generics/PickupItem.js`, `src/GameServer/Crafting/`, `src/GameServer/Warehouse/`, `src/GameServer/AfkTrade/`, `src/GameServer/PrivateStoreTrade.js`, `src/Database.js` |
| What crosses the external inference boundary and becomes memory? | [AI and social behavior](ai-social.md) | `src/GameServer/Bot/AI/`, `src/GameServer/Social/`, `src/GameServer/Clan/` |
| How does an MCP host observe an existing bot or explicitly take manual native control? | [Bot MCP control and observation (P1–P4)](bot-mcp.md) | `scripts/bot-mcp.js`, `src/Mcp/`, `src/GameServer/Bot/Control/`, `src/WorldObserver/BotControlRoutes.js` |
| How is the real C4 client bridge built, launched and observed? | [Native client bridge](../scripts/c4-client/README.md) | `scripts/c4-client/`, `scripts/c4-client-mcp.js`, `src/Mcp/Client/`; P0 world/ray gate passed; partial P1 adds native login/selection/session MCP, world-entry confirmation, bounded native movement/stop with manual takeover, sampled events, fixed waits and short native capture; decoded movement/lifecycle telemetry and calibration are pending |
| What does the browser read, configure or operate? | [WorldObserver backend / L2Kingdom frontend](world-observer.md) | `src/WorldObserver/ManagementController.js`, `ManagementRoutes.js`, `ObserverAuth.js`, `ObserverAuthStore.js`, `GameAccountService.js`, `GameDashboardContract.js`, `GameDashboardRuntime.js`, `SettingsService.js`, `SettingsRuntime.js`, `WorldObserverServer.js`; browser sources in `src/frontend/public/`, deployment files in `src/frontend/` |
| Which resource/rule is authoritative for a catalogue or NPC service? | [Content and progression](content.md) | `data/`, `src/GameServer/DataCache.js`, `src/GameServer/Knowledge/`, `src/GameServer/Quest/`, `src/GameServer/World/GatekeeperService.js`, progression/service modules |

Code anchors are repository-relative; wildcard notation identifies a family, not a literal filename.

## Cross-subsystem flow

```text
management parent -> geodata wrapper -> NodeL2 initialization
     |                                     |
     +-> Settings API / sole config writer / lifecycle & data operations
C4 client -> TCP/session -> request -> gameplay owner -> native response
                                      |          |
                                      |          +-> live actor/world/visibility
                                      +-> buffered patches or native DB transaction
                                                  |
                                              world SQLite
                                                  |
                                               outbox -> history worker -> history SQLite

management known-route proxy <- private game observer <- projections/catalogues/history
separate frontend -> parent validated client/Host/Origin -> durable admin-key session -> validated game services -> gameplay/persistence
chat -> deterministic routing / optional provider -> validated tools -> native services
```

These arrows show responsibility direction, not an assertion that every action traverses every box or commits one global transaction. See each feature's failure and durability limits.

## Important boundaries when changing code

- **Ownership:** vassals are character-owned and retain an original clan binding. Party membership, account sharing, social affinity and observer UI are not substitute authority.
- **Publication:** a durable character, a live world actor, a native client recipient and an observer row are different states.
- **Persistence:** queued memory changes, committed world transactions and asynchronously projected history have different durability/freshness.
- **Activation:** owned-only startup skips retained cold/clan schedulers, but native pathfinding/history/checkpoint workers have separate activation paths.
- **Operations:** the parent survives game Stop and distinguishes cleanup outcome from OS exit. Saves/restore/wipes, content generation and load scripts have real effects. Do not run them as incidental checks.
- **Settings:** saved files, inherited/environment ownership and observed active values are distinct; disk/IPC are not one transaction. Pending live recovery is explicit Stop → Start. See runtime for bounded controls and retained cumulative-SP/variable-reward native limits.
- **Local exposure:** the observer contains mutations behind personal-key admin sessions, not player/character ownership permissions; game-side authentication-key handoff is also incomplete. Keep local-project assumptions explicit; see the specific guides rather than assuming production guarantees.

## Existing detailed and historical material

- [Class policy](../src/GameServer/Bot/AI/CLASS_POLICY.md): shared policy consumers and approximations; cold consumers do not imply current activation.
- [Resource competition](../src/GameServer/Bot/Population/COLD_COMPETITION.md): retained hot/cold mechanics, subject to the owned-only boundary.
- [Interaction memory](../src/GameServer/Social/INTERACTION_MEMORY.md) and [clan reputation](../src/GameServer/Clan/CLAN_SOCIAL.md): state/event contracts; automatic clan background behavior is not enabled by their presence.
- [Native HTML UI kit](../src/GameServer/World/Generics/HTML_UI_KIT.md): client-facing HTML constraints.
- `planning/` and root README upstream updates/checklists contain historical material. Confirm current implementation and activation before treating them as requirements.

New plans/reports belong under ignored `tmp/` according to `AGENTS.md`, not in this documentation tree. Do not copy provider transcripts, live database records, private configuration or generated symbol dumps into maintained docs.

## Maintenance and verification

Use the canonical [documentation-maintainer skill](../skills/l2kingdom-doc-maintainer/SKILL.md). Update the smallest affected feature and this map when ownership, reading paths or contracts change. Keep root README as an overview rather than duplicating every flow.

For documentation changes, inspect source-backed claims, paths, relative links and `git diff --check`. JavaScript syntax checks, automated suites, runtime operations and independent review have separate scopes; see [operations](operations.md). The documentation describes implementation boundaries and known limitations, not a blanket claim that those checks passed.
