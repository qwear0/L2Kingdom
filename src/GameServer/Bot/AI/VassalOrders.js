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
const Transit = invoke('GameServer/Bot/AI/TownTransitPolicy');
const Navigation = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const Surface = invoke('GameServer/Geodata/SpawnSurface');
const Journey = require('../Travel/JourneyExecutor');
const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const HuntingTargetPolicy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
const TargetScorer = require('./BotTargetScorer');
const { NPC_GRID_SIZE } = require('../../World/WorldConstants');
const SAFE_REST_MS = 10 * 60 * 1000;
const TOWN_RETRY_MS = 5 * 60 * 1000;
const GATHER_ARRIVAL_RADIUS = 16;
const GATHER_STALL_MS = 30000;
const GATHER_ROUTE_RETRY_MS = 5 * 60 * 1000;
const GATHER_LOCAL_TOLERANCE = 512;
const FARM_STALL_MS = 5 * 60 * 1000;
const MAX_FARM_RECOVERIES = 3;
const WAIT_MIN_RADIUS = 180;
const WAIT_MAX_RADIUS = 640;
const WAIT_ARRIVAL_RADIUS = 24;
const WAIT_RETRY_MS = 30000;

function rowFor(session) { return Registry.find(session.actor?.fetchId()); }
function snapshot(session) {
    const row = rowFor(session), bot = session.actor;
    if (!row || !bot) return null;
    return {
        orderRevision: row.orderRevision,
        seated: bot.state.fetchSeated(),
        head: bot.fetchHead(),
        recovering: session.plan === 'resting' || session.recoveryLocked === true,
        waiting: !session.partyCompanion && row.order === 'service' && session.vassalRun?.phase === 'waiting'
    };
}
function restore(session, saved) {
    const row = rowFor(session), bot = session.actor;
    if (!row || !saved || saved.orderRevision !== row.orderRevision || bot.isDead()) return;
    bot.state.setSeated(saved.seated === true);
    if (Number.isFinite(saved.head)) bot.setHead(saved.head);
    if (saved.recovering === true) session.plan = 'resting';
    if (saved.waiting === true && row.order === 'service')
        session.vassalRun = { revision: row.orderRevision, phase: 'waiting' };
}
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
    Journey.cancel(session, 'duty_invalidated');
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
    pauseJourney(session, 'operation');
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
function pauseClocks(session) {
    const run = session.vassalRun;
    if (run?.watchdog) run.watchdog.state = 'paused';
    if (run?.gatherTravel) run.gatherTravel.progressAt = null;
}
function pauseJourney(session, reason) {
    Journey.suspend(session, reason);
    pauseClocks(session);
}
function transportWaiting(session) {
    const state = session.journey;
    if (session.pendingActorTeleport || session.pendingPathRequest || session.townNpcQueue) return true;
    if (!state || state.terminal) return false;
    if (state.flight || state.paymentUncertain || state.planning) return true;
    if (state.status === 'blocked') return state.scope === 'resource';
    if (state.status !== 'waiting') return false;
    return ['npc_slot', 'interaction_dwell'].includes(state.reason)
        || state.retryAt > Date.now() && Number.isFinite(state.retryAt);
}
function journeyTo(session, row, run, kind, destination, arrival, label) {
    const clanEligible = eligible(session, row);
    let goal = run.journeyGoal;
    // Replans share the same goal's costs/exclusions. Only a new duty target,
    // authority transition or departure after completion may start a fresh cap.
    if (!goal || goal.kind !== kind || goal.actor !== session.actor
        || (goal.completed && (Math.hypot(session.actor.fetchLocX() - destination.locX,
            session.actor.fetchLocY() - destination.locY) > arrival.xy
            || Math.abs(session.actor.fetchLocZ() - destination.locZ) > arrival.z))
        || goal.clanEligible !== clanEligible
        || ['locX', 'locY', 'locZ'].some(key => goal.to[key] !== destination[key])) {
        const current = fence(session, row);
        run.goalSequence = (run.goalSequence || 0) + 1;
        goal = { kind, actor: session.actor, clanEligible, to: { ...destination }, label,
            key: `${row.characterId}:${row.orderRevision}:${session.vassalEpoch}:${run.goalSequence}:${kind}` };
        goal.isCurrent = () => current() && session.vassalRun === run && run.journeyGoal === goal
            && eligible(session, row) === clanEligible;
        run.journeyGoal = goal;
    }
    seated(session, false);
    const result = Journey.ensure(session, { key: goal.key, to: goal.to, arrival, isCurrent: goal.isCurrent });
    goal.completed = result.status === 'arrived';
    if (transportWaiting(session)) pauseClocks(session);
    if (result.status === 'blocked' || result.status === 'waiting') status(session, `journey_${result.reason || result.status}`);
    return result;
}
function waitingPosition(point) {
    const distance = Math.hypot(point.locX - Access.loc.locX, point.locY - Access.loc.locY);
    return distance >= WAIT_MIN_RADIUS - WAIT_ARRIVAL_RADIUS
        && distance <= WAIT_MAX_RADIUS + WAIT_ARRIVAL_RADIUS
        && Math.abs(point.locZ - Access.loc.locZ) <= 100;
}
function settleAtCastellan(session, run) {
    const bot = session.actor, from = Areas.pointOf(bot), now = Date.now();
    const wait = run.castellanWait ||= { target: null, retryAt: 0 };
    if (now < wait.retryAt) return false;
    if (!wait.target) {
        // Sample real surfaces only; reachability is established by normal
        // movement, not by accepting a random XY point or teleporting to it.
        for (let attempt = 0; attempt < 8 && !wait.target; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const radius = Math.sqrt(WAIT_MIN_RADIUS ** 2
                + Math.random() * (WAIT_MAX_RADIUS ** 2 - WAIT_MIN_RADIUS ** 2));
            wait.target = Surface.supported({
                locX: Math.round(Access.loc.locX + Math.cos(angle) * radius),
                locY: Math.round(Access.loc.locY + Math.sin(angle) * radius),
                locZ: Access.loc.locZ
            });
        }
        wait.progressPoint = from;
        wait.progressAt = now;
        if (!wait.target) {
            wait.retryAt = now + WAIT_RETRY_MS + Math.random() * 5000;
            return false;
        }
    }
    if (Math.hypot(from.locX - wait.target.locX, from.locY - wait.target.locY) <= WAIT_ARRIVAL_RADIUS
        && Math.abs(from.locZ - wait.target.locZ) <= 32) {
        seated(session, true);
        Navigation.clear(session);
        return true;
    }
    seated(session, false);
    if (Math.hypot(from.locX - wait.progressPoint.locX, from.locY - wait.progressPoint.locY) >= 48) {
        wait.progressPoint = from;
        wait.progressAt = now;
    }
    const result = Navigation.move(session, bot, wait.target, 'castellan_wait', {
        arrivalRadius: WAIT_ARRIVAL_RADIUS, targetActor: null
    });
    if (result.status === 'exhausted'
        || (!session.pendingPathRequest && now - wait.progressAt >= WAIT_RETRY_MS)) {
        bot.automation.abortAll(bot);
        Navigation.clear(session);
        wait.target = null;
        wait.retryAt = now + WAIT_RETRY_MS + Math.random() * 5000;
    }
    return false;
}
function serviceReturn(session, row, run, kind = 'service', wait = row.order === 'service') {
    // Completed waiting must not restart the arrival journey: it stands the
    // actor up. Legacy centre positions are redistributed on their next tick.
    if (wait && run.phase === 'waiting') {
        if (waitingPosition(Areas.pointOf(session.actor))) {
            seated(session, true);
            return true;
        }
        run.phase = 'service';
        delete run.castellanWait;
    }
    const goal = run.journeyGoal;
    if (!goal || goal.kind !== kind || goal.actor !== session.actor || goal.clanEligible !== eligible(session, row)
        || !goal.completed || Math.hypot(session.actor.fetchLocX() - Access.loc.locX,
            session.actor.fetchLocY() - Access.loc.locY) > 1800
        || Math.abs(session.actor.fetchLocZ() - Access.loc.locZ) > 100) {
        if (journeyTo(session, row, run, kind, Access.loc, { xy: 1200, z: 100 }, 'Castellan (Gludio)').status !== 'arrived') return false;
    }
    return wait ? settleAtCastellan(session, run) : move(session, Access.loc, 100);
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
    if (session.pendingPathRequest) pauseClocks(session);
    return false;
}
function approach(session, target, open = false) {
    if (!target?.actorId) throw Error('vassal_service_npc_missing');
    const plan = open ? Approach.planOpen(session, session.actor, target, 'vassal')
        : Approach.plan(session, session.actor, target, 'vassal');
    if (!plan) throw Error('vassal_service_route_missing');
    if (plan.waiting) pauseClocks(session);
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
function townTick(session, row, run) {
    const bot = session.actor;
    const town = { locX: -12736, locY: 122816, locZ: -3112 };
    if (session.townEscape || session.pendingActorTeleport) return;
    // Warehouse approaches can lie outside the city arrival radius.
    // Only the town phase owns that arrival check; local services must keep their phase.
    if (run.phase === 'town') {
        status(session, 'returning_to_gludio');
        if (journeyTo(session, row, run, 'town', town, { xy: 1800, z: 128 }, 'Gludio services').status !== 'arrived') return;
        run.phase = 'supplies';
    }
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
    pauseJourney(session, 'post_party_rest');
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
        pauseJourney(session, 'recovery');
        session.plan = 'resting';
        status(session, 'recovering');
        seated(session, true);
        return true;
    }
    if (session.plan === 'resting' || session.recoveryLocked) {
        session.plan = 'hunting';
        seated(session, false);
    }
    session.recoveryLocked = false;
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
function gatherPointKey(zone, point) {
    return `${zone.selfId}:${Math.round(point.locX / 128)}:${Math.round(point.locY / 128)}`;
}
function blockGatherPoint(run, area, point, until) {
    run.blockedGatherPoints ||= {};
    // Aliases must share a failure, but only when this XYZ point belongs to
    // the polygon. Do not create an XY-global block across separate floors.
    for (const zone of area?.zones || []) {
        if (!Areas.containsZone(zone, point)) continue;
        const key = gatherPointKey(zone, point);
        run.blockedGatherPoints[key] = Math.max(run.blockedGatherPoints[key] || 0, until);
    }
}
function gatherZoneBounds(area) {
    return area.zones.map(zone => {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const p of zone.bounds) {
            minX = Math.min(minX, p.locX); maxX = Math.max(maxX, p.locX);
            minY = Math.min(minY, p.locY); maxY = Math.max(maxY, p.locY);
            minZ = Math.min(minZ, p.minZ); maxZ = Math.max(maxZ, p.maxZ);
        }
        return { zone, minX, maxX, minY, maxY, minZ, maxZ };
    });
}
function gatherZoneCells(zones) {
    const cells = new Map();
    zones.forEach((b, i) => {
        for (let gx = Math.floor(b.minX / NPC_GRID_SIZE); gx <= Math.floor(b.maxX / NPC_GRID_SIZE); gx++) {
            for (let gy = Math.floor(b.minY / NPC_GRID_SIZE); gy <= Math.floor(b.maxY / NPC_GRID_SIZE); gy++) {
                const key = `${gx}_${gy}`;
                if (!cells.has(key)) cells.set(key, []);
                cells.get(key).push(i);
            }
        }
    });
    return cells;
}
function gatherMemberships(zones, cells, point) {
    const indices = [];
    const key = `${Math.floor(point.locX / NPC_GRID_SIZE)}_${Math.floor(point.locY / NPC_GRID_SIZE)}`;
    for (const i of cells.get(key) || []) {
        const b = zones[i];
        if (point.locX < b.minX || point.locX > b.maxX || point.locY < b.minY || point.locY > b.maxY
            || point.locZ < b.minZ || point.locZ > b.maxZ) continue;
        if (Areas.containsZone(b.zone, point)) indices.push(i);
    }
    return indices;
}
function gatherOccupants(session, area, zones, cells) {
    const occupants = [];
    for (const other of invoke('GameServer/Bot/BotManager').sessions) {
        if (other === session || !other.actor || other.actor.isDead() || other.partyCompanion) continue;
        const row = rowFor(other), otherRun = other.vassalRun;
        if (row?.order !== 'gather' || row.areaId !== area.id || row.gatherResumePending
            || otherRun && (otherRun.revision !== row.orderRevision || otherRun.phase !== 'gather')) continue;
        const point = otherRun?.gatherTravel?.destination?.point || Areas.pointOf(other.actor);
        const memberships = gatherMemberships(zones, cells, point);
        if (memberships.length) occupants.push(new Set(memberships));
    }
    return occupants;
}
function gatherDestination(session, area, run) {
    const now = Date.now(), bot = session.actor, botPoint = Areas.pointOf(bot);
    run.blockedGatherPoints = Object.fromEntries(Object.entries(run.blockedGatherPoints || {})
        .filter(([, until]) => until > now));
    const zones = gatherZoneBounds(area), cells = gatherZoneCells(zones);
    const grid = invoke('GameServer/World/World').npc.grid, sectors = new Set();
    // The radius helper only visits 3x3 cells. Cover this whole area once,
    // retaining neighbor cells for NPCs moving away from their indexed bucket.
    // The cell-to-polygon table is selection-local and bounds exact geometry
    // work; it is not another retained world/actor index.
    for (const key of cells.keys()) {
        const [gx, gy] = key.split('_').map(Number);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) sectors.add(`${gx + dx}_${gy + dy}`);
        }
    }
    const npcs = new Set();
    for (const key of sectors) {
        for (const npc of grid[key] || []) npcs.add(npc);
    }
    const first = Number(run.zoneIndex ?? bot.fetchId()) % area.zones.length;
    const avoided = run.gatherTravel?.avoidZoneIndex, points = new Map();
    for (const npc of npcs) {
        if (!npc.fetchAttackable?.() || npc.isDead()) continue;
        const point = Areas.pointOf(npc), identity = `${point.locX}:${point.locY}:${point.locZ}`;
        if (points.has(identity)) { points.get(identity).npcs.push(npc); continue; }
        const zoneIndices = gatherMemberships(zones, cells, point);
        if (!zoneIndices.length || zoneIndices.some(i => run.blockedGatherPoints[gatherPointKey(area.zones[i], point)])) continue;
        const distance = Math.hypot(point.locX - botPoint.locX, point.locY - botPoint.locY);
        if (distance <= 128) continue;
        let zoneIndex = -1, step = Infinity;
        for (const i of zoneIndices) {
            const offset = (i - first + area.zones.length) % area.zones.length;
            if (offset < step && gatherPointInside(area.zones[i], point)) { zoneIndex = i; step = offset; }
        }
        if (zoneIndex < 0) continue;
        points.set(identity, { point, zoneIndices, zoneIndex, step, distance,
            avoided: zoneIndices.includes(avoided), npcs: [npc] });
    }
    const byPoint = (a, b) => a.point.locX - b.point.locX || a.point.locY - b.point.locY || a.point.locZ - b.point.locZ;
    const candidates = [...points.values()].sort((a, b) => Number(a.avoided) - Number(b.avoided)
        || a.distance - b.distance || byPoint(a, b));
    if (!candidates.length) return null;
    const profiles = TargetMatchup.actorProfiles([bot]), stats = TargetMatchup.profileStats(profiles);
    const botStats = { solo: true, botLevel: bot.fetchLevel(), botRole: profiles[0].role,
        minLevelGap: invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').economicHunt(session.coldLifeState || {}) ? -15 : undefined,
        botPAtk: bot.fetchCollectivePAtk?.(), botMAtk: bot.fetchCollectiveMAtk?.(),
        botPDef: bot.fetchCollectivePDef?.(), botMaxHp: bot.fetchMaxHp?.() };
    const eligible = npc => {
        if (!HuntingTargetPolicy.canHunt(npc)) return false;
        const target = TargetMatchup.targetView(npc, stats);
        return TargetScorer.intrinsicEligibility({ ...botStats,
            npcLevel: npc.fetchLevel?.() || botStats.botLevel,
            targetMatchup: TargetMatchup.soloCanHunt(profiles, target),
            botOffenseRatio: profiles.length > 1 ? profiles.reduce((sum, profile) => sum
                + (profile.role === 'mage' ? Number(profile.mAtk || 0) / Math.max(1, target.mDef || 1)
                    : Number(profile.pAtk || 0) / Math.max(1, target.pDef || 1)), 0) : undefined,
            npcPAtk: npc.fetchPAtk?.() ?? npc.fetchCollectivePAtk?.(),
            npcPDef: target.pDef, npcMDef: target.mDef, npcMaxHp: target.maxHp
        }).eligible;
    };
    const local = [];
    let dMin = Infinity, tier;
    // Establish one fixed distance band before applying occupancy. A fuzzy
    // pairwise distance comparator would be non-transitive and admit far wins.
    for (const candidate of candidates) {
        if (local.length && (candidate.avoided !== tier || candidate.distance > dMin + GATHER_LOCAL_TOLERANCE)) break;
        if (!candidate.npcs.some(eligible)) continue;
        if (!local.length) { dMin = candidate.distance; tier = candidate.avoided; }
        local.push(candidate);
    }
    if (!local.length) return null;
    const occupants = gatherOccupants(session, area, zones, cells), loads = new Map();
    for (const candidate of local) {
        const membershipKey = candidate.zoneIndices.join(',');
        if (!loads.has(membershipKey)) loads.set(membershipKey,
            occupants.reduce((count, member) => count + Number(candidate.zoneIndices.some(i => member.has(i))), 0));
        candidate.load = loads.get(membershipKey);
    }
    local.sort((a, b) => a.load - b.load || a.distance - b.distance || a.step - b.step || byPoint(a, b));
    const { point, zoneIndex } = local[0];
    return { point, zoneIndex, key: gatherPointKey(area.zones[zoneIndex], point) };
}
function travelToGatherPoint(session, row, area, run) {
    const bot = session.actor, now = Date.now(), point = Areas.pointOf(bot);
    const travel = run.gatherTravel || (run.gatherTravel = {});
    if (!travel.destination) {
        if (now < Number(travel.retryAt || 0)) {
            pauseClocks(session);
            status(session, 'no_safe_gather_destination');
            return;
        }
        travel.destination = gatherDestination(session, area, run);
        if (!travel.destination) {
            travel.waitingForTarget = true;
            pauseJourney(session, 'gather_targets_unavailable');
            status(session, 'no_safe_gather_destination');
            travel.retryAt = now + 30000;
            return;
        }
        travel.waitingForTarget = false;
        travel.progressPoint = point;
        travel.progressAt = null;
    }
    const destination = travel.destination;
    status(session, 'traveling_to_assigned_area');
    let result = journeyTo(session, row, run, `gather:${destination.key}`, destination.point,
        { xy: GATHER_ARRIVAL_RADIUS, z: 64 }, area.name);
    if (result.status === 'arrived') {
        if (!Areas.containsZone(area.zones[destination.zoneIndex], point)) throw Error('vassal_gather_arrival_outside_polygon');
        run.zoneIndex = destination.zoneIndex;
        run.gatherTravel = null;
        Navigation.clear(session);
        return;
    }
    // Only the active final walk owns this clock. Reject one access option
    // first; a bad transport landing is not proof that the duty point is bad.
    if (result.status === 'moving' && result.legType === 'walk') {
        if (travel.progressAt === null || now - Number(travel.lastTickAt || now) > 5000
            || Math.hypot(point.locX - travel.progressPoint.locX, point.locY - travel.progressPoint.locY) >= 96
            || Math.abs(point.locZ - travel.progressPoint.locZ) >= 64) {
            travel.progressPoint = point;
            travel.progressAt = now;
        }
        if (now - travel.progressAt >= GATHER_STALL_MS) {
            result = Journey.rejectFinalAccess(session);
            travel.progressAt = null;
        }
    } else travel.progressAt = null;
    travel.lastTickAt = now;
    if (result.status !== 'blocked' || result.scope !== 'final_access') return;
    Journey.cancel(session, 'gather_access_exhausted');
    blockGatherPoint(run, area, destination.point, now + GATHER_ROUTE_RETRY_MS);
    run.zoneIndex = (destination.zoneIndex + 1) % area.zones.length;
    bot.automation.abortAll(bot);
    Navigation.clear(session);
    session.townRoutePlan = null;
    run.gatherTravel = { avoidZoneIndex: destination.zoneIndex };
    status(session, 'physical_route_blocked');
}
function gatherTick(session, row, run, Generics, BotAI) {
    const bot = session.actor, area = Areas.find(row.areaId);
    if (!area) throw Error('gather_area_data_missing');
    if (!Areas.suitable(area, bot.fetchLevel())) {
        pauseClocks(session);
        status(session, 'no_safe_targets_in_assigned_area');
        return;
    }
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
        travelToGatherPoint(session, row, area, run);
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
    pauseClocks(session);
    status(session, 'no_safe_targets_in_assigned_area');
    // Try only another authored polygon of the same assignment, never a global spot.
    const row = rowFor(session), run = session.vassalRun, area = Areas.find(row?.areaId);
    if (!run || !area || session.partyCompanion || row.gatherResumePending || run.phase !== 'gather'
        || run.gatherTravel || Date.now() < Number(run.nextZoneAt || 0)) return;
    run.nextZoneAt = Date.now() + 30000;
    const currentZoneIndex = area.zones.findIndex(zone => Areas.containsZone(zone, session.actor));
    run.zoneIndex = ((currentZoneIndex >= 0 ? currentZoneIndex : Number(run.zoneIndex ?? session.actor.fetchId()))
        + 1) % area.zones.length;
    run.gatherTravel = { avoidZoneIndex: currentZoneIndex };
    travelToGatherPoint(session, row, area, run);
}
function farmWatchdog(session, row, run, paused) {
    if (row.order !== 'gather' || row.gatherResumePending) return false;
    const bot = session.actor, now = Date.now(), point = Areas.pointOf(bot), exp = bot.fetchExp();
    const watch = run.watchdog ||= { state: 'monitoring', stalledMs: 0, attempts: 0, point, exp, at: now };
    const elapsed = now - watch.at, wasPaused = watch.state === 'paused';
    watch.at = now;
    const gainedExp = exp !== watch.exp;
    const moved = Math.hypot(point.locX - watch.point.locX, point.locY - watch.point.locY) >= 96;
    if (gainedExp || moved) {
        watch.point = point;
        watch.exp = exp;
        watch.stalledMs = 0;
        // Walking back to the same trap is not productive farming. Only a
        // reward (or an explicit new order) renews the recovery allowance.
        if (gainedExp) { watch.attempts = 0; watch.exhausted = false; }
    }
    if (watch.castToken) {
        if (paused || !bot.state.fetchCasts()
            || Math.hypot(point.locX - watch.from.locX, point.locY - watch.from.locY) > 16) {
            if (session.townEscape?.token === watch.castToken) {
                session.townEscape = undefined;
                bot.state.setCasts(false);
            }
        } else if (session.townEscape?.token === watch.castToken || session.pendingActorTeleport) {
            status(session, `farm_recovery_${watch.method}`);
            return true;
        }
        watch.castToken = null;
        watch.stalledMs = 0;
        watch.retryAt = now + 60000;
    }
    // No eligible destination is a world/target availability wait, not a
    // failed physical journey. Retain the order and attempt allowance, but
    // do not carry an old stall clock into the eventual departure.
    if (run.phase === 'gather' && run.gatherTravel?.waitingForTarget) {
        watch.state = 'paused';
        watch.stalledMs = 0;
        return false;
    }
    if (paused || bot.state.fetchCasts() || bot.state.fetchSeated() || session.recoveryLocked
        || now < Number(session.vassalBlockedUntil || 0)
        || run.phase === 'shortage' || session.vassalStatus === 'working_inventory_encumbered') {
        watch.state = 'paused';
        return false;
    }
    if (watch.exhausted) {
        watch.state = 'exhausted';
        status(session, 'farm_recovery_exhausted_new_order_required');
        return true;
    }
    watch.state = 'monitoring';
    // Count observed work time, never downtime, combat, rest or a provider /
    // transaction hold. Replans and target/zone changes do not restart it.
    if (!wasPaused && !gainedExp && !moved && elapsed <= 5000) watch.stalledMs += Math.max(0, elapsed);
    if (watch.stalledMs < FARM_STALL_MS || now < Number(watch.retryAt || 0)) return false;
    if (watch.attempts >= MAX_FARM_RECOVERIES) {
        watch.exhausted = true;
        bot.automation.abortAll(bot);
        status(session, 'farm_recovery_exhausted_new_order_required');
        return true;
    }
    pauseJourney(session, 'farm_recovery');
    bot.attack.abortCast(session, bot);
    bot.attack.clearTimers();
    bot.automation.abortAll(bot);
    invoke('GameServer/Bot/AI/PartyCompanionService').cancelGroundPickup(session);
    session.currentTargetId = undefined;
    bot.unselect();
    Navigation.clear(session);
    Approach.reset(session);
    session.townRoutePlan = null;
    // Town/service stalls need fresh local navigation, not another recall to
    // the same town. Keep the goal's paid fare/exclusions and the finite
    // watchdog allowance so replanning cannot hide a persistent blockage.
    if (Transit.townAt(bot)) {
        watch.attempts++;
        watch.state = 'monitoring';
        watch.method = 'town_replan';
        watch.from = point;
        watch.stalledMs = 0;
        watch.retryAt = now + 60000;
        status(session, 'farm_recovery_town_replan');
        return true;
    }
    const current = fence(session, row);
    const isCurrent = () => current() && eligible(session, row) && session.vassalRun === run
        && !session.activeTrade && !session.trade && !session.activeNegotiation;
    const method = Travel.recover(session, bot, { isCurrent, onPhysicalArrival: () => {
        if (!isCurrent()) return;
        watch.castToken = null;
        watch.state = 'monitoring';
        watch.stalledMs = 0;
        watch.point = Areas.pointOf(bot);
        watch.at = Date.now();
        run.phase = 'town';
        session.plan = 'hunting';
        status(session, 'farm_recovery_arrived');
    } });
    if (method === 'deferred') {
        watch.retryAt = now + 60000;
        status(session, 'farm_recovery_deferred');
        return false;
    }
    watch.attempts++;
    watch.state = 'casting';
    watch.method = method;
    watch.from = point;
    watch.castToken = session.townEscape.token;
    const area = Areas.find(row.areaId);
    blockGatherPoint(run, area, point, now + 30 * 60 * 1000);
    run.zoneIndex = (Number(run.zoneIndex || 0) + 1) % Math.max(1, area?.zones.length || 0);
    run.gatherTravel = null;
    status(session, `farm_recovery_${method}`);
    return true;
}
function died(session) {
    Journey.cancel(session, 'death');
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
    if (session.pendingActorTeleport) { pauseClocks(session); return; }
    if (!row || session.vassalAdmission || session.vassalOperation) { pauseJourney(session, 'operation'); return; }
    if (session.vassalReceipt) {
        pauseJourney(session, 'inventory_publication');
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
    if (Travel.hasCombatThreat(session, bot) || session.plan === 'fleeing'
        || session.activeTrade || session.trade || session.activeNegotiation) pauseJourney(session, 'combat_or_trade');
    const defending = invoke('GameServer/Bot/AI/BotPvpDefense').tick(session, bot, Generics, BotAI);
    const incoming = invoke('GameServer/Bot/AI/PartyAwareness').npcThreateningActor(session);
    const busy = defending || incoming || bot.state.fetchHits?.() || session.plan === 'fleeing'
        || session.activeTrade || session.trade || session.activeNegotiation;
    try {
        if (eligible(session, row) && farmWatchdog(session, row, run, !!busy || transportWaiting(session))) return;
    } catch (error) {
        dutyError(session, bot, error);
        return;
    }
    if (defending || incoming || bot.state.fetchHits?.() || (session.plan === 'fleeing')) {
        if (run.phase === 'waiting') run.phase = 'service';
        pauseJourney(session, 'combat');
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
        pauseJourney(session, 'trade');
        if (session.vassalRest) session.vassalRest.at = null;
        status(session, 'owner_trade');
        return;
    }
    if (Date.now() < Number(session.vassalBlockedUntil || 0)) { pauseJourney(session, 'duty_backoff'); return; }
    if (enforceClan(session)) {
        if (session.vassalOperation || session.vassalRun !== run) return;
        try {
            if (serviceReturn(session, row, run, 'clan_return', true)) run.phase = 'waiting';
        }
        catch (error) { dutyError(session, bot, error); }
        return;
    }
    if (session.journey?.flight?.phase === 'casting') {
        pauseClocks(session);
        try { Journey.tick(session); }
        catch (error) { dutyError(session, bot, error); }
        return;
    }
    if (row.order === 'gather' && row.gatherResumePending) { graceTick(session, row); return; }
    if (session.pendingSweeps?.size) {
        pauseJourney(session, 'corpse_processing');
        if (invoke('GameServer/Bot/AI/PendingSweep').tick(session, bot, Generics, BotAI)) return;
    }
    if (run.phase !== 'gather') {
        // A supply trip must finish the defensive encounter, including corpse work,
        // before travel/contact checks can stop treating the selected target as combat.
        if (session.currentTargetId) pauseJourney(session, 'target_processing');
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
    if (session.partyGroundPickupQueue?.length || session.partyGroundPickupInProgress) pauseJourney(session, 'ground_pickup');
    if (Party.startQueuedGroundPickup(session)) return;
    try {
        if (['town', 'supplies', 'warehouse', 'done'].includes(run.phase)) townTick(session, row, run);
        else if (run.phase === 'gather') gatherTick(session, row, run, Generics, BotAI);
        else if (run.phase === 'shortage') {
            if (!requiredSupplyMissing(bot)) { run.phase = 'gather'; return; }
            if (count(bot, 57) !== run.wallet || run.stock.some(([id, amount]) => count(bot, id) !== amount)) {
                run.phase = 'town';
                return;
            }
            status(session, 'required_supplies_unaffordable');
            serviceReturn(session, row, run, 'shortage');
        } else {
            status(session, 'returning_to_castellan');
            if (serviceReturn(session, row, run)) {
                status(session, 'waiting_at_castellan');
                if (row.order === 'service') run.phase = 'waiting';
                if (row.order === 'return') operation(session, () => Registry.replaceNonGatherOrder(row.ownerCharacterId,
                    row.characterId, row.orderRevision, 'service'));
            }
        }
    } catch (error) {
        dutyError(session, bot, error);
    }
}
function dutyError(session, bot, error) {
    pauseJourney(session, 'duty_error');
    status(session, error.message);
    session.vassalBlockedUntil = Date.now() + 30000;
    utils.infoWarn('Vassal', 'duty blocked for %s: %s', bot.fetchName(), error.message);
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
            if (!session.partyCompanion && ['service', 'waiting'].includes(session.vassalRun?.phase)) continue;
        }
        if (!session.partyCompanion) pauseJourney(session, 'supply_use');
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
module.exports = { tick, invalidate, separated, snapshot, restore, targetAllowed, noTarget, died, supplies, useSupplies, enforceClan, executionFence,
    clanEligible: session => { const row = rowFor(session); return !!row && eligible(session, row); } };
