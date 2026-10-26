# Inventory, trade, crafting and storage

Read this before moving items/Adena, changing custody or reusing a transaction API. There is no universal “all economy operations are atomic” contract. See the [project map](README.md), [persistence](persistence.md) and [vassal ownership](vassals.md).

## Mutation owners

- `src/GameServer/Actor/Backpack.js` owns live inventory operations, some of which change memory before buffered persistence.
- `src/GameServer/Item/Item.js` owns item behavior, including equipment and pet locks; it is not a universal authorization layer.
- `src/GameServer/Persistence/CharacterWriteQueue.js` coalesces selected item/character patches.
- `src/Database.js` serializes durable operations and owns transaction-specific validation/flush ordering.

A service must distinguish pending live state, committed durable state and response/UI publication. A response failure after commit does not justify issuing the economic operation again without its replay contract.

## Ground pickup and award outcomes

`World/Generics/PickupItem.js` serializes native ground claims, resolves party distribution once, then uses `PurchaseItem.serialize` to wait for all recipient backpack award queues. `Inventory/PickupCapacity.js` validates the same allocation against `InventoryLimits`, current stacks and projected native mass/load. Rejected/missing/ineligible drops remain on the ground; a rejected turn allocation does not advance `itemLastLootIndex` and is never redirected to a roomier recipient. Ordinary non-pickup awards share the queue but do not acquire a new universal capacity contract.

Admission precedes canonical ground removal. Once claimed, native grants use `PurchaseItem.awardItem`; pickup completion returns `missing`, `ineligible`, `capacity`, `rejected`, `awarded` or `award_failed`. `Actor/Generics/PickupExec` forwards the result only after the award, not merely movement/animation. Success text is sent only for awarded allocations. Companion ground-queue completion consumes the outcome and suppresses failed items for 30 seconds, preventing immediate re-enqueue of a capacity-rejected drop. Presentation failure after a committed/live grant remains `awarded`, not permission to duplicate it.

This is not one atomic ground/SQLite/multi-recipient transaction. A persistence/live-publication failure may leave a partially awarded, already claimed drop. It is logged and returned as `award_failed`; auto-fight latches a visible hunting/pickup pause and does not blindly respawn/retry the drop. Sweep and other non-ground grants retain their native custody rules; this phase does not redesign all economy operations. See [player auto-fight](world-combat.md#connected-player-auto-fight-p3-skills-support-and-pickup) for its 200-unit physical approach and capacity pause.

## Crafting

`src/GameServer/Crafting/RecipeCrafting.js` validates recipe, skill, MP and materials; locks the crafter, flushes pending state, commits through Database, then publishes results. The database rechecks physical sources and atomically consumes materials, spends MP and creates output on success. A failed craft can consume its inputs; “transaction committed” does not mean “craft succeeded.”

`Crafting/ManufactureShop.js` adds customer/crafter authority, quote and 150-unit XY contact checks. `Database.craftForCustomer` handles customer materials/fee and crafter MP. Retained static-station exemptions do not prove such stations spawn under current owned-only startup.

Recipes, skills, item definitions and catalogue descriptions must agree; see [content](content.md).

## Native private stores and direct bot trade

- `src/GameServer/PrivateStore.js` validates store lots and budget.
- `PrivateStoreTrade.js` checks sessions, current listing, price, stock and 300-unit 3D contact before the database exchange, including its transaction callback.
- `Bot/BotTradeService.js` restricts owned-vassal trading to the owning character, joins duplicate confirmations and validates exchange lines/capacity before durable transfer.
- Committed goods/Adena exchanges remain committed if later presentation fails.
- Retained non-player purchase paths in `Bot/TradeService.js` can use reserve/debit/grant/refund sequencing instead. Do not infer identical atomicity from a shared “trade” name.

## Persistent AFK board and meeting custody

Owners: `src/GameServer/AfkTrade/BoardRules.js`, `AfkTradeService.js`, `TradeMeeting.js`, `PlayerBoardService.js` and matching Database operations.

1. Physical shop projections and locationless advertisements/orders are different record types.
2. Opening a human AFK shop requires a peace-zone location and reserves stock or buy budget durably. Remote closure returns remaining reserves.
3. Ordinary escrow settlement atomically exchanges the relevant holdings, but its database primitive does not itself impose a universal proximity rule. Contact is also an entry-flow contract.
4. Conditional custody records use the meeting path rather than ordinary escrow settlement.
5. `TradeMeeting` checks bilateral authority/revisions, reserves goods/money/route costs and completes delivery only when both living available parties are within 200 units. Replay receipts prevent repeating the same delivery/refund.
6. Locate, meet, confirm and accept are distinct player-board transitions, not synonyms for settlement.

Under owned-only startup, `AfkTradeService.init` restores human records and skips legacy bot migration/meeting replay. An old database record or board UI does not establish that an autonomous bot-market scheduler is running.

## Personal and clan warehouses

| Storage | Owner and contract |
| --- | --- |
| Human personal warehouse | `Warehouse/PersonalWarehouse.js` plus `src/DatabasePlayerWarehouse.js`; shared by characters on the same account. |
| Bot personal warehouse | Character-owned stock; not automatically shared by a bot account. |
| Clan warehouse | `Warehouse/ClanWarehouse.js` and Database operations; clan membership, window/NPC context, reserves and ledger ownership matter. |

Human account-stock migration preserves enchant/pet data. Default capacity is 300 stacks/individual equipment rows via `[GameServer] playerWarehouseSlots` (accepted range 1..1000). Reducing the limit does not destroy excess stock or prevent deposits into an existing stack. Character deletion leaves the account warehouse intact.

Human personal batches publish after commit; bot personal transfers commit per line. Clan deposits are batched, while withdrawals loop transactions. Clan withdrawal requires the applicable view privilege plus leadership; reserved quantities are not freely withdrawable. Do not promise all multi-line warehouse operations are one transaction.

## Owned-vassal economy

`Bot/AI/VassalOrders.js` physically supplies vassals at Castellan, retains equipment/locked items and working supplies, then deposits eligible cargo and Adena above 100,000 with a normal warehouse keeper into the original `boundClanId`.

Order revision, contact and clan eligibility are rechecked around asynchronous work. `Bot/Economy/BotWarehouseService.js` blocks personal-storage diversion; `Clan/ClanWarehouseEquipmentService.js` excludes Lord-led stock from autonomous equipment distribution.

Economic database guards validate current vassal duty; a stale gathering or service continuation must not spend inventory after a newer order.

## Retained cold economy and history

`Bot/Economy/EconomyCommit.js`, `ColdMarketService.js`, `ColdCraftingService.js` and trip modules retain ownership/replay contracts. Cold commits check phase/owner/lease/revision and hot-state freshness before native writes. Their receipts are bounded command receipts, not arbitrary exactly-once history. Timed cold trips are not native geodata paths.

The enforced population policy bypasses cold workers, board reviews, repairs and autonomous warehouse distribution. Those modules are maintenance context, not current ambient gameplay.

`src/EconomyJournal.js` aggregates main-connection deltas before asynchronous history transfer. It is diagnostic flow history, not authorization or a complete crash-proof audit. See [persistence](persistence.md) and [observer projections](world-observer.md).

## Update together

Check service admission, native request/bypass consumers, buffered flushes, database transaction/replay guards, inventory publication and journals together. Storage changes also affect account/clan ownership and observer collections. Real-client proximity, duplicate confirmation and failure recovery remain separate behavioral checks, not claims established by this documentation.
