# Bot execution and simulation boundaries

Read this to distinguish active vassal execution from retained population machinery. See the [project map](README.md), [vassal duties](vassals.md), [world/combat](world-combat.md) and [AI conversations](ai-social.md).

## Current activation is enforced in code

`src/GameServer/Bot/Population/PopulationConfig.js` applies `ownedOnly=true` after file/environment overrides. This is stronger than disabled defaults in `config/default.ini`.

| Active owned-only path | Retained path not started by this policy |
| --- | --- |
| Registered vassal restore and live BotAI | Ambient population generation/seeders |
| Vassal gathering, party play and physical supply trips | Cold resolver and background parties |
| Lifecycle persistence and 30-second owned-actor snapshots | Director, phase policy, background governor/jobs and legacy repair jobs |
| Configured WAL maintenance | Autonomous clan founding/planning/simulation |
| Native movement and pathfinding workers | Legacy cold market/crafting/population scheduling |

`ClanSimulationConfig.js` additionally forces autonomous clan simulation off. `src/NodeL2.js` skips its planner and gates the legacy hot-load hook. Old INI overrides, historical rows or the presence of a module do not reactivate those services.

## Live bot lifecycle

- `src/GameServer/Bot/BotManager.js::init` initializes vassal/lifecycle services and restores `fetchOwnedVassalCharacters()` rather than an ambient roster.
- `restoreOwnedVassal` validates registry membership and coalesces concurrent restoration; spawn admission also checks the owned character identity.
- `src/GameServer/Bot/Population/BotLifeState.js` loads owned lifecycle rows without legacy cold recovery.
- `src/GameServer/Bot/BotSession.js` adapts the native actor/session interface; live bots still use actor movement, skills, effects, inventory and combat.
- `src/GameServer/Bot/BotAI.js` owns per-session scheduling, wakeups and tick dispatch. `Bot/AI/States/` contains narrower hunting/following/resting/service state handlers.
- `src/GameServer/Bot/AI/VassalOrders.js` takes responsibility for non-companion owned duties and their continuation fences.
- `Population/Cooldown.js` refuses registered vassals. Owned actors do not become cold merely because the nearest human leaves.

Rule-based execution is distinct from LLM dialogue. It is not globally reproducible simulation: native timers, current time and randomized choices still affect behavior.

## Scheduling and level of detail

`BotAI.scheduleTick/wakeup` schedule actor work; state handlers are not independent uncoordinated game loops. Busy operations and explicit continuations must retain their identity checks before releasing holds or publishing results.

`Bot/AI/HotActorLodPolicy.js` distinguishes full, visible and preload detail for hot actors. These labels describe live scheduling/detail, **not cold ownership**. Vassals promote to full owned context even without nearby players, and non-companion duty scheduling bypasses ordinary low-detail delays.

Post-party safe rest measures eligible live time, not elapsed server downtime. See [vassal lifecycle](vassals.md) for the ten-minute rest and recovery rules.

## Native class decisions

- `Bot/AI/BotClassPolicy.js` derives class/ancestry skill eligibility, role, PvE/PvP solo/party context and resource preferences.
- Actual learned skills take precedence over theoretical availability. Policy coverage does not imply every actor has trained every skill.
- `Bot/AI/BotCombatUtility.js` applies validity/resource gates before preference scoring. Native attack/cast checks still decide whether an action executes.
- Action feedback distinguishes accepted requests from actual effect results; an accepted but interrupted cast need not have produced its effect.
- `Bot/AI/BotDecisionService.js` provides a narrower recovery/follow/target/spot recommendation path; it is not the universal scheduler.
- `Population/ColdClassPolicy.js` adapts retained cold profiles to shared selection without reproducing native geometry or timing.

The source-adjacent [class policy](../src/GameServer/Bot/AI/CLASS_POLICY.md) describes consumers and approximations. Engineering preference scores are not historical C4 facts, optimal rotations or gameplay certification.

## Retained cold worker contract

Read these only when maintaining that architecture; they are not current vassal execution instructions:

1. `Population/ColdSimulationCoordinator.js` starts the worker only when the resolver is enabled and provides bounded snapshots.
2. `ColdSimulationWorker.js` excludes live World, BotManager, network and Database dependencies; `ColdSimulationKernel.js` schedules bounded snapshot work.
3. Worker proposals return through `ColdCommitQueue`; main-process database commits enforce lease/revision ownership before acknowledgement.
4. `HotActivation.js` fences worker work before handoff. `Cooldown.js` saves native state before explicit return to cold ownership.
5. `HotPartyLifecycle.js` owns whole-party publication/cooling. `BackgroundJobRegistry.js` coalesces intervals and prevents overlapping jobs; `BackgroundWorkGovernor.js` admits work against budgets and leases.

The population scheduler timer in the retained coordinator is not evidence of a main-thread cold simulation loop. The [resource competition document](../src/GameServer/Bot/Population/COLD_COMPETITION.md) contains broader historical contracts and must be read with this activation boundary.

## Pathfinding remains a separate worker boundary

`src/GameServer/Actor/Generics/MoveTo.js` selects asynchronous native pathfinding for vassals and excludes their legacy low-detail warp. Results are checked against current actor, route generation, target and location before movement.

`src/GameServer/Geodata/PathfindingWorkerPool.js` provides bounded queues, cancellation and deadlines with lazy worker creation. NPC movement also uses it. Disabling the **cold simulation worker** does not disable these pathfinding workers.

## Update together

For activation changes, inspect `PopulationConfig`, `PopulationService`, BotManager, lifecycle save/restore, `ClanSimulationConfig` and NodeL2 startup together. For scheduling changes, check state handlers, operation fences, native actions and LOD. Never use historical cold counters or successful syntax parsing as proof of current owned-vassal gameplay.
