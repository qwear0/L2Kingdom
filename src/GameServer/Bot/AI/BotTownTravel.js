const refreshPartyMemberships = require('../../World/PartyMembershipPublication');
const Speech = invoke('GameServer/Bot/AI/BotSpeechTemplates');
const ServerResponse = invoke('GameServer/Network/Response');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');
const TownChatter = invoke('GameServer/Bot/AI/TownChatter');
const TownTransitPolicy = invoke('GameServer/Bot/AI/TownTransitPolicy');
const Karma = invoke('GameServer/Karma');
const TripPayment = invoke('GameServer/Bot/Travel/TripPayment');

const SOE_SKILL_ID = 2013;
const SOE_CAST_MS = TripPayment.SCROLL_CAST_MS;
const SOE_DISTANCE = 2500;

function distance2d(bot, target) {
    const dx = bot.fetchLocX() - target.x;
    const dy = bot.fetchLocY() - target.y;
    return Math.sqrt(dx * dx + dy * dy);
}

function hasCombatThreat(session, bot) {
    const recentIncoming = !!session.incomingThreatId &&
        Date.now() - Number(session.incomingThreatAt || 0) <= 5000;
    return !!session.pvpDefense || !!session.currentTargetId || recentIncoming || !!bot.state.fetchHits?.();
}

function inCombat(session, bot) {
    return hasCombatThreat(session, bot) || !!bot.state.fetchCasts?.();
}

// The paid route token covers only one physical leg. Accepted custody keeps
// ordinary AI paused through subsequent walks and the wait for settlement.
// Preserve the plan so an existing shopping continuation can still resume it.
function holdMeeting(session, bot, interrupted = false) {
    const id = Number(bot.fetchId());
    const current = invoke('GameServer/Bot/Population/BotLifeState').cachedState?.(id);
    const state = current || (session.coldLifeState?.characterId === id ? session.coldLifeState : null);
    const marker = session.tradeMeetingPresence;
    const meetingId = (marker?.actorId === id && marker.id) || state?.stats?.tradeMeeting?.[0];
    if (!meetingId || interrupted || hasCombatThreat(session, bot)) {
        session.meetingAiHold = undefined;
        if (meetingId && session.meetingTravel?.id === meetingId) session.meetingTravel = undefined;
        return false;
    }
    const held = session.meetingAiHold;
    if (held?.actor !== bot || held.id !== meetingId) {
        session.meetingAiHold = { actor: bot, id: meetingId };
        // Wake once on acquisition/recovery, never poll the native queue on
        // waiting ticks. Physical arrivals continue through presenceChanged.
        require('../../AfkTrade/TradeMeetingService').wake(id);
    }
    return true;
}

function clearCombatTrip(session) {
    session.pendingTownTrip = undefined;
    session.townEscape = undefined;
}

function revealSupplyErrand(session, bot, options = {}) {
    if (session?.supplyErrandHidden !== true) return;
    session.supplyErrandHidden = false;
    session.dataSendToOthers?.(ServerResponse.charInfo(bot), bot);
    session.dataSendToOthers?.(ServerResponse.relationChanged(bot), bot);
    // Do not leave a half-started errand blocking the next player request.
    // The combat state remains authoritative; the player can ask again once
    // the party is safe.
    if (options.clearErrand === true && session.companionShopping?.kind === 'player_resource_purchase') {
        session.companionShopping = undefined;
        session.shoppingTarget = undefined;
        session.resumeAfterShopping = undefined;
        session.preShopLocation = undefined;
    }
}

function revealInterruptedSupplyErrand(session, bot) {
    revealSupplyErrand(session, bot, { clearErrand: true });
}

function restoreSupplyHot(session, bot, reason = 'supply_errand_interrupted') {
    if (session?.supplyErrandPhase !== 'cold') {
        revealInterruptedSupplyErrand(session, bot);
        return Promise.resolve({ ok: true, reason: 'not_parked_cold' });
    }

    session.supplyErrandPhase = 'returning';
    revealInterruptedSupplyErrand(session, bot);
    if (session.coldLifeState) {
        session.coldLifeState = { ...session.coldLifeState, activity: session.plan || 'hunting' };
        refreshPartyMemberships([session], invoke);
    }
    const BotAI = invoke('GameServer/Bot/BotAI');
    BotAI.stop?.(session);
    const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
    return Promise.resolve().then(() => PopulationService.markHot(session, reason)).catch(() => null).then(() => {
        session.supplyErrandPhase = undefined;
        BotAI.init?.(session);
        return { ok: true, reason };
    });
}

function interruptEscape(session, bot) {
    if (!session.townEscape) return false;
    session.townEscape = undefined;
    session.meetingTravel = undefined;
    session.pendingTownTrip = session.pendingTownTrip || { reason: 'Finishing the fight before going to town.', requestedAt: Date.now() };
    session.plan = 'hunting';
    bot.state.setCasts(false);
    restoreSupplyHot(session, bot, 'supply_errand_interrupted');
    return true;
}

function beginEscape(session, bot, town, options = {}) {
    const token = Symbol('bot_town_escape');
    const skill = options.skill || {
        fetchSelfId: () => SOE_SKILL_ID,
        fetchCalculatedHitTime: () => SOE_CAST_MS,
        fetchReuseTime: () => 0
    };
    const castMs = skill.fetchCalculatedHitTime();

    session.townEscape = { token, town: town.name, startedAt: Date.now(), completesAt: Date.now() + castMs };
    bot.state.setCasts(true);
    if (session.supplyErrandHidden !== true) {
        session.dataSendToMeAndOthers?.(ServerResponse.skillStarted(bot, bot.fetchId(), skill), bot);
    }

    setTimeout(() => {
        if (session.townEscape?.token !== token) return;
        if (options.isCurrent && !options.isCurrent()) {
            session.townEscape = undefined;
            bot.state.setCasts(false);
            return;
        }
        if (bot.isDead() || hasCombatThreat(session, bot) || !bot.state.fetchCasts()) {
            bot.state.setCasts(false);
            session.townEscape = undefined;
            session.meetingTravel = undefined;
            session.plan = 'hunting';
            restoreSupplyHot(session, bot, 'supply_errand_interrupted');
            return;
        }

        bot.state.setCasts(false);
        session.townEscape = undefined;
        const destination = { locX: town.x, locY: town.y, locZ: town.z };
        if (session.supplyErrandHidden === true) {
            // A companion supply run is a parked cold operation. The player
            // sees the request and the eventual return, never a bot walking
            // across the world or teleporting through intermediate locations.
            bot.setLocXYZ?.(destination);
        } else {
            const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
            TeleportTo(session, bot, destination, { onArrival: options.onPhysicalArrival });
        }
        if (typeof options.onArrival === 'function') {
            Promise.resolve(options.onArrival(destination)).catch((error) => {
                utils.infoWarn('BotTownTravel', 'arrival callback failed for %s: %s', bot.fetchName?.() || bot.fetchId?.(), error.message || error);
            });
        }
        Promise.resolve(BotEventJournal.record({
            botId: bot.fetchId(),
            eventType: 'travel_complete',
            summary: `${bot.fetchName?.() || 'Bot'} arrived in ${town.name}.`,
            weight: 3,
            dedupeKey: `travel:${bot.fetchId()}:${town.name}`,
            coalesceWindowMs: 30000,
            meta: { town: town.name, mode: options.mode || 'scroll_of_escape' }
        })).catch(() => {});
    }, castMs);
}

function recover(session, bot, options = {}) {
    if (bot.isDead() || inCombat(session, bot) || session.townEscape || session.pendingActorTeleport
        || Number(bot.fetchPrivateStoreType?.() || 0) > 0 || bot.isInOlympiadMode?.()) return 'deferred';
    const scroll = TripPayment.hasActorScroll(bot);
    const skill = bot.backpack.buildItemSkill({ skillId: scroll ? SOE_SKILL_ID : 2099, level: 1 });
    if (!skill) throw Error('vassal_recovery_skill_missing');
    const restrictions = invoke('GameServer/Effects/EffectRestrictions');
    const allowed = () => scroll ? restrictions.canUseBasicAction(bot) : restrictions.canCast(bot);
    if (!allowed() || bot.canUseSkill?.(skill) === false) return 'deferred';
    const destination = invoke('GameServer/World/TownRespawn').restartCoords(bot);
    if (scroll && !TripPayment.payActor(session, bot, { scroll: true })) return 'deferred';
    beginEscape(session, bot, { name: 'town recovery', x: destination.locX, y: destination.locY, z: destination.locZ }, {
        ...options, skill, mode: scroll ? 'recovery_scroll' : 'recovery_unstuck',
        isCurrent: () => allowed() && (!options.isCurrent || options.isCurrent())
    });
    return scroll ? 'scroll' : 'unstuck';
}

// Ordinary journey recall is a real regional item cast, not the legacy
// requested-town trip above. Its owner must retain the spent-scroll record
// even on interruption; only native physical arrival can continue a journey.
function beginRegionalRecall(session, bot, options) {
    const restrictions = invoke('GameServer/Effects/EffectRestrictions');
    const skill = bot.backpack.buildItemSkill({ skillId: SOE_SKILL_ID, level: 1 });
    if (!skill) throw Error('journey_recall_skill_missing');
    const result = { status: 'refused', reason: 'recall_unavailable', scrollSpent: false };
    const karma = bot.fetchKarma();
    const allowed = () => session.actor === bot && options.isCurrent() && !bot.isDead() && bot.fetchKarma() === karma
        && !hasCombatThreat(session, bot) && !session.pendingActorTeleport
        && !session.trade && !session.activeTrade && !session.activeNegotiation && !session.botTrade
        && !bot.fetchPrivateStoreType?.() && !bot.isInOlympiadMode?.() && !bot.state.fetchSeated()
        && restrictions.canUseBasicAction(bot) && bot.canUseSkill(skill);
    if (!allowed() || bot.state.fetchCasts() || session.townEscape) return result;
    const scroll = bot.backpack.fetchItemFromSelfId(TripPayment.SCROLL_OF_ESCAPE);
    if (!scroll || scroll.fetchAmount() < 1 || scroll.fetchPetLocked?.()) return result;
    const destination = invoke('GameServer/World/TownRespawn').restartCoords(bot);
    const origin = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
    const castMs = skill.fetchCalculatedHitTime();
    if (!Number.isFinite(castMs) || castMs < 0) throw Error('journey_recall_cast_time_invalid');
    bot.automation.abortAll(bot);
    const moveGeneration = session.moveRouteGeneration;
    const marker = { token: Symbol('journey_recall'), town: 'regional recall',
        startedAt: Date.now(), completesAt: Date.now() + castMs };
    let timer;
    const cancel = (reason = 'recall_interrupted', error = null) => {
        if (['arrived', 'cancelled', 'failed'].includes(result.status) || result.status === 'dispatched' && !error) return false;
        clearTimeout(timer);
        if (session.townEscape === marker) {
            session.townEscape = undefined;
            if (!bot.attack.activeCast && bot.state.fetchCasts()) {
                bot.state.setCasts(false);
                session.dataSendToMeAndOthers?.(ServerResponse.magicSkillCanceld(bot.fetchId()), bot);
            }
        }
        result.status = error ? 'failed' : 'cancelled';
        result.reason = reason;
        result.error = error;
        if (error) utils.infoWarn('BotRecall', 'native recall failed for %s: %s', bot.fetchId(), error.message);
        options.onCancel?.(reason, error);
        return true;
    };
    result.cancel = cancel;
    const stationary = () => session.moveRouteGeneration === moveGeneration
        && !session.pendingPathRequest && !bot.state.fetchTowards()
        && bot.fetchLocX() === origin.locX && bot.fetchLocY() === origin.locY && bot.fetchLocZ() === origin.locZ;
    result.validate = () => {
        if (result.status !== 'casting') return false;
        if (!allowed() || !stationary() || session.townEscape !== marker
            || !bot.state.fetchCasts() || bot.attack.activeCast) {
            cancel('recall_interrupted');
            return false;
        }
        return true;
    };
    session.townEscape = marker;
    try {
        if (!allowed()) { cancel('owner_changed'); return result; }
        bot.backpack.deleteItem(session, scroll.fetchId(), 1, () => {
            result.scrollSpent = true;
            options.onSpent?.();
            if (!allowed() || !stationary() || session.townEscape !== marker) { cancel(); return; }
            bot.state.setCasts(true);
            result.status = 'casting';
            result.reason = null;
            session.dataSendToMeAndOthers?.(ServerResponse.skillStarted(bot, bot.fetchId(), skill), bot);
            session.dataSendToMe?.(ServerResponse.skillDurationBar(castMs));
            timer = setTimeout(() => {
                try {
                    if (!result.validate()) return;
                    bot.state.setCasts(false);
                    session.townEscape = undefined;
                    const accepted = invoke('GameServer/Actor/Generics/TeleportTo')(session, bot, destination, {
                        urgentWakeup: true,
                        onArrival: coords => {
                            result.status = 'arrived';
                            options.onArrival?.(coords);
                        }
                    });
                    if (!accepted) { cancel('recall_dispatch_refused'); return; }
                    result.status = 'dispatched';
                    result.sequence = bot.teleportSequence;
                    options.onDispatch?.(result.sequence, destination);
                } catch (error) {
                    cancel('recall_dispatch_error', error);
                }
            }, castMs);
        });
        if (!result.scrollSpent) cancel('scroll_unavailable');
    } catch (error) {
        result.paymentUncertain = !result.scrollSpent;
        cancel('recall_action_error', error);
    }
    return result;
}

function karmaTown() {
    const town = Object.values(invoke('GameServer/World/TownRespawn').towns).find((candidate) => candidate.name === Karma.TOWN_NAME);
    return { name: town.name, x: town.locX, y: town.locY, z: town.locZ };
}

function request(session, bot, BotAI, reason, options = {}) {
    if (session.partyCompanion === true && session.followPlayerSession && options.allowCompanion !== true) return 'companion';

    const pending = session.pendingTownTrip || {};
    session.pendingTownTrip = { reason: reason || pending.reason || null, requestedAt: pending.requestedAt || Date.now() };
    if (inCombat(session, bot)) return 'deferred';
    // A bot with karma walks to Floran, the town where a PK trades (design
    // 5.8): no scroll, no gatekeeper.
    const red = Karma.closesTowns(bot.fetchKarma?.());
    if (red && options.forceScrollOfEscape === true) return 'unpaid';
    const town = red ? karmaTown() : options.destinationTown || BotAI.getClosestTown(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
    const alreadyInTown = TownTransitPolicy.townAt(bot) === town.name;
    const wantsScroll = !red && !alreadyInTown && (options.forceScrollOfEscape === true || distance2d(bot, town) > SOE_DISTANCE);
    // The scroll is spent and the gatekeeper paid into another town, as for a
    // player (TripPayment). Without a scroll the bot walks; a trip that must
    // be made by scroll (a hidden supply errand) is refused instead.
    const fare = { scroll: true, fee: options.destinationTown
        ? TripPayment.fee({ locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
            { locX: town.x, locY: town.y, locZ: town.z }) ?? 0
        : 0 };
    const affordable = wantsScroll && TripPayment.hasActorScroll(bot) && !TripPayment.fareShort(
        options.forceScrollOfEscape === true ? 'hot_errand' : 'hot', fare.fee, TripPayment.actorAdena(bot));
    if (wantsScroll && !affordable && options.forceScrollOfEscape === true) return 'unpaid';
    const usesScroll = wantsScroll && affordable;
    session.preShopLocation = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
    session.plan = 'shopping';
    session.shopTimer = Date.now();
    session.shoppingRestock = undefined;
    if (options.preserveShoppingTarget !== true) session.shoppingTarget = undefined;
    if (options.announce !== false) {
        TownChatter.say(session, BotAI, 'town-trip-start', Speech.lines('town.town-trip-start', { town: town.name }));
    }
    session.pendingTownTrip = undefined;

    if (usesScroll) {
        TripPayment.payActor(session, bot, fare);
        beginEscape(session, bot, town, options);
        return 'escape';
    }

    bot.moveTo({
        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
        to: { locX: town.x, locY: town.y, locZ: town.z },
        ...(session.vassal ? { pathMaxNodes: 120000 } : {})
    });
    return 'walk';
}

async function requestMeeting(session, bot, meeting, side) {
    if (hasCombatThreat(session, bot) || bot.isDead() || session.meetingTravel || session.pendingActorTeleport) return;
    const Database = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Routes = require('../Travel/TravelRoutes'), suffix = side ? 'B' : 'A';
    const token = session.meetingTravel = { id: meeting.id };
    const point = { locX: meeting.locX, locY: meeting.locY, locZ: meeting.locZ };
    const position = () => ({ locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() });
    const valid = () => session.meetingTravel === token && !bot.isDead() && !hasCombatThreat(session, bot);
    const pay = async (legId, fee, scroll) => {
        const latest = await Database.fetchTradeMeeting(meeting.id);
        if (!valid() || latest?.state !== 'accepted') return null;
        const saved = JSON.parse(latest[`leg${suffix}`] || 'null');
        const sequence = saved?.legId === legId ? saved.sequence : latest[`nextLeg${suffix}`];
        const paid = await Database.payTradeMeetingLeg(meeting.id, side, sequence, legId, fee, scroll);
        const row = paid.coldLifeRows?.[bot.fetchId()]; if (row) Life.acceptLifecycleRow(row);
        await invoke('GameServer/AfkTrade/AfkTradeService').syncOnlineInventory(bot.fetchId(), await Database.fetchItems(bot.fetchId(), 'town_travel_meeting'));
        return sequence;
    };
    const finish = () => {
        if (!valid()) { session.meetingTravel = undefined; return; }
        session.meetingTravel = undefined;
        bot.moveTo({ from: position(), to: point });
    };
    const hop = async () => {
        if (!valid()) { session.meetingTravel = undefined; return; }
        if (String(JSON.parse(meeting[`route${suffix}`]).method).startsWith('meeting:')) { finish(); return; }
        const native = Routes.between(position(), point), step = native.route?.steps?.[0];
        if (!step) { finish(); return; }
        const latest = await Database.fetchTradeMeeting(meeting.id);
        const held = JSON.parse(latest?.[`leg${suffix}`] || 'null');
        if (step.fee > Number(latest?.[`routeReserve${suffix}`]) && !held?.legId?.startsWith('gk:')) { finish(); return; }
        const gatekeeper = require('../../World/NpcObjectIndex').nearTemplate(invoke('GameServer/World/World'),
            step.npcId, native.start.locX, native.start.locY, 1200);
        if (!gatekeeper) throw Error('trade_meeting_gatekeeper_unavailable');
        const gate = { locX: gatekeeper.fetchLocX(), locY: gatekeeper.fetchLocY(), locZ: gatekeeper.fetchLocZ() };
        if (Math.hypot(bot.fetchLocX() - gate.locX, bot.fetchLocY() - gate.locY) > 200) {
            session.meetingTravel = undefined;
            if (session.tradeMeetingPresence) { session.tradeMeetingPresence.waypoint = gate; session.tradeMeetingPresence.atWaypoint = false; }
            bot.moveTo({ from: position(), to: gate });
            return;
        }
        if (session.tradeMeetingPresence) delete session.tradeMeetingPresence.waypoint;
        const legId = `gk:${step.locX}:${step.locY}:${step.locZ}`;
        const sequence = await pay(legId, step.fee, false);
        if (sequence === null || !valid()) { session.meetingTravel = undefined; return; }
        if (!invoke('GameServer/Actor/Generics/TeleportTo')(session, bot, step, {
            onArrival: async () => {
                try {
                    await Database.acknowledgeTradeMeetingLeg(meeting.id, side, sequence);
                    await hop();
                } catch (error) { session.meetingTravel = undefined; utils.infoWarn('AfkTrade', 'meeting hop: %s', error.message); }
            }
        })) session.meetingTravel = undefined;
    };
    try {
        const route = JSON.parse(meeting[`route${suffix}`]), saved = JSON.parse(meeting[`leg${suffix}`] || 'null');
        // An interrupted recall spent its scroll. Continue on foot; never
        // cast again using an old receipt as another physical scroll.
        if (saved?.legId?.split(':')[0] === 'soe') await Database.acknowledgeTradeMeetingLeg(meeting.id, side, saved.sequence);
        if (saved?.legId?.startsWith('walk:') || saved?.legId === 'outbound')
            await Database.acknowledgeTradeMeetingLeg(meeting.id, side, saved.sequence);
        if (saved?.legId?.startsWith('gk:')) {
            const coords = saved.legId.slice(3).split(':').map(Number);
            if (coords.length === 3 && coords.every(Number.isFinite)
                && Math.hypot(bot.fetchLocX() - coords[0], bot.fetchLocY() - coords[1], bot.fetchLocZ() - coords[2]) <= 200)
                await Database.acknowledgeTradeMeetingLeg(meeting.id, side, saved.sequence);
        }
        if (route.scroll && meeting[`nextLeg${suffix}`] === 1) {
            const sequence = await pay('soe', 0, true), native = Routes.between(position(), point);
            if (sequence === null || !valid()) { session.meetingTravel = undefined; return; }
            beginEscape(session, bot, { name: native.start.name, x: native.start.locX, y: native.start.locY, z: native.start.locZ },
                { onPhysicalArrival: async destination => {
                    if (!valid() || Math.hypot(bot.fetchLocX() - destination.locX,
                        bot.fetchLocY() - destination.locY, bot.fetchLocZ() - destination.locZ) > 200) {
                        session.meetingTravel = undefined;
                        return;
                    }
                    await Database.acknowledgeTradeMeetingLeg(meeting.id, side, sequence);
                    await hop();
                } });
        } else await hop();
    } catch (error) {
        session.meetingTravel = undefined;
        if (error.message === 'trade_meeting_gatekeeper_unavailable') {
            const cancelled = await Database.cancelTradeMeeting(meeting.id, 'route_unavailable');
            for (const row of Object.values(cancelled?.coldLifeRows || {})) Life.acceptLifecycleRow(row);
            require('../../AfkTrade/TradeMeetingService').wake(bot.fetchId());
            return;
        }
        throw error;
    }
}

module.exports = {
    SOE_CAST_MS,
    SOE_DISTANCE,
    clearCombatTrip,
    hasCombatThreat,
    inCombat,
    holdMeeting,
    interruptEscape,
    recover,
    beginRegionalRecall,
    request,
    requestMeeting,
    revealSupplyErrand,
    restoreSupplyHot
};
