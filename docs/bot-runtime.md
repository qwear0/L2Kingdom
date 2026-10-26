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

## Settings boundary

WorldObserver Bot settings describes **player-owned vassal behavior and optional AI dialogue**. Owned-only is read-only. `pvpAggression` (0..1) and `knowledgeErrorsEnabled` remain restart settings because `PopulationConfig` snapshots file/environment overrides; knowledge is not erased. PvP is initiation/risk/retreat behavior, not a probability of attacking every encounter, and self-defense remains at zero. Population environment ownership locks the relevant controls.

`useBssdOutOfCombat` is a restart setting, disabled by default: bots do not automatically charge blessed spiritshots for peaceful buffs/heals/other magic. Offensive casts (including the opening cast), the bot's own combat state and active party combat still permit charging; merely selecting a hostile leader target is not combat. WorldObserver renders **Use BSSD outside combat** as a checkbox; `BOT_USE_BSSD_OUT_OF_COMBAT` can own the setting. Player auto-shot preferences, ordinary spiritshots and soulshots are unchanged.

Inactive ambient counts/seeders, cold travel, background services, autonomous clans and static-shot restrictions are not offered as functional controls. Diagnostics remain restart settings under Server management with master/detail dependency. AI enabled/model/router/concurrency have a separate live dispatch contract; see [AI](ai-social.md) and [Settings](world-observer.md). Saving a configuration never starts workers or restarts gameplay.

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

While a connected leader's auto-fight run is active, `Actor/PlayerAutoFightPolicy.js` adds temporary zone/recovery constraints to companion designated pulls, the tank fallback and native offensive recipient expansion. Recovery suppresses routine buffs/charge preparation and non-emergency Recharge without rewriting pull settings or detached vassal duties. Inspection is not an assist target. See [auto-fight ownership and limits](world-combat.md#connected-player-auto-fight); ordinary behavior resumes outside the run.

`BotClassPolicy.skillAllowed` adds an optional pre-selection filter; ordinary bots without a player controller retain their learned-skill policy. Offensive/charge choices, `BotSkillCapabilities`, `SummonerTactics` and support caches apply that filter. `BotHealingPolicy` shares the narrow healing-priority decision with `FollowingState`, not its movement/service state machine. An eligible automated leader joins the existing support-provider set and executes only its own native casts; no player BotAI session, direct service buffs or player loadout cleanup is introduced.

New player/companion targets under that run also pause while `PartyPulling.hasDeadPartyMember` detects a fallen party member or `partyRevivalAttempt` is pending; already engaged combat and defensive actions remain legal. Companion Sweeper is corpse collection, not offensive initiation: it retains native corpse, spoil ownership, range and resource checks without applying the live-monster acquisition predicate. Other corpse-targeted offensive skills are not exempt.

The source-adjacent [class policy](../src/GameServer/Bot/AI/CLASS_POLICY.md) describes consumers and approximations. Engineering preference scores are not historical C4 facts, optimal rotations or gameplay certification.

## NPC escape and defensive reassessment

- `PartyAwareness.npcsTargetingActor` projects live, nearby NPCs currently targeting the actor. Escape continuation uses that state, not time since damage or residual hate; an NPC returning home is no longer a pursuer.
- `States/FleeingState.js` stops an obsolete escape route when pursuit ends. While a solo bot is pursued, it reassesses combat at most once per second using `BotThreatAssessment.js`: current HP/MP, learned attacks, an already present summon, target resistance/remaining HP and the combined pressure of up to six attackers. Unknown combat stats or a larger group do not justify re-engagement. A recovering bot also passes the existing encounter-readiness gate; protected raids and unsafe hunting grounds are not resumed this way.
- Hunting/resting self-defense uses the same assessment. The existing emergency-finisher policy may still justify a safe last hit instead of retreat. These are conservative estimates, not predictions of guaranteed combat outcomes.
- `fleeStart` measures the whole escape episode. The 30-second limit replaces a stale movement leg; it neither resets the episode nor forces combat while a pursuer remains. Player/PK escape legs and party raid holds retain their separate behavior.
- Bot status exposes the retreat threat name, initial resource ratios/reason, last assessment and episode completion reason under `movement.retreat`, without requiring developer diagnostics.
- Ordinary static monsters and ordinary group minions have a spawn leash and physical return/reset owned by `Npc/NpcReturnHome.js`; see [world/combat](world-combat.md). No damage-inactivity timeout is used.

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
