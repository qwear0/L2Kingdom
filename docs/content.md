# Authored resources, catalogues and progression services

Read this before adding game data, regenerating exports or changing NPC/quest/progression behavior. The resource tree describes this emulator's implemented content, not certified complete historical C4 coverage. See the [project map](README.md).

## Source categories and consumers

| Category | Source / producer | Runtime consumer |
| --- | --- | --- |
| Templates, items, skills, NPCs, spawns and rewards | Relevant JSON under `data/` | `src/GameServer/DataCache.js` and specific loaders |
| Native NPC skill definitions | Registered area/template rows | `src/GameServer/Npc/NpcSkills.js` |
| NPC HTML and bypass actions | `data/Html/`, dynamic service windows | `World/Generics/NpcTalk.js`, `NpcTalkResponse.js`, `NpcBypasses/` |
| Second-profession trials | `data/Templates/second_profession_trials.json` | `SecondProfessionCatalog.js`, `SecondProfession.js` |
| Clan-hall definitions | `data/ClanHalls/catalog.json` | `ClanHall/Policy.js`, repository and runtime |
| Generated knowledge exports | `scripts/generate-knowledge-base.js` → `data/KnowledgeBase/` | Native knowledge UI and WorldObserver |
| Downloaded geodata | Bootstrap → ignored local region files | `Geodata/GeodataEngine.js` |
| Durable world/history | SQLite owners, not authored resources | [Persistence flow](persistence.md) |

Paths without a full prefix in the consumer column are under `src/GameServer/`.

`DataCache.init` explicitly composes resources. Adding a file alone does not necessarily register it. Schema-validation warnings do not universally abort loading: `validateModel` can return the resource after warning. Loading also expands third-class templates, merges NPC AI and applies local boss/minion balancing.

`World/Generics/SpawnNpcs.js` joins templates to spawn definitions. Counts apply at each explicit coordinate, or to random placements inside configured bounds. Day/night and quest-exclusive definitions affect occupancy; definition counts are not live population counts.

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
