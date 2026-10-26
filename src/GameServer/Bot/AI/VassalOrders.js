const Registry = require('../../Lord/VassalService');
const Areas = require('../../Lord/GatherAreas');
const Kits = require('../../Lord/StarterKits');
const Access = require('../../Lord/CastellanAccess');
const Database = invoke('Database');
const Response = invoke('GameServer/Network/Response');
const Approach = invoke('GameServer/Bot/AI/TownNpcApproach');
const Catalog = invoke('GameServer/Bot/Economy/TownServiceCatalog');
const Rest = invoke('GameServer/Bot/AI/RestPolicy');
const Travel = invoke('GameServer/Bot/AI/BotTownTravel');
const Navigation = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const SAFE_REST_MS = 10 * 60 * 1000;
const TOWN_RETRY_MS = 5 * 60 * 1000;
const GATHER_ARRIVAL_RADIUS = 16;
const GATHER_STALL_MS = 30000;
const GATHER_ROUTE_RETRY_MS = 5 * 60 * 1000;

function rowFor(session) { return Registry.find(session.actor?.fetchId()); }
function seated(session, value) {
    const bot = session.actor;
    if (bot.state.fetchSeated() === value) return;
    if (value) {
        bot.attack.abortCast(session, bot);
        bot.attack.clearTimers();
        bot.state.setHits(false);
        bot.automation.abortAll(bot);
        session.currentTargetId = undefined;
    }
    bot.state.setSeated(value);
    session.dataSendToMeAndOthers?.(Response.sitAndStand(bot), bot);
}
function status(session, reason) {
    session.vassalStatus = reason;
    session.lastDecision = { action: 'vassal_duty', reason, at: Date.now() };
}
function invalidate(session) {
    session.vassalEpoch = Number(session.vassalEpoch || 0) + 1;
    session.vassalRest = null;
    session.vassalRun = null;
    session.pendingTownTrip = undefined;
    session.townEscape = undefined;
    session.spotRelocation = undefined;
    session.currentTargetId = undefined;
    session.currentSpot = null;
    session.vassalBlockedUntil = 0;
    session.resumeAfterBuff = undefined;
    session.preBuffPlan = undefined;
    session.preBuffLocation = undefined;
    session.actor?.attack?.abortCast?.(session, session.actor);
    session.actor?.attack?.clearTimers?.();
    session.actor?.automation?.abortAll?.(session.actor);
    session.actor?.state?.setCasts?.(false);
    session.actor?.state?.setHits?.(false);
    session.actor?.attack?.resetQueuedEvent?.();
    if (session.actor) session.actor.storedAttack = null;
    Navigation.clear(session);
    Approach.reset(session);
}
function fence(session, row) {
    const bot = session.actor, epoch = session.vassalEpoch;
    return () => session.actor === bot && session.vassalEpoch === epoch && !bot.isDead()
        && !session.partyCompanion && !session.followPlayerSession && Registry.current(row.characterId, row.orderRevision);
}
function eligible(session, row) {
    const clan = invoke('GameServer/Clan/ClanService').findById(row.boundClanId);
    return !!clan && Number(clan.leaderId) === row.ownerCharacterId && Number(clan.level) >= 1
        && !(Number(clan.dissolvingExpiryTime) > Date.now())
        && Number(session.actor.fetchClanId()) === Number(row.boundClanId)
        && clan.members.some(member => Number(member.id) === row.ownerCharacterId)
        && clan.members.some(member => Number(member.id) === row.characterId);
}
function acceptInventory(session, bot, result) {
    session.vassalReceipt = { bot, result };
    // A committed transaction is published even after a new duty was requested.
    // The operation hold is released only afterwards, so no old bag can spend twice.
    if (result.coldLifeRow) session.coldLifeState = invoke('GameServer/Bot/Population/BotLifeState').acceptLifecycleRow(result.coldLifeRow);
    if (session.actor !== bot || !result.items) { session.vassalReceipt = null; return; }
    bot.backpack.items = [];
    for (const item of result.items) bot.backpack.insertItem(Number(item.id), Number(item.selfId), { ...item });
    invoke('GameServer/Inventory/ShotStock').enableAutoShot(bot);
    session.vassalReceipt = null;
}
function operation(session, run) {
    if (session.vassalOperation) return;
    const bot = session.actor;
    const marker = session.vassalOperation = {};
    Promise.resolve().then(run).catch(error => {
        status(session, error.message);
        session.vassalBlockedUntil = Date.now() + 30000;
        utils.infoWarn('Vassal', 'duty blocked for %s: %s', bot.fetchName(), error.message);
    }).finally(() => {
        if (session.vassalOperation === marker) session.vassalOperation = null;
    });
}
function separated(session) {
    invalidate(session);
    const row = rowFor(session);
    if (row?.order === 'service') operation(session, async () => {
        await Registry.replaceNonGatherOrder(row.ownerCharacterId, row.characterId, row.orderRevision, 'return');
    });
    session.plan = 'hunting';
    invoke('GameServer/Bot/BotAI').wakeup(session, { urgent: true });
}
function routeBlocked(session, destination) {
    const path = session.lastPathfinding;
    if (path?.routeUsable !== false || Date.now() - Number(path.at) >= 30000
        || Math.hypot(Number(path.requestedTo?.locX) - destination.locX,
            Number(path.requestedTo?.locY) - destination.locY) > 32) return false;
    status(session, 'physical_route_blocked');
    return true;
}
function move(session, destination, radius = 100) {
    const bot = session.actor, from = Areas.pointOf(bot);
    if (Math.hypot(from.locX - destination.locX, from.locY - destination.locY) <= radius
        && Math.abs(from.locZ - destination.locZ) <= 100) return true;
    seated(session, false);
    if (routeBlocked(session, destination)) return false;
    if (!bot.state.fetchTowards() && !session.moveTimer)
        bot.moveTo({ from, to: destination, arrivalRadius: radius, pathMaxNodes: 120000 });
    return false;
}
function approach(session, target, open = false) {
    if (!target?.actorId) throw Error('vassal_service_npc_missing');
    const plan = open ? Approach.planOpen(session, session.actor, target, 'vassal')
        : Approach.plan(session, session.actor, target, 'vassal');
    if (!plan) throw Error('vassal_service_route_missing');
    if (!plan.ready && !plan.waiting) move(session, plan.destination, plan.arrivalRadius);
    return plan.ready;
}
function requireReached(session, row, target, current, open = false) {
    const npc = invoke('GameServer/World/World').npc.spawns.find(npc => Number(npc.fetchId()) === Number(target.actorId));
    if (!current() || !npc || Number(npc.fetchSelfId()) !== Number(target.npcSelfId)
        || Math.hypot(npc.fetchLocX() - target.locX, npc.fetchLocY() - target.locY) > 32
        || Math.abs(npc.fetchLocZ() - target.locZ) > 64 || Travel.inCombat(session, session.actor)
        || session.activeTrade || session.trade || session.activeNegotiation
        || !approach(session, target, open)) throw Error('vassal_service_contact_changed');
}
function supplies(bot) {
    const profile = Registry.loadout(bot.fetchId(), bot.fetchClassId());
    const standard = Kits.SUPPLIES.filter(s => s.appliesTo === 'all'
        || s.appliesTo === (profile.caster ? 'caster' : 'physical') || s.appliesTo === profile.kind).map(s => {
        if ([1463, 3948].includes(s.itemId)) return { ...s, itemId: invoke('GameServer/Inventory/ShotStock').planForActor(bot).selfId };
        if (s.itemId === 1341) return { ...s, itemId: arrowId(bot) };
        return s;
    });
    const learned = bot.skillset.fetchSkills().map(skill => ({ selfId: skill.fetchSelfId(), level: skill.fetchLevel() }));
    return [...standard, ...Kits.reagentsFor(learned)].sort((a, b) => a.priority - b.priority);
}
function arrowId(bot) {
    return require('../../Actor/BowResources').ARROWS[String(bot.backpack.fetchEquippedWeapon()?.fetchRank() || 'none').toLowerCase()];
}
function count(bot, id) {
    return bot.backpack.fetchItems().filter(item => Number(item.fetchSelfId()) === id)
        .reduce((n, item) => n + Number(item.fetchAmount()), 0);
}
function requiredSupplyMissing(bot) {
    const profile = Registry.loadout(bot.fetchId(), bot.fetchClassId());
    return count(bot, 1061) + count(bot, 1540) === 0
        || profile.kind === 'bow' && count(bot, arrowId(bot)) === 0
        || supplies(bot).some(s => s.appliesTo === 'learnedSkill' && count(bot, s.itemId) < s.restockMin);
}
function restockLines(bot, target) {
    const Shop = invoke('GameServer/World/Generics/NpcShopBuyLists');
    let money = count(bot, 57);
    const lines = [];
    for (const supply of supplies(bot)) {
        if (lines.length === 12) break;
        const held = count(bot, supply.itemId);
        if (held > supply.restockMin) continue;
        const quote = Shop.rowForNpc(target.npcSelfId, supply.itemId);
        if (!quote || !(quote.price > 0)) continue;
        const amount = Math.min(supply.restockTarget - held, Math.floor(money / quote.price));
        if (amount <= 0) continue;
        lines.push({ selfId: supply.itemId, amount, unitPrice: Number(quote.price), autoEquip: false });
        money -= amount * quote.price;
    }
    return lines;
}
function cargo(session) {
    const bot = session.actor;
    const retained = new Set([...Kits.SUPPLIES.map(row => row.itemId), ...supplies(bot).map(row => row.itemId)]);
    const { canDeposit } = require('../../Warehouse/WarehouseItemRules');
    return bot.backpack.fetchItems().filter(canDeposit).flatMap(item => {
        const selfId = Number(item.fetchSelfId());
        if (retained.has(selfId) || item.fetchEquipped?.() || item.fetchPetLocked?.()) return [];
        const amount = selfId === 57 ? Math.max(0, Number(item.fetchAmount()) - 100000) : Number(item.fetchAmount());
        if (!amount) return [];
        return [{ item: { id: item.fetchId(), selfId, name: item.fetchName(), kind: item.fetchKind(),
            stackable: item.fetchStackable(), petData: item.fetchPetData?.() }, amount,
            resolveKey: `vassal:${bot.fetchId()}:${item.fetchId()}:${Date.now()}` }];
    });
}
function townTick(session, row, run, BotAI) {
    const bot = session.actor;
    const town = { name: 'Gludio', x: -12736, y: 122816, z: -3112 };
    if (session.townEscape || session.pendingActorTeleport) return;
    const distance = Math.hypot(bot.fetchLocX() - town.x, bot.fetchLocY() - town.y);
    if (run.phase === 'town' && distance > 1800) {
        status(session, 'returning_to_gludio');
        if (routeBlocked(session, { locX: town.x, locY: town.y })) return;
        if (!bot.state.fetchTowards() && !session.moveTimer) Travel.request(session, bot, BotAI, null, {
            destinationTown: town, announce: false, isCurrent: fence(session, row)
        });
        return;
    }
    if (run.phase === 'town') run.phase = 'supplies';
    const current = fence(session, row);
    if (run.phase === 'supplies') {
        const target = Catalog.targetForNpc(Catalog.ROLES.SELLER, 'Gludio', Access.npcId, { from: Areas.pointOf(bot) });
        if (!target) throw Error('vassal_seller_missing');
        const lines = restockLines(bot, target);
        if (lines.length) {
            status(session, 'buying_supplies');
            if (!approach(session, target, true)) return;
            operation(session, async () => {
                const result = await Database.purchaseNpcInventoryBasket(bot.fetchId(), {
                    vassalDuty: row, seller: { ...target, sourceId: target.npcSelfId }, lines, autoEquip: false,
                    validate: () => requireReached(session, row, target, current, true)
                });
                if (!result.ok) throw Error(result.reason || 'vassal_purchase_failed');
                acceptInventory(session, bot, result);
                if (current()) run.phase = 'warehouse';
            });
            return;
        }
        run.phase = 'warehouse';
    }
    if (run.phase === 'warehouse') {
        const transfers = cargo(session);
        if (!transfers.length) run.phase = 'done';
        else {
            const npcs = invoke('GameServer/World/World').npc.spawns;
            const available = target => target?.actorId && npcs.some(npc =>
                Number(npc.fetchId()) === Number(target.actorId)
                && Number(npc.fetchSelfId()) === Number(target.npcSelfId) && !npc.isDead()
                && Math.hypot(npc.fetchLocX() - target.locX, npc.fetchLocY() - target.locY) <= 32
                && Math.abs(npc.fetchLocZ() - target.locZ) <= 64);
            // Facing warehouse counters can make the other NPC closer during approach.
            // Keep one target for the visit so proximity changes cannot reset staging.
            let target = run.warehouseTarget;
            if (!available(target)) {
                Approach.reset(session);
                delete run.warehouseTarget;
                target = Catalog.candidates(Catalog.ROLES.WAREHOUSE, 'Gludio', {
                    from: Areas.pointOf(bot), excludedNpcSelfIds: [Access.npcId]
                }).map(candidate => Catalog.targetFromRow(candidate, Catalog.ROLES.WAREHOUSE, { worldSpawns: npcs }))
                    .find(available);
                if (!target) throw Error('vassal_warehouse_missing');
                run.warehouseTarget = target;
            }
            status(session, 'depositing_clan_cargo');
            if (!approach(session, target)) return;
            operation(session, async () => {
                const result = await Database.transferPlayerInventoryBatchToClanWarehouse({
                    clanId: row.boundClanId, characterId: row.characterId, transfers, vassalDuty: row,
                    validate: () => {
                        requireReached(session, row, target, current);
                        if (!eligible(session, row)) throw Error('vassal_clan_ineligible');
                    }
                });
                acceptInventory(session, bot, result);
                if (current()) run.phase = 'done';
            });
            return;
        }
    }
    if (run.phase === 'done') {
        delete run.warehouseTarget;
        session.vassalNextRestockAt = Date.now() + TOWN_RETRY_MS;
        Approach.reset(session);
        if (row.order === 'gather') {
            run.phase = requiredSupplyMissing(bot) ? 'shortage' : 'gather';
            run.wallet = count(bot, 57);
            run.stock = supplies(bot).map(s => [s.itemId, count(bot, s.itemId)]);
            session.plan = 'hunting';
        } else run.phase = 'service';
    }
}
function graceTick(session, row) {
    if (useSupplies(session, { speed: false })) {
        if (session.vassalRest) session.vassalRest.at = null;
        return;
    }
    const now = Date.now();
    let rest = session.vassalRest;
    if (!rest || rest.revision !== row.orderRevision)
        rest = session.vassalRest = { revision: row.orderRevision, remaining: SAFE_REST_MS, at: null };
    status(session, 'post_party_rest');
    seated(session, true);
    if (rest.at !== null) rest.remaining -= Math.min(3000, Math.max(0, now - rest.at));
    rest.at = now;
    session.plan = 'resting';
    if (rest.remaining > 0) return;
    const current = fence(session, row);
    operation(session, async () => {
        const cleared = await Registry.resumeMarker(row, false, () => {
            if (!current()) throw Error('vassal_order_changed');
        });
        if (cleared && session.vassalRest === rest) {
            session.vassalRest = null;
            session.vassalRun = null;
            seated(session, false);
            session.plan = 'hunting';
        }
    });
}
function recovery(session) {
    const bot = session.actor;
    const hp = bot.fetchHp() / Math.max(1, bot.fetchMaxHp()), mp = bot.fetchMp() / Math.max(1, bot.fetchMaxMp());
    if (Rest.needsRest(bot, hp, mp, { locked: session.plan === 'resting' || session.recoveryLocked })) {
        session.plan = 'resting';
        status(session, 'recovering');
        seated(session, true);
        return true;
    }
    session.recoveryLocked = false;
    seated(session, false);
    return false;
}
function gatherPointInside(zone, point) {
    if (!Areas.containsZone(zone, point)) return false;
    // A* arrives at a geodata cell, not the exact NPC coordinate. Keep the
    // whole arrival tolerance inside the polygon, including cell rounding.
    const margin = GATHER_ARRIVAL_RADIUS + 16;
    return zone.bounds.every((a, index, bounds) => {
        const b = bounds[(index + 1) % bounds.length];
        const dx = b.locX - a.locX, dy = b.locY - a.locY;
        const along = Math.max(0, Math.min(1,
            ((point.locX - a.locX) * dx + (point.locY - a.locY) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(point.locX - a.locX - along * dx, point.locY - a.locY - along * dy) > margin;
    });
}
function gatherDestination(session, area, run) {
    const now = Date.now(), botPoint = Areas.pointOf(session.actor);
    run.blockedGatherPoints = Object.fromEntries(Object.entries(run.blockedGatherPoints || {})
        .filter(([, until]) => until > now));
    const npcs = invoke('GameServer/World/World').npc.spawns.filter(npc => npc.fetchAttackable?.());
    for (let step = 0; step < area.zones.length; step++) {
        const zoneIndex = (Number(run.zoneIndex || 0) + step) % area.zones.length;
        const zone = area.zones[zoneIndex];
        const center = {
            locX: Math.round(zone.bounds.reduce((n, p) => n + p.locX, 0) / zone.bounds.length),
            locY: Math.round(zone.bounds.reduce((n, p) => n + p.locY, 0) / zone.bounds.length),
            locZ: Math.round((zone.bounds[0].minZ + zone.bounds[0].maxZ) / 2)
        };
        center.locZ = Geodata.getHeight(center.locX, center.locY, center.locZ);
        const candidates = [...npcs.filter(npc => Areas.containsZone(zone, npc)).map(Areas.pointOf), center]
            .filter(point => gatherPointInside(zone, point))
            .map(point => ({ point, zoneIndex,
                key: `${zone.selfId}:${Math.round(point.locX / 128)}:${Math.round(point.locY / 128)}` }))
            .filter(candidate => !run.blockedGatherPoints[candidate.key]
                && Math.hypot(candidate.point.locX - botPoint.locX, candidate.point.locY - botPoint.locY) > 128)
            .sort((a, b) => Math.hypot(a.point.locX - botPoint.locX, a.point.locY - botPoint.locY)
                - Math.hypot(b.point.locX - botPoint.locX, b.point.locY - botPoint.locY));
        if (candidates.length) return candidates[0];
    }
    return null;
}
function travelToGatherPoint(session, area, run) {
    const bot = session.actor, now = Date.now(), point = Areas.pointOf(bot);
    const travel = run.gatherTravel || (run.gatherTravel = {});
    if (!travel.destination) {
        if (now < Number(travel.retryAt || 0)) return;
        travel.destination = gatherDestination(session, area, run);
        if (!travel.destination) {
            status(session, 'no_safe_gather_destination');
            travel.retryAt = now + 30000;
            return;
        }
        travel.progressPoint = point;
        travel.progressAt = now;
        Navigation.clear(session);
        session.townRoutePlan = null;
    }
    const destination = travel.destination;
    const distance = Math.hypot(point.locX - destination.point.locX, point.locY - destination.point.locY);
    if (distance <= GATHER_ARRIVAL_RADIUS && Math.abs(point.locZ - destination.point.locZ) <= 64
        && Areas.containsZone(area.zones[destination.zoneIndex], point)) {
        run.zoneIndex = destination.zoneIndex;
        run.gatherTravel = null;
        Navigation.clear(session);
        return;
    }
    // Combat, recovery and service work suspend this clock; only consecutive
    // gathering ticks can establish that a physical route has stopped moving.
    if (now - Number(travel.lastTickAt || now) > 5000
        || Math.hypot(point.locX - travel.progressPoint.locX, point.locY - travel.progressPoint.locY) >= 96
        || Math.abs(point.locZ - travel.progressPoint.locZ) >= 64) {
        travel.progressPoint = point;
        travel.progressAt = now;
    }
    travel.lastTickAt = now;
    status(session, 'traveling_to_assigned_area');
    const navigation = Navigation.move(session, bot, destination.point, 'vassal_gather', {
        targetActor: null, arrivalRadius: GATHER_ARRIVAL_RADIUS
    });
    if (navigation.status !== 'exhausted' && now - travel.progressAt < GATHER_STALL_MS) return;
    run.blockedGatherPoints[destination.key] = now + GATHER_ROUTE_RETRY_MS;
    run.zoneIndex = (destination.zoneIndex + 1) % area.zones.length;
    bot.automation.abortAll(bot);
    Navigation.clear(session);
    session.townRoutePlan = null;
    run.gatherTravel = {};
    status(session, 'physical_route_blocked');
}
function gatherTick(session, row, run, Generics, BotAI) {
    const bot = session.actor, area = Areas.find(row.areaId);
    if (!area) throw Error('gather_area_data_missing');
    if (!Areas.suitable(area, bot.fetchLevel())) { status(session, 'no_safe_targets_in_assigned_area'); return; }
    if (!session.currentTargetId && recovery(session)) return;
    if (!session.currentTargetId && Date.now() >= Number(session.vassalNextRestockAt || 0)) {
        const Shop = invoke('GameServer/World/Generics/NpcShopBuyLists');
        const money = count(bot, 57);
        const need = requiredSupplyMissing(bot) || supplies(bot).some(s => s.priority <= 3
            && count(bot, s.itemId) <= s.restockMin && Number(Shop.rowForNpc(Access.npcId, s.itemId)?.price) <= money);
        const floor = invoke('GameServer/Bot/Population/SurvivalFloor').forActor(bot);
        if (need || floor?.action === 'unload' && cargo(session).length) { run.phase = 'town'; return; }
        // Retained working stock can exceed 50% load (notably the Bow starter kit).
        // With no cargo to unload, only full slots or maximum load prevent work.
        if (floor?.action === 'unload' && (floor.reason === 'no_slot' || floor.weightPenalty >= 4)) {
            status(session, 'working_inventory_encumbered');
            return;
        }
    }
    if (!session.currentTargetId && (run.gatherTravel || !Areas.contains(area, bot))) {
        travelToGatherPoint(session, area, run);
        return;
    }
    session.plan = 'hunting';
    status(session, 'gathering');
    invoke('GameServer/Bot/AI/States/HuntingState').tick(session, bot, Generics, BotAI);
}
function targetAllowed(session, target) {
    const row = rowFor(session);
    if (!row || session.partyCompanion) return true;
    return row.order === 'gather' && !row.gatherResumePending && Areas.contains(Areas.find(row.areaId), target);
}
function noTarget(session) {
    status(session, 'no_safe_targets_in_assigned_area');
    // Try only another authored polygon of the same assignment, never a global spot.
    const run = session.vassalRun, area = Areas.find(rowFor(session)?.areaId);
    if (!run || !area || Date.now() < Number(run.nextZoneAt || 0)) return;
    run.nextZoneAt = Date.now() + 30000;
    run.zoneIndex = (Number(run.zoneIndex || 0) + 1) % area.zones.length;
    travelToGatherPoint(session, area, run);
}
function died(session) {
    if (session.vassalRest) { session.vassalRest.remaining = SAFE_REST_MS; session.vassalRest.at = null; }
    session.vassalRun = null;
}
function enforceClan(session) {
    const row = rowFor(session);
    if (!row || eligible(session, row)) return false;
    status(session, 'clan_ineligible_cargo_retained');
    if (session.partyCompanion && session.followPlayerSession)
        invoke('GameServer/Bot/AI/PartyCompanionService').detach(session.followPlayerSession, session, { source: 'clan_ineligible' });
    if (!session.vassalOperation && (row.order === 'gather' || row.gatherResumePending)) {
        invalidate(session);
        operation(session, () => Registry.replaceNonGatherOrder(row.ownerCharacterId, row.characterId, row.orderRevision, 'return'));
    }
    return true;
}
function tick(session, Generics, BotAI) {
    const bot = session.actor, row = rowFor(session);
    if (!row || session.vassalAdmission || session.vassalOperation) return;
    if (session.vassalReceipt) {
        const receipt = session.vassalReceipt;
        acceptInventory(session, receipt.bot, receipt.result);
        return;
    }
    if (bot.isDead()) {
        if (!session.deathTimerStart) { invalidate(session); died(session); session.deathTimerStart = Date.now(); }
        status(session, 'dead');
        if (Date.now() - session.deathTimerStart >= 12000) {
            Generics.revive(session, bot, { delayMs: 0, restoreFullVitals: true, recoveryReason: 'restart_to_town' });
            session.deathTimerStart = undefined;
            session.plan = 'hunting';
            Generics.teleportTo(session, bot, { locX: -12736, locY: 122816, locZ: -3112 });
        }
        return;
    }
    if (bot.state.fetchDead?.()) return;
    if (!session.vassalRun || session.vassalRun.revision !== row.orderRevision) {
        invalidate(session);
        session.vassalRun = { revision: row.orderRevision, phase: row.order === 'gather' ? 'gather'
            : row.order === 'return' ? 'town' : 'service' };
    }
    const run = session.vassalRun;
    const defending = invoke('GameServer/Bot/AI/BotPvpDefense').tick(session, bot, Generics, BotAI);
    const incoming = invoke('GameServer/Bot/AI/PartyAwareness').npcThreateningActor(session);
    if (defending || incoming || bot.state.fetchHits?.() || (session.plan === 'fleeing')) {
        if (session.vassalRest) session.vassalRest.at = null;
        seated(session, false);
        if (!defending) {
            if (session.plan === 'fleeing') invoke('GameServer/Bot/AI/States/FleeingState').tick(session, bot, Generics, BotAI);
            else if (incoming) {
                useSupplies(session);
                invoke('GameServer/Bot/AI/States/HuntingState').tick(session, bot, Generics, BotAI);
            }
        }
        return;
    }
    if (session.activeTrade || session.trade || session.activeNegotiation) {
        if (session.vassalRest) session.vassalRest.at = null;
        status(session, 'owner_trade');
        return;
    }
    if (Date.now() < Number(session.vassalBlockedUntil || 0)) return;
    if (enforceClan(session)) {
        if (!session.vassalOperation && move(session, Access.loc, 100)) seated(session, false);
        return;
    }
    if (row.order === 'gather' && row.gatherResumePending) { graceTick(session, row); return; }
    if (run.phase !== 'gather') {
        // A supply trip must finish the defensive encounter, including corpse work,
        // before travel/contact checks can stop treating the selected target as combat.
        if (invoke('GameServer/Bot/AI/PendingSweep').tick(session, bot, Generics, BotAI)) return;
        if (session.currentTargetId) {
            invoke('GameServer/Bot/AI/States/HuntingState').tickTarget(session, bot, Generics, BotAI, { allowRetarget: false });
            return;
        }
    }
    if (!session.currentTargetId && recovery(session)) return;
    if (useSupplies(session)) return;
    invoke('GameServer/Bot/AI/BotEquipmentUpgrade').applyBestUpgrades(session);
    const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
    Party.reconcileGroundLoot(session);
    if (Party.startQueuedGroundPickup(session)) return;
    try {
        if (['town', 'supplies', 'warehouse', 'done'].includes(run.phase)) townTick(session, row, run, BotAI);
        else if (run.phase === 'gather') gatherTick(session, row, run, Generics, BotAI);
        else if (run.phase === 'shortage') {
            if (!requiredSupplyMissing(bot)) { run.phase = 'gather'; return; }
            if (count(bot, 57) !== run.wallet || run.stock.some(([id, amount]) => count(bot, id) !== amount)) {
                run.phase = 'town';
                return;
            }
            status(session, 'required_supplies_unaffordable');
            move(session, Access.loc, 100);
        } else {
            status(session, 'returning_to_castellan');
            if (move(session, Access.loc, 100)) {
                status(session, 'waiting_at_castellan');
                if (row.order === 'return') operation(session, () => Registry.replaceNonGatherOrder(row.ownerCharacterId,
                    row.characterId, row.orderRevision, 'service'));
            }
        }
    } catch (error) {
        status(session, error.message);
        session.vassalBlockedUntil = Date.now() + 30000;
        utils.infoWarn('Vassal', 'duty blocked for %s: %s', bot.fetchName(), error.message);
    }
}
function useSupplies(session, { speed = true } = {}) {
    const bot = session.actor;
    if (!bot || bot.isDead() || bot.state.fetchCasts() || session.vassalOperation) return false;
    const threat = invoke('GameServer/Bot/AI/PartyAwareness').npcThreateningActor(session);
    if (threat && invoke('GameServer/Bot/AI/HealingPotionStock').tryUseInCombat(session, bot, threat)) return true;
    const effects = invoke('GameServer/Effects/EffectStore').list(bot);
    const profile = Registry.loadout(bot.fetchId(), bot.fetchClassId());
    for (const id of [1831, 1833, 1062, profile.caster ? 6035 : 735]) {
        const item = bot.backpack.fetchItemFromSelfId(id);
        if (!item || item.fetchAmount() <= 0) continue;
        const itemSkill = invoke('GameServer/Items/C4ItemSkills').resolve(id);
        const skill = bot.backpack.buildItemSkill(itemSkill), semantic = skill.fetchSemantic();
        if (bot.canUseSkill?.(skill) === false) continue;
        if (semantic.cleanse) {
            if (!semantic.cleanse.some(rule => effects.some(effect => effect.category === rule.category
                && Number(effect.level) <= Number(rule.maxLevel)))) continue;
        } else {
            if (!speed) continue;
            const order = Number(semantic.stackOrder ?? semantic.stats?.runSpdAdd
                ?? semantic.stats?.pAtkSpdMul ?? semantic.stats?.castSpdMul ?? skill.fetchLevel());
            if (effects.some(effect => effect.stackFamily === semantic.stackFamily && effect.stackOrder >= order)) continue;
            // Service/rest ticks must not drain speed stock while standing still.
            if (!session.partyCompanion && session.vassalRun?.phase === 'service') continue;
        }
        bot.backpack.useItem(session, item.fetchId());
        return true;
    }
    return false;
}
function executionFence(session) {
    const bot = session.actor, row = rowFor(session), epoch = session.vassalEpoch;
    const leader = session.followPlayerSession, party = session.partyCompanion;
    return () => session.actor === bot && !bot.isDead() && session.vassalEpoch === epoch
        && Registry.current(row.characterId, row.orderRevision)
        && session.followPlayerSession === leader && session.partyCompanion === party;
}
module.exports = { tick, invalidate, separated, targetAllowed, noTarget, died, supplies, useSupplies, enforceClan, executionFence,
    clanEligible: session => { const row = rowFor(session); return !!row && eligible(session, row); } };
