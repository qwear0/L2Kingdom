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

There is no additional configurable vassal cap. SQL clan-capacity triggers count **all** clan members: level 0/1/2/3/4–5 capacities are 10/15/20/30/40. Thus an otherwise empty level-1 clan with its Lord has 14 free member slots. Live party capacity is separate: nine members, at most eight companions beside the player.

## Character ownership, not account or social permission

A vassal belongs to one **character**, with an original `boundClanId`. Another character on the same account, a clanmate or a socially friendly player does not become the owner.

- `VassalService.owns/issueOrder` checks ownership, contact/busy state, gathering area and expected `orderRevision`.
- `Repository.updateVassalDuty` compare-and-swaps the revision. A stale UI or delayed callback must not overwrite a newer order.
- `PartyCompanionService.attach` independently checks ownership, original-clan eligibility, capacity and transaction holds. Failed admission preserves the prior duty.
- `BotAvailability`, `BotTradeService`, chat rules and AI tool execution enforce corresponding owner boundaries; UI filtering is not the sole guard.
- Companion-control UI selects the current leader's members. Being a companion does not authorize remote Castellan orders.
- Party dismissal/leave/disconnect does not erase the ownership record.

`Network/Request/CharDelete.js`, `Database.deleteCharacter` and the owner foreign-key restriction prevent deleting a Lord who still owns vassals.

## Duties and party interruption

`VassalOrders` owns duties; `src/GameServer/Lord/GatherAreas.js` supplies five authored gathering polygon sets. Failure to find a safe target does not authorize hunting outside the assigned area.

Ruins of Despair includes all nine authored ruin spawn polygons, `gludio_t19_22_060` through `gludio_t19_22_068`; their existing XY and height bounds remain authoritative.

Gathering distribution and route recovery stay within that assignment:

- New routes prefer less occupied polygons, counting both live solo gatherers in place and their pinned travel destinations. Party companions, pending post-party rest and town/service phases do not reserve gathering space. Equal occupancy uses actor-specific cyclic ordering rather than always starting at the first polygon.
- No-target relocation prefers another polygon before retrying the current one. Failed travel similarly deprioritizes its polygon while retaining the failed-point cooldown. Other polygons without safe destination candidates are skipped; the current polygon remains a fallback. Useful fights and pinned routes are not periodically interrupted to rebalance occupancy.
- Routes pin an interior destination with room for the arrival radius and geodata-cell rounding. Stopping just outside the polygon, within an NPC's arrival radius, does not count as entering it.
- Navigation reuses bounded waypoint retries. Exhausted routes or 30 seconds without physical progress select another point/polygon and exclude the failed point's 128-unit bucket for five minutes. A gap of more than five seconds between gathering travel ticks resets the stall clock, so time spent in combat, recovery or service work is not credited as continuous travel failure.
- If no safe candidate is available, the duty waits and retries rather than teleporting or changing its assigned area.
- Solo gatherers exclude a stalled combat target for five minutes and finish pending visibility scans before treating a zone as empty.

- Joining the owner's party preserves the assigned gathering area and records pending resumption rather than replacing it with a new autonomous route.
- Separation, including leader disconnect, starts **ten minutes of safe seated rest in place** for interrupted gatherers.
- Threats and trade pause safe-rest accounting. Reinvitation clears live rest; pending rest is repeated after death/restart rather than credited during downtime.
- Explicit newer orders invalidate old continuations. Return/service orders detach companions; non-gather service companions become return duty after separation.
- Solo vassal death revives fully after 12 seconds and returns the actor to Gludio. Companion death follows BotAI's resurrection-wait/town-recovery path instead.
- Losing original-clan eligibility cancels gathering, retains cargo and returns the vassal. It does not silently rebind the vassal to a new clan or resume the old order later.

Known wording mismatch: `CastellanDialog.js` currently says “one minute” in its home text, while `VassalOrders.SAFE_REST_MS` is ten minutes. The implementation value above is the documented contract; the UI wording has not been repaired by this documentation-only change.

## Physical supplies and cargo

Duties execute on live actors and native movement; they do not earn rewards from elapsed offline time.

1. The vassal retains working supplies, equipped/locked items and required reserves.
2. It physically visits Castellan to buy affordable supplies using its own Adena.
3. It visits an ordinary warehouse keeper and deposits eligible cargo plus Adena above 100,000 into the **original bound clan's** warehouse.
4. Order revision, operation epoch, contact and clan-eligibility checks reject stale continuations.

Personal-storage diversion and autonomous redistribution of Lord-led clan stock are excluded. See [economy](economy.md) for transaction and storage ownership.

## Persistence and activation

`Lord/Repository.js` owns `lord_characters`, `vassals` and grant receipts: ownership, clan binding, loadout, duty, area, pending resumption and revision are durable state. Economic commits additionally check current duty and synchronize inventory snapshots.

`BotManager` restores only registered owned vassals. `PopulationService` persists owned actors periodically; `Cooldown` refuses their ordinary cold handoff and `HotActorLodPolicy` keeps owned context active even when the Lord is offline. This is server-running activity, not offline-time simulation. See [persistence](persistence.md).

## Update together

Check Lord services/schema/UI, starter kits, party/chat/tool admission, `VassalOrders`, BotAI, population startup and database economic guards whenever ownership or duty semantics change. Also update root README's player-facing description. Physical routes, duplicate confirmation, clan loss, death/rest and restart behavior require separate gameplay acceptance; observer display alone cannot prove them.
