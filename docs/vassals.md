# Castellan and player-owned vassals

This is the current gameplay ownership boundary, not the historical ambient-bot model. Read it before changing recruitment, party admission, commands or background duties. See the [project map](README.md), [bot runtime](bot-runtime.md) and [economy](economy.md).

## Owners and entrypoints

- `src/GameServer/World/GludioCastellan.js`: Castellan NPC `90002`, at `(-12500, 122816, -3114)` in Gludio; `DataCache.js` includes the definition.
- `src/GameServer/World/Generics/NpcBypasses/Castellan.js` → `src/GameServer/Lord/CastellanDialog.js`: enrollment, clan grant, creation, roster, orders, shop and storage UI.
- `src/GameServer/Lord/CastellanAccess.js`: validates the actual spawned NPC contact and actor availability, including 300-unit XY / 200-unit Z limits.
- `src/GameServer/Lord/LordService.js`, `VassalService.js`, `Repository.js`: grants, character ownership, transactional recruitment and revisioned orders.
- `src/GameServer/Bot/AI/PartyCompanionService.js`: live party attachment/detachment.
- `src/GameServer/Bot/AI/VassalOrders.js`: physical duties, gathering, recovery and continuations.

## Enrollment and recruitment

1. Castellan contact opens character-bound enrollment. Enrollment is once per character, raises the Lord to at least level 20 with a legal first profession and grants an unequipped top-D kit.
2. `StarterKits.js` owns legal level-20 skills, class-compatible gear and supplies. Lord/vassal starting Adena are 1,000,000 / 100,000; created vassals receive level 20 and equipped mid-D gear.
3. Creation requires leadership of an eligible active level-1-or-higher clan. Service entry and queued grant fences recheck contact, inventory/progression and clan state.
4. Confirmation receipts are valid for ten minutes. A successfully committed receipt replays before later expiry/capacity checks; retry must not duplicate a character or grant.
5. A committed result can report publication pending if live restoration fails. Durable success and successful live publication are separate outcomes.

New vassals keep the selected race and sex and receive a random face, hairstyle and hair color from the existing bot appearance ranges (3 faces × 5 hairstyles × 4 colors). Creation prefers combinations not already used by the same owner's vassals of that race and sex; only an exhausted 60-combination pool permits repeats. The choice is committed with the character, so receipt replay, live restoration and restart preserve it. Existing characters are not rerolled.

There is no additional configurable vassal cap. SQL clan-capacity triggers count **all** clan members: level 0/1/2/3/4–5 capacities are 10/15/20/30/40. Thus an otherwise empty level-1 clan with its Lord has 14 free member slots. Live party capacity is separate: nine members, at most eight companions beside the player.

## Character ownership, not account or social permission

A vassal belongs to one **character**, with an original `boundClanId`. Another character on the same account, a clanmate or a socially friendly player does not become the owner.

- `VassalService.owns/issueOrder` checks ownership, contact/busy state, gathering area and expected `orderRevision`.
- `Repository.updateVassalDuty` compare-and-swaps the revision. A stale UI or delayed callback must not overwrite a newer order.
- `PartyCompanionService.attach` independently checks ownership, original-clan eligibility, capacity and transaction holds. Failed admission preserves the prior duty.
- Successful admission preserves the bot's position and starts a physical walk to the leader, including non-vassal and roster admission. Normal distance-based catch-up and stuck-recovery teleports remain enabled before first arrival; initial intertown gatekeeper transit stays disabled. After bounded pathfinding attempts fail, the bot reports it briefly in party chat, using one of ten variants with per-bot deduplication.
- `BotAvailability`, `BotTradeService`, chat rules and AI tool execution enforce corresponding owner boundaries; UI filtering is not the sole guard.
- Companion-control UI selects the current leader's members. Being a companion does not authorize remote Castellan orders.
- Party dismissal/leave/disconnect does not erase the ownership record.

`Network/Request/CharDelete.js`, `Database.deleteCharacter` and the owner foreign-key restriction prevent deleting a Lord who still owns vassals.

The optional [MCP interface](bot-mcp.md) observes existing vassals read-only unless an explicit manual lease is acquired. It grants no lord impersonation or direct duty writes. Authorized duty/party/trade commands preempt manual authority at their native ingress; pending native settlement/publication still returns busy rather than being discarded. Returning to AI uses the current valid duty, never a copied pre-takeover order. P4 typed party/service actions retain native ownership and membership checks; a vassal does not become its lord, and owner-only Castellan services remain unavailable. Reading an issued choice is not permission to execute it, and accepted economic settlement survives authority loss.

## Duties and party interruption

`VassalOrders` owns duties; `src/GameServer/Lord/GatherAreas.js` supplies five authored gathering polygon sets. Failure to find a safe target does not authorize hunting outside the assigned area.

The explicit gathering catalog preserves authored XY/height bounds and derives menu levels from loaded monster templates:

| Destination | Polygons | Monster levels |
| --- | --- | --- |
| Ruins of Agony | 18 verified core polygons | 15–24 |
| Ruins of Despair | 9, unchanged (`gludio_t19_22_060` through `gludio_t19_22_068`) | 19–24 |
| Abandoned Camp | 37 | 17–29 |
| Langk Lizardmen (Gludin) | 26 | 15–25 |
| Wasteland | 99 western, central/eastern and southern surface polygons | 22–36 |

Agony excludes `gludio_t18_21_009`: its two canonical definitions share remote, off-core bounds. Neighboring fields, the separate Langk coastal corridor and underground Wasteland destinations are not implicitly authorized. Coverage is permission to use the selected polygons, not a guarantee of safe targets or walkable routes everywhere.

Independent gatherers physically collect nearby ground Adena and items, including drops originating outside their own group, only while idle inside the assigned area. Recovery, corpse/Sweep work, combat, urgent supplies, unloading and assignment travel take priority over this additional search. It runs before the next monster selection, not as a separate cleanup trip across the whole area. Companions retain their own-group loot policy.

`PartyCompanionService` uses `World/GroundItemIndex` for recovery searches and queued-item lookups. Gather searches run at most once per 3–3.499 seconds, offset by actor ID; other party recovery retains its 500-ms minimum interval. Each pass inspects at most 48 spatial-query steps (including empty cells and rejected candidates), tests at most three foreign-drop area memberships, and selects at most one target within 1200 units. The cursor continues across passes instead of repeatedly checking the start of a dense pile. Fresh own-group NPC drops still enter the physical pickup queue immediately, without waiting for a scan.

Automated pickup targets have a renewable 35-second reservation shared by gatherers and companions; this prevents competing automated approaches, not native player pickup. Invalid orders, actor/party changes, manual control, recovery and duty transitions cannot authorize a stale foreign-drop award. Movement, capacity checks and award outcomes use the existing native pickup path; exhausted routes and rejected awards defer that item for 30 seconds. See [ground pickup outcomes](economy.md#ground-pickup-and-award-outcomes).

The catalog and area-ID lookup compile lazily and are reused while the `DataCache.npcs` / `DataCache.npcSpawns` array identities remain unchanged. Replacing either array recompiles and validates selected IDs, bounds and templates; invalid or ambiguous selected data fails explicitly. Actor suitability, occupancy and destinations are not cached here.

Gathering distribution and route recovery stay within that assignment:

- New routes use live, attackable, unprotected NPC positions with ordinary solo level, power and matchup/survival eligibility. `BotTargetScorer.intrinsicEligibility` shares those scorer gates with ordinary hunting; current-position range/height, visibility, immediate readiness, combat ranking and target retry/claim handling remain in the hunting path. Empty or hard/protected-only polygons have no independent centre fallback.
- Selection starts at the actor's actual current position. Within the eligible recovery tier, find the nearest eligible point at distance `dMin`, then consider only points within `dMin + 512` XY units. This fixed internal tolerance is not a setting. Rank that local group by occupancy, exact distance, actor-specific cyclic polygon order, then numeric X/Y/Z. A much farther empty sector cannot win on occupancy alone; XY proximity is not a shortest-walkable-route guarantee.
- Identical XYZ destinations are deduplicated without merging merely nearby points or different heights. Occupancy counts each eligible same-assignment gatherer once across a candidate's containing polygons, using its pinned destination point before arrival or actual position otherwise. An overlapping polygon alias cannot make that territory appear empty. Party companions, pending post-party rest and town/service phases do not reserve gathering space.
- No-target relocation and failed travel first prefer eligible points physically outside the avoided polygon; still-unblocked points inside it remain a fallback. This recovery tier can justify a farther destination, but neither another polygon alias nor fallback bypasses an active point cooldown. Useful fights and pinned routes are not periodically interrupted to rebalance occupancy.
- Selection runs only at destination/retry events. It visits the assignment's existing NPC-grid cells plus neighboring cells, filters exact XY/Z membership before expensive eligibility, and stops eligibility evaluation beyond the nearest local band. Actor profiles and the other-gatherer snapshot are selection-local, not per-tick scans or persistent target caches.
- Routes pin an interior destination with room for the arrival radius and geodata-cell rounding. Stopping just outside the polygon, within an NPC's arrival radius, does not count as entering it.
- Independent travel uses the shared [journey planner/executor](bot-runtime.md#journey-planning-catalogue): walk, held ordinary Scroll of Escape to the native regional destination, and catalogue-backed gatekeeper hops paid from the vassal's Adena. Each positive-price hop requires at least 50,000 Adena before payment and an affordable fare; the hop may leave less than 50,000, preventing another paid hop. Free hops/held scrolls remain available below the threshold. Intermediate native landings are not assignment arrival; the original destination/polygon remains pinned.
- Navigation reuses bounded waypoint retries. Repeated final-navigation failures or 30 seconds without physical progress on the active final walk first exclude that direct/landing access, not the duty point. Only exhausted bounded final-access alternatives allow point/polygon reselection and a five-minute exclusion of the failed point's 128-unit XY bucket under every containing polygon. Worker/resource, missing-transport and policy blocks do not blacklist the point. All aliases are checked on selection; polygon height containment scopes the keys rather than an XY-global block across floors. Longer watchdog blocks are never shortened. Non-final legs, explicit transport waits and priority interruptions reset the consecutive-walk clock; gaps above five seconds also reset it.
- Local route retries wait when no safe candidate is available and never change the assigned area. Prolonged physical stalls additionally use the farming recovery below.
- Solo gatherers exclude a stalled combat target for five minutes and finish pending visibility scans before treating a zone as empty.

- Joining the owner's party preserves the assigned gathering area and records pending resumption rather than replacing it with a new autonomous route.
- Separation, including leader disconnect, starts **ten minutes of safe seated rest in place** for interrupted gatherers.
- Threats and trade pause safe-rest accounting. Reinvitation clears live rest; pending rest is repeated after death/restart rather than credited during downtime.
- Explicit newer orders invalidate old continuations. Return/service orders detach companions; non-gather service companions become return duty after separation.
- Solo vassal death revives fully after 12 seconds and returns the actor to Gludio. Companion death follows BotAI's resurrection-wait/town-recovery path instead.
- Losing original-clan eligibility cancels gathering, retains cargo and returns the vassal. It does not silently rebind the vassal to a new clan or resume the old order later.

### Farming stall recovery

`VassalOrders.farmWatchdog` counts five minutes of observed autonomous gather-duty work without 96 units of horizontal displacement or an experience change. It also covers physical supply/town legs of that order. Replans, target changes and polygon rotation do not reset the clock. Combat, casting, seated recovery, post-party rest, owner trade, transaction/operation holds, unaffordable supplies and inventory-blocked work do not count. Asynchronous route-cost estimation, queued navigation, bounded resource/retry waits, NPC slots/interaction dwell, pending native teleport/recall and unresolved-payment holds also pause accounting; waiting for an eligible gathering destination does not count as a physical stall. A failed selection keeps the assignment, exposes `no_safe_gather_destination` and retries at most once per 30 seconds. The wait clears the elapsed physical-stall clock without replenishing recovery attempts; no-target hunting and level-ineligible assignments also pause accounting. Other idle duty work can still count without a movement request. Gaps longer than five seconds are not credited as work; journey replans never renew recovery attempts.

- Recovery cancels the old movement/loot queue. In a recognized town (`TownTransitPolicy.townAt`, including actual service-spawn proximity), it only replans local navigation: no Scroll of Escape or skill `2099`, no phase/destination reset, and no replenished journey fare cap or cleared route exclusions. This counts toward the same three-attempt allowance and reports `farm_recovery_town_replan`.
- Outside towns, recovery casts a paid ordinary Scroll of Escape (20 seconds), or native skill `2099` (five minutes) when no scroll is held. A scroll is spent at cast start, including interrupted attempts, matching the existing bot travel payment rule. It is not a synthetic relog or a free instant teleport.
- Recall uses `TownRespawn.restartCoords`, including regional karma destinations. Actor/order/party/clan eligibility, combat, trade and cast interruption fences protect completion. A new order cancels the old continuation.
- Arrival resumes town supply/cargo processing and the same saved gathering assignment. The failed source's 128-unit destination bucket is avoided for 30 minutes.
- At most three recovery starts (including town replans) are allowed without an experience change. Further stalled work holds with `farm_recovery_exhausted_new_order_required`; defense remains available. Experience progress or an explicit new order renews the allowance. The watchdog is live-session state, not downtime credit or a persisted retry ledger.
- Bot detail exposes the state, elapsed work, attempts, last method/source and duty status in `movement.farmRecovery` even when developer movement traces are disabled. `movement.journey` separately exposes destination, current route/leg, keeper/destination label, hop position, planned/paid fare and wait/failure reason; the observer inspector/profile displays this summary.

Known wording mismatch: `CastellanDialog.js` currently says “one minute” in its home text, while `VassalOrders.SAFE_REST_MS` is ten minutes. The implementation value above is the documented contract; the UI wording has not been repaired by this documentation-only change.

## Idle waiting near Castellan

Service-duty vassals choose a random supported surface 60–213⅓ units around Castellan, walk there through normal navigation and sit on arrival. The chosen destination stays fixed during the approach; failed routes or 30 seconds without local progress discard it and retry after a staggered 30–35-second delay. Surface sampling is bounded, routing uses the existing navigation recovery/worker budgets, and seated waiting performs no repeated destination searches or world-wide occupancy scans. Combat, recovery, owner trade and new orders retain their existing priority. Clan-ineligible vassals use the same seated waiting behavior while retaining cargo and the clan-ineligibility reason.

## Physical supplies and cargo

Duties execute on live actors and native movement; they do not earn rewards from elapsed offline time.

1. The vassal retains working supplies, equipped/locked items and required reserves.
2. It physically visits Castellan to buy affordable supplies using its own Adena.
3. It visits an ordinary warehouse keeper and deposits eligible cargo plus Adena above 100,000 into the **original bound clan's** warehouse.
4. Order revision, operation epoch, contact and clan-eligibility checks reject stale continuations.

Personal-storage diversion and autonomous redistribution of Lord-led clan stock are excluded. See [economy](economy.md) for transaction and storage ownership.

## Persistence and activation

`Lord/Repository.js` owns `lord_characters`, `vassals` and grant receipts: ownership, clan binding, loadout, duty, area, pending resumption and revision are durable state. Economic commits additionally check current duty and synchronize inventory snapshots.

`BotManager` restores only registered owned vassals at their saved character coordinates. Lifecycle JSON also retains sitting/standing posture, heading, recovery mode and completed service-duty waiting, fenced by the current order revision. Restoration happens before world publication. Completed waiting within the waiting ring does not repeat the arrival journey: the vassal keeps its saved position and heading and waits seated. Legacy centre positions or positions outside that ring go through normal waiting-place selection. Missing legacy posture metadata uses the normal duty initialization; it cannot reconstruct a previously unsaved pose. Post-party gather interruptions still repeat their full safe-rest interval after restart.

`PopulationService` persists owned actors every 30 seconds and makes a fresh final pass during graceful shutdown after any admitted periodic pass settles. Forced termination can only recover committed state. `Cooldown` refuses their ordinary cold handoff and `HotActorLodPolicy` keeps owned context active even when the Lord is offline. This is server-running activity, not offline-time simulation. See [persistence](persistence.md).

## Update together

Check Lord services/schema/UI, starter kits, party/chat/tool admission, `VassalOrders`, BotAI, population startup and database economic guards whenever ownership or duty semantics change. Also update root README's player-facing description. Physical routes, duplicate confirmation, clan loss, death/rest and restart behavior require separate gameplay acceptance; observer display alone cannot prove them.
