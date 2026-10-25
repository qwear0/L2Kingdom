# World, actors, movement and combat

Read this before changing spatial publication, native actions or effect timing. This covers live execution; retained cold combat models are approximations, not another source of native truth. See the [project map](README.md) and [bot runtime](bot-runtime.md).

## Ownership and reading order

| Anchor | Responsibility |
| --- | --- |
| `src/GameServer/World/World.js` | Session registration, actor/NPC/item presence and spatial queries. |
| `src/GameServer/Model/Creature.js`, `Model/Actor.js` | Creature values/state and publication-aware actor setters. |
| `src/GameServer/Actor/Actor.js` | Session-facing character, inventory, skills, attack and automation ownership. |
| `src/GameServer/Actor/Generics/` | Native character actions used by request handlers and bot adapters. |
| `src/GameServer/Automation.js`, `Timer.js` | Continuing actions and shared timing helpers; not a single global simulation tick. |
| `src/GameServer/Npc/Npc.js` | Native NPC state, behavior and combat timers. |
| `src/GameServer/Effects/` | Effect storage, stacking, expiry and periodic execution. |

`src/NodeL2.js` initializes database/data/geodata/world before opening client listeners. The world owns presence, not every durable row associated with a character.

## Spatial publication and client visibility

1. `World.insertUser` establishes the current session binding; replacing an account retires old actor publication before socket teardown.
2. `Model/Actor.setLocXYZ` batches coordinate publication through `World.updateUserLocation`.
3. `World/CharacterLocationRuntime.js` binds the shared `CharacterLocationIndex.js` used for spatial lookup.
4. Actor lifecycle publication and movement are different events. A location update does not recreate the actor or emit all lifecycle-publication events.
5. `World/ActorVisibility.js` tracks real client recipients, sends appearance/removal and current movement information. `NpcVisibility.js` handles the NPC side.

Registration/current-actor identity guards prevent an old actor from publishing into a replacement session. Sending packets to “nearby users” must respect current online/visibility state, not an arbitrary persisted or observer actor collection.

The [observer](world-observer.md) builds its own cross-world projections and can include saved/offline details. That is not proof that a C4 client has received `CharInfo` or can interact with the actor.

## Movement and asynchronous paths

- `Actor/Generics/MoveTo.js` distinguishes ordinary client-driven player movement from authoritative bot waypoint movement.
- `Actor/Generics/UpdatePosition.js` preserves reported Z and queues persistence. Spatial publication and SQLite durability are separate transitions.
- Vassals/companions and expensive routes can use `Geodata/PathfindingWorkerPool.js`. Results must still match actor identity, route generation, target and current location before application.
- Cancellation invalidates the route generation. A late result must not resurrect an old move after a new command or character switch.
- Vassals explicitly bypass retained low-detail offscreen warp behavior; physical duty movement cannot be inferred from legacy population travel estimates.

`Geodata/GeodataEngine.js` provides bounded, layer-aware pathfinding, height/NSWE checks and line-of-sight smoothing over region data. Direct-route fallback requires line of sight. Missing geodata can nevertheless permit passage and preserve supplied Z, so path success is not proof that every traversed region has valid collision data.

`Geodata/VirtualObstacles/index.js` overlays authored geometry. Resource preparation belongs to [runtime bootstrap](runtime.md); installed region validation is not comprehensive client-navigation acceptance.

## Native attack and skill flow

1. Network request handlers or BotAI select an intended action.
2. `Actor/Generics/AttackRequest.js`, `AttackExec.js`, `Automation.js` and `Actor/Attack.js` resolve approach, target and execution conditions.
3. Native range, resources, equipment, reuse, target restrictions and combat legality remain execution gates. A bot policy preference or LLM suggestion does not bypass them.
4. `Actor/Attack.js` schedules attack/cast stages and applies actual results through creature hit/effect owners. `Skills/C4SkillEffects.js` owns supported native skill effects.
5. Recipient-safe response paths publish animations/status. Request acceptance, launch animation and successful effect outcome are distinct events.

NPCs have their own timer-driven behavior. `World/Generics/RemoveNpc.js` separates corpse decay from reward/respawn handling; respawn timing starts at death, not when the corpse becomes invisible. Do not assume a single tick determines every stage.

## Effects and saved status

- `Effects/EffectStore.js` owns normalized active effects, stacking, limits and absolute expiry.
- `Effects/EffectTicker.js` owns periodic work, expiry processing, stat refresh and recipient-safe notifications.
- `Actor/CharacterStatus.js` saves/restores eligible unexpired non-debuff, non-toggle buffs, not every transient combat condition.
- Character entry restores effects before derived stats/vitals. Changing this order can expose incorrect initial status or duplicate effect application.
- Teardown must invalidate actions/timers and remove current publication rather than leaving callbacks attached to an obsolete actor.

## Update together

For movement/publication changes, inspect Model setters, world indexes, visibility recipients, character switching and asynchronous result fences together. For combat/effects, inspect native action gates, timing, effect ownership, bot feedback and status restoration. Changes to resources also affect [content/catalogue consumers](content.md). Syntax and observer snapshots do not certify real-client movement, collision, hit timing or combat correctness.
