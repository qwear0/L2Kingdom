# World, actors, movement and combat

Read this before changing spatial publication, native actions or effect timing. This covers live execution; retained cold combat models are approximations, not another source of native truth. See the [project map](README.md) and [bot runtime](bot-runtime.md).

## Ownership and reading order

| Anchor | Responsibility |
| --- | --- |
| `src/GameServer/World/World.js` | Session registration, actor/NPC/item presence and spatial queries. |
| `src/GameServer/Model/Creature.js`, `Model/Actor.js` | Creature values/state and publication-aware actor setters. |
| `src/GameServer/Actor/Actor.js` | Session-facing character, inventory, skills, attack and automation ownership. |
| `src/GameServer/Actor/PlayerAutoFight.js`, `Actor/PlayerActionOwner.js`, `Actor/PlayerAutoFightPolicy.js` | Connected-player bounded hunting/recovery, explicit native-action ownership and temporary companion initiation constraints; not bot identity. |
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

- `Actor/Generics/MoveTo.js` distinguishes ordinary client-driven player movement from authoritative waypoint movement. Explicitly owned player auto-fight actions reuse the native worker/waypoint path without bot identity, low-detail warps or town-errand fallback.
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

## Connected-player auto-fight: P2 bounded hunting

- Entrypoint: `.autofight` or `.menu` → `World/Generics/NpcBypasses/PlayerAutoFight.js`. Stock HTML/HtmlKit uses actor-bound epochs and consumed page revisions; no client patch or native-menu negotiation is required. Closing HTML does not stop a run; reopen it for Stop/status.
- Setup requires an explicitly recorded zone center **and** rest point. Radius is 300, 600 (default) or 900 units. New session clears both points; Start/Stop preserves them. Rest-to-center and Start-to-center distances must not exceed 3000 units. There is no moving anchor, implicit point or fallback rest location.
- States are seeking, fighting, returning to rest, resting and returning to zone. A 250 ms timer performs bounded encounter/acquisition scans at most every 500 ms; healthy native movement/casts are retained. Player recovery latches below 35% HP or 20% MP and resumes at 95% of both. Party members use existing `RestPolicy` low/locked thresholds and role-dependent mana rules. Recovery survives defensive interruptions and blocks new party pulls before travel/sitting.
- New targets must be live ordinary monsters in the fixed circle, within 64 Z units, without a foreign native claim/target. Summons, raid bosses and protected minions are not acquired. Already engaged targets may continue to radius + 200; live attackers can be defended against up to 1200 units from the center. An out-of-envelope or unsupported attacker keeps the encounter active and prevents sitting/new acquisition; status exposes the wait. No kill, return, target inspection or add expands the circle.
- Encounter completion includes current party/summon aggro and recent hits, native accepted claims, in-flight swings/casts and summon hit timers, not merely primary-target death or availability of an executable skill. Spatial queries are bounded around current members; dead/removed/replaced NPC objects cannot retain engagement by ID alone.
- The player uses basic attacks plus at most one explicitly allowed learned single-target damage/drain/blow skill. Reuse, MP, weapon/items/charges and effect restrictions are checked before choosing it; basic attacks are the fallback. A bow additionally needs physical arrows and its native MP cost. No executable action produces a visible wait, not a fabricated success. Player skill whitelists, automatic player support/summon orders, pickup and saved preferences remain later-phase work.
- `PlayerAutoFightPolicy` temporarily constrains companion designated pulls, tank fallback acquisition and native offensive initiation without rewriting saved pull settings or detached vassal duties. `PartyAwareness.leaderCombatTargetId` reads the controller's committed combat target, not an inspected object. Native melee/skill expansion, including `Npc/SpoilSweep.js` utility casts, is checked as a whole before spending resources: an illegal polearm/AoE/Spoil Festival secondary victim rejects initiation. This is an initiation guarantee, not selective AoE immunity: an accepted cast retains native impact expansion, including world changes during flight, independently of recovery/Stop. Routine buffs, charge preparation and non-emergency Recharge are suppressed during recovery; native heals and defensive actions remain available.
- `PlayerActionOwner` fences run/action replacement through queues, asynchronous lookups, approaches and path callbacks. Automatic selection uses `selectionOnly` and execution retains its explicit target. Owned skills enter native execution without waiting for a future `ValidatePosition`. Existing equipment, reuse, resources, timing, interruption and effects remain authoritative.
- Owned movement uses the existing geodata worker and authoritative waypoints, without bot identity, low-detail warps or town-errand fallback. Worker routes are rejected before publication if longer than 6000 units, above 60 seconds estimated travel, outside the chase envelope, or containing a Z step over 64. Travel/no-progress deadlines are finite (5–90 seconds overall; 5 seconds without 16-unit progress). Arrival requires actual proximity/layer and target line of sight. A fixed rest/zone route gets one initial attempt and one retry, then a visible `path_blocked` wait until Stop/Start and optional point correction. Unreachable hunting candidates are suppressed for 30 seconds. Defence remains available in a wait; there is no alternate-point sitting. Existing missing-geodata limitations still apply; automated jumps/drops are not implemented.
- Rest timeout counts only safe, seated recovery at the stored point, not travel, combat, defensive interruptions or downtime. Six eligible hours without recovery stops with `recovery_timeout`.
- During owned movement, server progression owns XY; nearby passive reports may update heading/floor Z but cannot rewind/complete the route. Passive `StopMove` does not take control. Explicit manual movement/combat, second-click actions, pickup, sit/stand and summon commands stop the run before their normal action. First-click inspection remains selection-only. No special Esc behavior is promised.
- Start replaces unlaunched stored/queued requests. Stop removes only owned future requests/movement; it does **not** blanket-clear native attack timers. Already accepted swings/casts finish under native interruption rules, without automatic player repeats. Their completion can release a queued manual command and must not clear newer action flags. Stop retains points/skill/radius in memory; death, teleport, teardown, logout/restart or character replacement clear points and skill. No run automatically resumes or persists to SQLite.

Verification remains source/syntax only. P2 was explicitly authorized with the P1 C4-client evidence gap accepted; selection, casts, physical routes, Stop/takeover and ordinary movement still need separately authorized client acceptance. Existing hard-coded 11-entry/unknown-12 assertions in `tests/test_native_menu.js` remain stale; tests are not changed or executed under the current authorization.

## Effects and saved status

- `Effects/EffectStore.js` owns normalized active effects, stacking, limits and absolute expiry.
- `Effects/EffectTicker.js` owns periodic work, expiry processing, stat refresh and recipient-safe notifications.
- `Actor/CharacterStatus.js` saves/restores eligible unexpired non-debuff, non-toggle buffs, not every transient combat condition.
- Character entry restores effects before derived stats/vitals. Changing this order can expose incorrect initial status or duplicate effect application.
- Teardown must invalidate actions/timers and remove current publication rather than leaving callbacks attached to an obsolete actor.

## Update together

For movement/publication changes, inspect Model setters, world indexes, visibility recipients, character switching and asynchronous result fences together. For combat/effects, inspect native action gates, timing, effect ownership, bot feedback and status restoration. Changes to resources also affect [content/catalogue consumers](content.md). Syntax and observer snapshots do not certify real-client movement, collision, hit timing or combat correctness.
