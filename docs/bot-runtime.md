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

## Journey planning catalogue (not yet integrated)

`Bot/Travel/TravelRoutes.js` retains the existing cheapest-fare `route`/`between` and hop-only `teleportPoints` APIs. Its additive `exitRoutes(townKey)` returns cached, immutable city-prefix-plus-native-exit routes, including competing offers to the same landing. Each step has the source city/NPC, destination ID/label, native fare and authored XYZ. Only mapped city gatekeepers supply edges; field landings do not invent reverse services. Routes are a bounded candidate family, not globally fastest paths.

`Bot/Travel/JourneyPlanner.js` has no live-world or gameplay effects. Construct one shared planner per process **after** service data is loaded with `JourneyPlanner.create(TownServiceCatalog.rows(TownServiceCatalog.ROLES.GATEKEEPER))`; use authored rows, not the catalogue's live-target resolver. The planner precomputes source-spawn bindings, inter-hop approach distances and the minimum wallet needed for each hop list. No existing vassal duty calls it yet; physical execution and duty integration remain separate work.

The returned `plan(request)` contract is:

- Required: finite XYZ `from`/`to`, positive movement `speed` in units/second, and current nonnegative `adena`. Optional: `karma` (default zero), held `scrollCount` (zero), `remainingFare` (uncapped), `arrival: { xy, z }` (96/128 units), and `allowedModes` (walk/gatekeeper/recall). `walk` controls the direct candidate; every transport itinerary still includes local approaches and a final walk.
- The caller owns goal identity, paid fare, remaining-cap calculation and bounded exclusions across replans. Refreshing the wallet or itinerary must not replenish the original goal cap. Planner inputs are not mutated, and invalid numeric inputs throw rather than manufacture coordinates/funds.
- `exclusions` accepts arrays or sets: `entries` excludes first-access source keys; `sources` excludes a spawn at any hop; `edges` excludes native `npcId:destinationId` offers; `exits` excludes final landing-to-goal access by `x:y:z`. Source keys are `npcId:x:y:z` from the selected gatekeeper leg. Boolean `directWalk`/`recall` exclude those candidates. An exit exclusion does not prohibit using that landing as an intermediate transfer; an entry exclusion does not prohibit later contact with that spawn. Exclusion expiry/retry and diagnostic ownership belong to the future executor.
- Candidates include direct walking, access to at most three nearest nonexcluded city sources, and an available held Scroll of Escape followed by walking or access in its regional town. Karma disables transport. Positive-price hops require at least 50,000 Adena **before each debit**, sufficient fare funds and the remaining total cap; a paid hop may leave less than 50,000, but another paid hop then cannot follow. Free hops and a held recall scroll do not require that threshold.
- ETA uses straight-line 3D distance/current speed, all source/inter-hop/final walks, a 20-second recall cast, one-second native teleport publication and an estimated 1,150 ms gatekeeper dwell. This is not proof of connected terrain. Paid candidates must save at least 30 seconds and 20% versus a nonexcluded direct walk. Within 20% of the fastest eligible ETA, selection prefers lower fare, then fewer hops, then a stable key. An excluded direct walk cannot suppress transport with an optimistic ETA.
- Success is `{ status: 'planned', key, mode, fee, hops, etaMs, legs }`, **not arrival**. Only this selected itinerary materializes `recall`, `gatekeeper` and final `walk` legs. A gatekeeper leg owns its approach as well as payment/teleport; the executor must not also create a duplicate walking leg to that NPC. Walk arrival tolerances do not replace duty polygon/service validation.
- Recall legs carry item `736`, a `landingHint` and `replanOnArrival: true`. Native `TownRespawn.restartCoords(actor)` must resolve the real recall destination; subsequent routing uses actual published arrival with the same goal spending/exclusions. Never dispatch the hint or final duty goal as a synthetic recall. Gatekeeper expected fare/XYZ likewise do not replace live native offer/contact/payment checks.
- With no eligible candidate, the result is `{ status: 'blocked', reason: 'no_permitted_route', legs: [] }`. This is a policy/exclusion/bounded-candidate result, not proof that terrain or the duty destination is unreachable. The planner starts no workers, actions, timers or database operations.

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
