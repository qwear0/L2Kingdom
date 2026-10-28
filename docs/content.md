# Authored resources, catalogues and progression services

Read this before adding game data, regenerating exports or changing NPC/quest/progression behavior. The resource tree describes this emulator's implemented content, not certified complete historical C4 coverage. See the [project map](README.md).

## Source categories and consumers

| Category | Source / producer | Runtime consumer |
| --- | --- | --- |
| Templates, items, skills, NPCs, spawns and rewards | Relevant JSON under `data/` | `src/GameServer/DataCache.js` and specific loaders |
| Native NPC skill definitions | Registered area/template rows | `src/GameServer/Npc/NpcSkills.js` |
| NPC HTML and bypass actions | `data/Html/`, dynamic service windows | `World/Generics/NpcTalk.js`, `NpcTalkResponse.js`, `NpcBypasses/` |
| Native gatekeeper destinations and ordered offers | `data/Teleports/gatekeepers.json` | `World/C4GatekeeperTeleports.js` → native menus/service, travel and spawn-access roots |
| Second-profession trials | `data/Templates/second_profession_trials.json` | `SecondProfessionCatalog.js`, `SecondProfession.js` |
| Clan-hall definitions | `data/ClanHalls/catalog.json` | `ClanHall/Policy.js`, repository and runtime |
| Generated knowledge exports | `scripts/generate-knowledge-base.js` → `data/KnowledgeBase/` | Native knowledge UI and WorldObserver |
| Downloaded geodata | Bootstrap → ignored local region files | `Geodata/GeodataEngine.js` |
| Durable world/history | SQLite owners, not authored resources | [Persistence flow](persistence.md) |

Paths without a full prefix in the consumer column are under `src/GameServer/`.

`DataCache.init` explicitly composes resources. Adding a file alone does not necessarily register it. Schema-validation warnings do not universally abort loading: `validateModel` can return the resource after warning. Loading also expands third-class templates, merges NPC AI and applies local boss/minion balancing.

`World/Generics/SpawnNpcs.js` joins templates to spawn definitions. Counts apply at each explicit coordinate, or to random placements inside configured bounds. Day/night and quest-exclusive definitions affect occupancy; definition counts are not live population counts.

### Native gatekeeper catalogue

- `data/Teleports/gatekeepers.json` is the sole authored source for `World/C4GatekeeperTeleports.js`. The root has exactly two nonempty arrays: `destinations: [{ id, locX, locY, locZ, price }]` and `gatekeepers: [{ npcId, routes: [{ destinationId, label }] }]`; each route array is nonempty. Labels belong to offers, while XYZ and the Adena price belong to destinations. Route order is menu order. Cruma, Seven Signs, clan-hall, quest and diamond catalogues remain separate.
- Plain `require` loads and validates once per module instance/process, without DataCache, world/database access or live NPC resolution. The existing `jsonschema` dependency checks `data/Teleports/.schema.json`; missing/extra fields, wrong types, empty arrays and out-of-range numbers throw rather than warn. IDs are integers in `[1, 9007199254740991]`, prices in `[0, 9007199254740991]`, and XYZ in `[-2147483648, 2147483647]` (signed int32 packet bounds, not terrain limits).
- Local linear passes reject duplicate destination IDs, duplicate NPC IDs, duplicate offers within an NPC and references to undefined destinations. Different NPCs may offer the same destination with different labels. Unreferenced definitions are retained: `1003` is defined but not offered and does not create an access root. Standard JSON parsing does **not** detect repeated raw member names (such as two `price` fields); uniqueness checks apply to records/offers after parsing.
- Labels must contain non-whitespace text. They are rendered unchanged in both HTML text and `msg="811;..."`; double quotes, `<`, `>`, `&`, `;`, C0/C1 controls (U+0000–U+001F, U+007F–U+009F) and U+2028/U+2029 are rejected. Apostrophes and parentheses remain allowed; labels are neither trimmed nor sanitized. Failures identify the resource and offending record/index where available, with bounded detail; no partial export or inline fallback is published.
- The loader compiles the original ordinary-object/tuple shapes and preserves `destination`, `html`, `menu` and mutable `.lists`, including per-NPC list replacement and existing request coercion/raw-key behavior. Validation covers authored initial data, not subsequent in-memory mutations. Current integer NPC keys still enumerate numerically, preserving provider traversal and equal-cost route selection. No new validation or I/O runs on bot ticks or individual lookups.
- `Bot/Travel/TravelRoutes.js` still builds and caches city routing using `GATEKEEPER_TOWNS`; `Bot/Economy/TownServiceCatalog.js` derives gatekeeper IDs from `.lists`. `Geodata/SpawnPlacement.js` derives access roots from **offered** routes, including non-city providers, not all destination definitions. New providers also require NPC/template/spawn registration, and new city providers require a `GATEKEEPER_TOWNS` entry; editing JSON alone is not a topology/registration workflow.
- Apply authored changes only through a separately authorized game restart so module and dependent caches rebuild together; there is no hot reload. Structural validation does not certify live NPC availability, cross-resource registration, geodata reachability or gameplay. Native contact/payment/dispatch ownership remains in `World/GatekeeperService.js` as described [below](#quest-and-npc-ui-flow).

### Accessible monster placement

- `Geodata/SpawnPlacement.js` prepares shared pools for random territories before world population, including inactive day/night definitions. It samples actual geodata layers inside the polygon and its Z range, not the surface closest to `maxZ`. Pools contain up to 128 packed XYZ points, drawn without replacement within each cycle; ordinary respawns do not run pathfinding.
- Connectivity starts at authored gatekeeper/Cruma/Seven Signs destinations and character-start positions, then extends through selected already-proven random/fixed points. All definitions, including fixed-only and inactive definitions, may supply `spawnAnchors: [{ locX, locY, locZ }]` for additional **known player-accessible** entry points/floors. These are collected before random filtering and audited individually. A polygon centre, an existing monster, the lowest layer or the largest connected surface is not automatically a trusted anchor.
- `Geodata/SpawnSurface.js` reads all layers and verifies reciprocal NSWE/height transitions against real region data and virtual obstacles. It validates both direct connections and bounded native pathfinder results; missing geodata is not evidence of accessibility. The fast path retains at most 4,096 XY draws for 512 sampled cells and an initial 12-search allowance. Empty or inadequate pools receive deterministic cell-centre enumeration, in stable X/Y order, with bounded resident candidate windows. Sparse discovery is distinct from connectivity and adequacy. Only completed enumeration with all in-polygon cells decoded and no admissible layer permits `no_layer_in_z_interval`; unavailable/malformed/obstacle-masked cells retain `surface_unavailable` instead.
- Automatic pool admission requires at least `min(128, declared random slots sharing the pool)` distinct XY cells and at least 25% of the polygon bounding-box span on each axis whose span is 256 units or greater. A one-cell pool is unsuitable for multiple slots. Counts and extents do not certify the intended encounter area/floor: flagged cases need an explicit content decision, not an implicit small-area exception. Runtime selection and the profiler use the same admission rule; no unchecked fallback is available.
- Preparation uses coarse XY indexes (with Z retained in strict proof identities), a deduplicated target queue and remembered source/target failures. A newly admitted relevant proof can wake an unresolved target; there are no repeated full-world retry rounds. Random and normalized-cell/layer fixed targets share renewable work windows: reaching an aggregate search/walk/scan quota continues on the same stack without discarding proofs, scanner positions or per-target counters. Time, RSS and capacities remain hard global stops. Exhaustion of a per-target or hard limit is `budget_exhausted`, never proof of inaccessibility. See [numeric limits and diagnostics](operations.md#offline-territory-profiling).
- `Geodata/SpawnPlacementCache.js` v2 persists random pools, admission/failure state, selected trusted entries and fixed local/global proof rows with complete definition/coordinate/slot references in `tmp/cache/spawn-placement.json` (under `L2NODE_RUNTIME_DIR` when set). Its global fingerprint covers the effective ordered definitions, monster classification, resolved initial roots, actual region contents/names and placement/surface/navigation/obstacle source. V1, checksum/shape/coverage/capacity/identity mismatches and read failures cause recomputation. Warm reuse loads both proof classes without connectivity searches or fixed local re-audits. Unknown/invalid results retain their reasons and are not readiness certificates.
- Cache writes validate coverage and capacity, use a unique same-directory temporary file, fsync and atomic rename, and recheck inputs before publication. Ordinary cache write failure leaves computed in-memory pools usable; a hard preparation stop prevents normal cache publication and `SpawnNpcs` rejects world initialization before NPC publication. An early inventory stop also rejects initialization instead of opening a budget-starved world. Caches are derived artifacts, not world persistence. An accepted offline cache must separately be published to the effective runtime path with matching final inputs; profiling does not authorize active-cache replacement or game operations.
- Empty/inadequate pools are cached and logged by territory ID; lack of a proof is not a claim that no route exists. Affected slots remain in a world-owned deferred queue, retried in batches of at most 16 per minute with world-instance and day/night revision fences. A navigation revision invalidates in-memory admission without triggering synchronous preparation on a spawn/AI tick. Correct data or evidenced anchors and reprepare through an authorized lifecycle/offline operation; unchanged unresolved caches do not retry expensive work automatically. There is no live file reload or per-tick scan of live monsters.
- Fixed authored coordinates retain their XYZ, including dungeon floors and special NPCs; fixed population/respawn behavior is not rewritten by the proof cache. Preparation inventories every positive-count fixed monster coordinate and audits its nearest support and reciprocal cardinal exit. Diagnostic global routes from admitted proofs share a separate finite search allowance; exhausting it leaves explicit unknown witnesses rather than starving random-pool retries or blocking startup. Fixed targets join the proof queue after random fast attempts. Global work may coalesce coordinates only on the same normalized 16-unit cell/layer; local audits and all references remain separate. `proven`, `unknown` and local-invalid results are reported distinctly. Only complete successful fixed coverage meets offline acceptance; unresolved content still needs targeted correction.
- `World/RaidBossMinionManager.js` checks nearby positions by following the leader's surface, rather than copying its Z onto arbitrary XY. `SpawnPlacement.nearLeader()` resolves the real layer nearest the leader's Z before applying strict movement checks: an authored fixed-spawn height is a floor-selection hint, not a movement step capped at 64 units. It does not change the leader's coordinates or skip a blocked nearest layer in favour of another floor. After bounded offset attempts it can use the resolved surface at the leader's XY in a tight room. Missing geodata or a blocked nearest layer defers creation: raids keep their existing replenishment policy, while ordinary groups retry only never-created members once per minute, not killed members. Despawn/replacement and world resets fence these retries.
- Cold preparation can be expensive and increase region loading; it has a 900-second wall limit and a 3,072 MiB observed RSS stop. Work-window continuation occurs before game readiness, not in bot/respawn ticks; it does not add a background whole-world retry scheduler. A cache hit still hashes final inputs and normalizes initial roots, but does not repeat random/fixed connectivity or fixed local audits. The management deadline remains 30 minutes for complete startup; this preparation limit does not extend it. See the [offline profiling command](operations.md#offline-territory-profiling) for isolated outputs. Steady-state territory placement is a cached selection; minions retain their bounded local checks. Server-geodata connectivity does not certify client collision or complete coverage. Syntax checks and bounded subsets are not full-world offline or real-client acceptance.

## Generated content versus hand-authored policy

- `scripts/lib/generate-c4-monster-location.js` consumes revision-pinned upstream SQL/XML under `tmp/vendor/l2j-lisvus` and emits related NPC/spawn/reward/skill/item resources.
- Individual generators also encode local emulator choices; importing upstream data is not proof of unchanged retail behavior.
- `scripts/generate-c4-pets.js` produces pet-related resources with explicit local exclusions/policies.
- `scripts/` contains several other resource generators. Inspect the concrete input/output set before rerunning one; it can overwrite authored or previously generated definitions.
- `data/Geodata/` is downloaded local state, not committed authored JSON.

Do not edit a generated export to make a runtime rule appear changed. Fix the owning resource/rule and regenerate the appropriate derived outputs when that operation is part of the task.

## Knowledge-base contract

`generate-knowledge-base.js` deliberately uses public default configuration rather than private/shared settings or a launcher's selected progression rate. It produces five files: `items.json`, `mobs.json`, `skills.json`, `spawns.json` and `manifest.json`.

The generator validates references, records duplicate-definition selection matching first-loaded runtime lookup, includes public progression profiles and hashes outputs. Reward projections have same-level solo assumptions; they are not a prediction for every party/level penalty. Reachable definitions and minion relations are not geographic/client acceptance.

Consumers:

- `src/WorldObserver/KnowledgeBaseService.js`: cached browser catalogue service.
- `src/GameServer/World/Generics/NativeKnowledgeBase.js`: native-client knowledge windows.
- `src/GameServer/Knowledge/GameDataCatalogue.js` and adapters: distinguish native/exported origins, unavailable versus available-empty results and planner-selected relations versus potential definitions.

Some optional exported relations need a supplied native catalogue. Preserve those availability distinctions rather than silently treating missing data as an empty authoritative answer. Exports describe gameplay data; they do not govern live combat or prove a spawn is alive.

`npm run check:knowledge-base` compares expected output bytes without writing exports. `npm run generate:knowledge-base` writes them. Neither is a gameplay test; see [operations](operations.md).

## Quest and NPC UI flow

1. `Quest/QuestRegistry.js` distinguishes active entries, disabled entries with reasons and helpers. JS and declarative definitions can both participate; registration is not universal quest completeness.
2. `Quest/QuestService.js` serializes session mutations and validates quest/NPC/event membership.
3. `Quest/QuestStep.js` delegates compare-and-swap state, hand-in and reward application to `Database.applyQuestStep`; callers still own the preceding conditions.
4. `NpcTalk.js` prioritizes service menus and preserves merchant/gatekeeper quest branches before falling back to static `data/Html/<selfId>.html`.
5. `NpcTalkResponse.js` routes quest events, links and dynamic bypasses. NPC interaction sends `ActionFailed` where needed to release client interaction state.

**Secret Meeting pilot (Q11/Q12):** both quests are active in `QuestRegistry.js`, adapted from Mobius C4 snapshot `a4c31517cd0c428783650e008e199f2ac42a8434`. New acceptance requires level 74 or above; existing started states retain their meaning. Each quest delivers one distinct Munitions Box (`7231` / `7232`) and completes once for a base 79,761 EXP / 0 SP, scaled by the existing quest reward policy. `QuestStep.apply` couples supply issuance and final item consumption/reward with their state transitions; missing items or stale conditions cannot pay a reward.

- Cadmon (`8296`), Helmut (`8258`) and programmatically supplied Leon (`8256`, `World/C4LateTownGatekeepers.js`) keep their existing native definitions/placements. `data/Html/8256.html` preserves Leon's shop and exposes his quest branch; Helmut's existing page is unchanged.
- Wahkan (`8371`) and Naran Ashanuk (`8378`) are noncombat residents in `data/Npcs/c4_quest_content.json`, with fixed spawns in `data/Npcs/Spawns/c4_quest_content.json`. Both boxes belong to the already-loaded `data/Items/Others/others.json`. No new loader, personal NPC, kill event or alliance-service implementation is implied. Registry/data readiness is not real-client or live-placement acceptance.

`World/GatekeeperService.js` owns common catalogue-backed gatekeeper payment/dispatch for the native player bypass and independent vassal journeys. Gathering/return/service duties use the executor; final supply and warehouse contact retains its existing local approach. `NpcBypasses/GatekeeperTeleport.js` retains the menu, karma refusal and insufficient-Adena messages, but now resolves the actual `activeNpcTalk.objectId` through `NpcObjectIndex` and requires a living matching NPC, actor/action availability, at most 300 XY / 200 Z distance and native line of sight before any payment. A previously opened dialog/template ID alone is not authority. Price/destination XYZ come from `C4GatekeeperTeleports.destination`, not a caller estimate. Human players do not inherit the executor's 50,000-Adena threshold or duty fare cap. Accepted dispatch carries a native sequence; it is not physical arrival. Native payment/position persistence remains non-atomic across crashes.

The optional [MCP adapters](bot-mcp.md#issued-choices-and-native-service-outcomes) expose selected native default/quest/warehouse/gatekeeper pages as bounded untrusted text and issued choices, never raw bypass inputs. Reading is passive; typed contact/onTalk can advance a quest. A quest receipt's selected before/after state is not a reward-transaction acknowledgement. Gatekeeper receipts distinguish fare, dispatch sequence and actual native arrival; selected trainer purchase remains unavailable rather than substituting autonomous training reconciliation.

NPC IDs, quest registration, state transitions, item templates, events and HTML actions must change together. Follow the source-adjacent [HTML UI kit](../src/GameServer/World/Generics/HTML_UI_KIT.md): custom native windows use compact/paginated content and existing client textures, not arbitrary browser HTML.

## Progression and service boundaries

- `ClassProgression.js` owns lineage/third-template expansion.
- `ClassTransfer.js` owns legal level-20/40/76 transfer checks, persistence and skill/stat/client refresh.
- `World/Generics/NpcBypasses/ChangeClass.js` retains level-based transfer access. Second-profession trials are an additional route, not universally mandatory.
- `SecondProfession.js` validates nearby master, race/class and marks; its database completion and post-commit refresh distinguish committed success from client publication, avoiding a second charge on retry.
- `Pets/PetRules.js`, `PetRuntime.js` and `PetInventory.js` apply local pet rules and integrate generated data with durable state.
- `RaidBossBalance.js` applies the local 0.75 boss/minion template scaling. `World/RaidBossState.js` persists respawn state; minion definitions have their own manager/JSON consumer.
- `ClanHall/Runtime.js` merges authored hall definitions with persisted auction/ownership state. The catalogue is not ownership authority.
- `Manor/ManorData.js` supplies seed/harvest rules used by actor/NPC paths; its existence does not establish a complete castle-manor system.

## Update together

Resource changes require checking explicit loaders, related templates/rewards/skills, native UI and derived catalogue exports. Quest/progression changes require registration, database transitions, replay/refresh behavior and both alternate menus. Content, client texture/rendering and real gameplay availability need separate acceptance; schema warnings or catalogue presence do not certify them.
