const JourneyPlanner = require('./JourneyPlanner');
const Gatekeepers = require('../../World/GatekeeperService');
const NpcIndex = require('../../World/NpcObjectIndex');
const Towns = require('../../World/TownRespawn');
const Navigation = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const Approach = invoke('GameServer/Bot/AI/TownNpcApproach');
const Slots = invoke('GameServer/Bot/AI/TownNpcSlots');
const Transit = invoke('GameServer/Bot/AI/TownTransitPolicy');
const TownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
const Payment = require('./TripPayment');
const PathCosts = require('./JourneyPathCosts');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');

const EXCLUSION_MS = 60000;
const EXCLUSION_LIMIT = 64;
const REPLAN_BACKOFF_MS = Navigation.BASE_RETRY_DELAY_MS;
const ARRIVAL_WAIT_MS = 15000;
let planner;

function getPlanner() {
    if (!planner) {
        const Services = invoke('GameServer/Bot/Economy/TownServiceCatalog');
        const rows = Services.rows(Services.ROLES.GATEKEEPER);
        if (!rows.length) throw Error('journey_service_catalogue_not_loaded');
        planner = JourneyPlanner.create(rows);
    }
    return planner;
}
function pointOf(actor) {
    return { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() };
}
function near(first, second, xy, z) {
    return Math.hypot(first.locX - second.locX, first.locY - second.locY) <= xy
        && Math.abs(first.locZ - second.locZ) <= z;
}
function snapshot(actor) {
    return { adena: Payment.actorAdena(actor), scrollCount: Number(actor.backpack.fetchItemFromSelfId(736)?.fetchAmount() || 0),
        karma: Number(actor.fetchKarma() || 0), speed: actor.fetchCollectiveRunSpd() };
}
function changed(first, second) {
    return !first || Object.keys(second).some(key => first[key] !== second[key]);
}
function current(session, state) {
    return !!state.actor && session.journey === state && session.actor === state.actor && !state.actor.isDead()
        && !session.partyCompanion && !session.followPlayerSession && state.request.isCurrent();
}
function report(state, status, reason = null, scope = null) {
    if (status !== undefined) Object.assign(state, { status, reason, scope });
    return { status: state.status, reason: state.reason, scope: state.scope || null, key: state.key, generation: state.generation,
        legIndex: state.index, legType: state.itinerary?.legs[state.index]?.type || null,
        mode: state.itinerary?.mode || null, plannedFare: state.plannedFare,
        paidFare: state.paidFare, paymentUncertain: state.paymentUncertain === true,
        remainingFare: Math.max(0, state.cap - state.paidFare), retryAt: Number.isFinite(state.retryAt) ? state.retryAt : null };
}
function stopWalk(session, state) {
    if (session.actor === state.actor && state.localOwned && session.moveRouteGeneration === state.moveGeneration) {
        state.actor.automation.abortAll(state.actor);
        state.moveGeneration = session.moveRouteGeneration;
        if (state.navigation) state.navigation.active = false;
    }
}
function release(session, state) {
    stopWalk(session, state);
    if (state.approach && session.townNpcApproach === state.approach) Approach.reset(session);
    if (state.recovery && session.companionNavigationRecovery === state.recovery) Navigation.clear(session);
    state.approach = state.recovery = state.navigation = null;
    state.localOwned = false;
    state.npc = null;
    delete state.interactionReadyAt;
}
function discard(session, state) {
    if (state.planning) {
        state.planning.costs.cancel(state.planning.owner);
        state.planning = null;
    }
    release(session, state);
    state.itinerary = null;
    state.index = 0;
    state.plannedFare = 0;
    state.generation++;
}
function cancel(session, reason = 'cancelled') {
    const state = session.journey;
    if (!state) return { status: 'cancelled', reason };
    const recall = state.flight?.recall;
    state.flight = null;
    recall?.cancel(reason);
    discard(session, state);
    state.terminal = true;
    return report(state, 'cancelled', reason, 'owner');
}
function suspend(session, reason = 'suspended') {
    const state = session.journey;
    if (!state || state.terminal || state.fatal) return state ? report(state) : { status: 'waiting', reason };
    // Accepted native hops cannot be undone. Retain their receipt/sequence,
    // but stop all journey-owned walking and release contact immediately.
    state.flight?.recall?.cancel(reason);
    if (state.fatal) return report(state);
    if (state.flight) release(session, state);
    else if (state.itinerary || state.localOwned || state.planning) discard(session, state);
    return report(state, 'waiting', reason, 'priority');
}
function fatal(session, state, reason, error = null) {
    state.flight = null;
    discard(session, state);
    state.fatal = reason;
    if (error) utils.infoWarn('Journey', 'action failed for %s: %s', state.actor.fetchId(), error.message);
    return report(state, 'blocked', reason, 'action');
}
function exclusionInput(state, now) {
    const input = { entries: [], sources: [], edges: [], exits: [], directWalk: false,
        recall: !!state.recallLanding && near(pointOf(state.actor), state.recallLanding, 96, 64) };
    state.expiresAt = Infinity;
    for (const [id, row] of state.exclusions) {
        if (row.until <= now) { state.exclusions.delete(id); continue; }
        state.expiresAt = Math.min(state.expiresAt, row.until);
        if (row.scope === 'directWalk' || row.scope === 'recall') input[row.scope] = true;
        else input[row.scope].push(row.key);
    }
    return input;
}
function exclude(session, state, scope, key, cause, now) {
    const id = `${scope}:${key}`;
    if (!state.exclusions.has(id) && state.exclusions.size >= EXCLUSION_LIMIT) {
        discard(session, state);
        state.retryAt = state.expiresAt;
        return report(state, 'blocked', 'candidate_limit', 'policy');
    }
    state.exclusions.set(id, { scope, key, cause, until: now + EXCLUSION_MS });
    state.expiresAt = Math.min(state.expiresAt, now + EXCLUSION_MS);
    state.lastFailure = { scope, key, cause, at: now };
    discard(session, state);
    state.retryAt = now + REPLAN_BACKOFF_MS;
    return report(state, 'waiting', cause, cause === 'resource_limited' ? 'resource' : 'route');
}
function routeFailure(session, state, leg, cause, now) {
    if (leg.type === 'walk') return exclude(session, state, leg.accessKey === 'direct' ? 'directWalk' : 'exits', leg.accessKey, cause, now);
    const previous = state.itinerary.legs[state.index - 1];
    // A failed transfer rejects its incoming edge, not all future contact with
    // this NPC. A different landing/entry may still provide usable access.
    return previous?.type === 'gatekeeper'
        ? exclude(session, state, 'edges', previous.edgeKey, cause, now)
        : exclude(session, state, 'entries', leg.source.key, cause, now);
}
function blockedReason(state) {
    const causes = new Set([...state.exclusions.values()].map(row => row.cause));
    if (causes.has('resource_limited')) return ['resource_limited', 'resource'];
    if (causes.size && [...causes].every(cause => cause === 'final_access_failed')) return ['final_access_exhausted', 'final_access'];
    if (causes.has('npc_unavailable') || causes.has('offer_unavailable')) return ['transport_unavailable', 'transport'];
    if (causes.has('gatekeeper_access_failed')) return ['gatekeeper_access_blocked', 'access'];
    return ['no_permitted_route', 'policy'];
}
function interrupted(session, state) {
    const bot = state.actor;
    if (TownTravel.hasCombatThreat(session, bot)) return 'combat';
    if (session.trade || session.activeTrade || session.activeNegotiation || session.botTrade) return 'trade';
    if (bot.state.fetchCasts() || session.townEscape) return 'other_cast';
    if (bot.state.fetchSeated() || session.recoveryLocked || session.vassalOperation || session.meetingTravel) return 'other_operation';
    if (bot.fetchPrivateStoreType?.() || !invoke('GameServer/Effects/EffectRestrictions').canUseBasicAction(bot)) return 'action_restricted';
    return null;
}
function navigate(session, state, leg, target, radius, now) {
    if (!invoke('GameServer/Effects/EffectRestrictions').canMove(state.actor)) {
        stopWalk(session, state);
        Slots.release(session);
        delete state.interactionReadyAt;
        return report(state, 'waiting', 'movement_restricted', 'priority');
    }
    const key = `${state.generation}:${state.index}:${target.locX}:${target.locY}:${target.locZ}`;
    if (state.navigation?.key !== key || state.recovery && session.companionNavigationRecovery !== state.recovery) {
        stopWalk(session, state);
        Navigation.clear(session);
        session.lastPathfinding = null;
        state.navigation = { key, anchor: pointOf(state.actor), emptyArrivals: 0, active: false };
    }
    const nav = state.navigation;
    if (!near(pointOf(state.actor), nav.anchor, 96, 64)) {
        nav.anchor = pointOf(state.actor);
        nav.emptyArrivals = 0;
    }
    // Recovery's diagnostics are target-scoped; clearing them on each NEW
    // target/leg also prevents old attempts consuming this leg's retry budget.
    if (nav.active && !session.pendingPathRequest && !session.moveTimer && !state.actor.state.fetchTowards()) {
        nav.active = false;
        if (session.lastPathfinding?.routeUsable === true) nav.emptyArrivals++;
    }
    if (nav.emptyArrivals >= Navigation.MAX_ROUTE_FAILURES) {
        return routeFailure(session, state, leg, leg.type === 'walk' ? 'final_access_failed' : 'gatekeeper_access_failed', now);
    }
    const result = Navigation.move(session, state.actor, target, `journey:${key}`, { targetActor: null, arrivalRadius: radius });
    state.recovery = session.companionNavigationRecovery;
    state.moveGeneration = session.moveRouteGeneration;
    state.localOwned = true;
    if (result.status === 'exhausted') return routeFailure(session, state, leg,
        result.reason === 'work_budget_exhausted' ? 'resource_limited'
            : leg.type === 'walk' ? 'final_access_failed' : 'gatekeeper_access_failed', now);
    if (result.status === 'waiting') {
        Slots.release(session);
        delete state.interactionReadyAt;
        state.retryAt = result.retryAt || now + REPLAN_BACKOFF_MS;
        return report(state, 'waiting', result.reason || 'navigation_backoff', 'resource');
    }
    if (result.status === 'started') nav.active = true;
    if (session.pendingPathRequest) return report(state, 'waiting', 'navigation_pending', 'resource');
    return report(state, 'moving', leg.type === 'walk' ? 'final_walk' : 'gatekeeper_approach');
}
function matching(session, state, flight) {
    return state.flight === flight && flight.generation === state.generation && current(session, state)
        && flight.sequence === state.actor.teleportSequence;
}
function arrived(session, state, flight) {
    if (!matching(session, state, flight)) return;
    if (!near(pointOf(state.actor), flight.landing, 96, 128)) {
        fatal(session, state, 'arrival_position_unconfirmed');
        return;
    }
    state.flight = null;
    state.nativeSequence = state.actor.teleportSequence;
    state.observed = { point: pointOf(state.actor), at: Date.now() };
    release(session, state);
    if (flight.kind === 'recall') {
        state.recallLanding = pointOf(state.actor);
        discard(session, state);
    } else state.index++;
    state.retryAt = 0;
    report(state, 'waiting', 'physical_arrival');
}
function gatekeeper(session, state, leg, now) {
    const World = invoke('GameServer/World/World');
    const npc = state.npc || NpcIndex.nearTemplate(World, leg.npcId, leg.source.locX, leg.source.locY, 96);
    if (!npc || NpcIndex.find(World, npc.fetchId()) !== npc || npc.isDead()
        || state.npc && state.npc !== npc || Math.abs(npc.fetchLocZ() - leg.source.locZ) > 128) {
        return exclude(session, state, 'sources', leg.source.key, 'npc_unavailable', now);
    }
    state.npc = npc;
    const target = { ...pointOf(npc), actorId: npc.fetchId(), npcSelfId: leg.npcId,
        head: npc.fetchHead(), name: npc.fetchName(), town: Towns.towns[leg.source.townKey].name };
    const approach = Approach.planOpen(session, state.actor, target, 'journey');
    state.approach = session.townNpcApproach;
    if (!approach) return routeFailure(session, state, leg, 'gatekeeper_access_failed', now);
    if (!approach.ready) {
        delete state.interactionReadyAt;
        if (approach.waiting) {
            stopWalk(session, state);
            return report(state, 'waiting', 'npc_slot');
        }
        return navigate(session, state, leg, approach.destination, approach.arrivalRadius, now);
    }
    stopWalk(session, state);
    if (state.recovery && session.companionNavigationRecovery === state.recovery) Navigation.clear(session);
    state.navigation = state.recovery = null;
    if (!Transit.interact(state, state.actor, true, now)) {
        state.moveGeneration = session.moveRouteGeneration;
        return report(state, 'waiting', 'interaction_dwell');
    }
    const flight = state.flight = { generation: state.generation, kind: 'gatekeeper', phase: 'dispatching', landing: leg.landing };
    const result = Gatekeepers.teleport(session, {
        actor: state.actor, npc, npcObjectId: npc.fetchId(), npcId: leg.npcId, destinationId: leg.destinationId,
        expected: leg, minimumBalance: 50000, remainingFare: Math.max(0, state.cap - state.paidFare),
        isCurrent: () => current(session, state) && state.flight === flight,
        onPaid: fee => {
            if (flight.accounted) return;
            flight.accounted = true;
            state.paidFare += fee;
            state.plannedFare = Math.max(0, state.plannedFare - fee);
            state.lastPayment = { generation: state.generation, legIndex: state.index, fee };
        },
        onArrival: () => arrived(session, state, flight)
    });
    state.eligibility = snapshot(state.actor);
    release(session, state);
    if (result.status === 'failed') {
        state.paymentUncertain = result.paymentUncertain === true;
        return fatal(session, state, result.paymentUncertain ? 'payment_unconfirmed' : result.reason, result.error);
    }
    if (result.status === 'accepted') {
        Object.assign(flight, { sequence: result.sequence, startedAt: now, phase: 'teleport', pending: session.pendingActorTeleport });
        return report(state, 'waiting', 'teleport');
    }
    state.flight = null;
    if (result.reason === 'actor_changed') return cancel(session, 'owner_invalidated');
    if (result.reason === 'npc_unavailable') return exclude(session, state, 'sources', leg.source.key, 'npc_unavailable', now);
    if (['out_of_range', 'no_line_of_sight'].includes(result.reason)) return routeFailure(session, state, leg, 'gatekeeper_access_failed', now);
    if (['offer_unavailable', 'offer_changed', 'payment_unavailable'].includes(result.reason)) {
        return exclude(session, state, 'edges', leg.edgeKey, 'offer_unavailable', now);
    }
    discard(session, state);
    state.retryAt = now + REPLAN_BACKOFF_MS;
    return report(state, 'waiting', result.reason, 'eligibility');
}
function recall(session, state, now) {
    release(session, state);
    const flight = state.flight = { generation: state.generation, kind: 'recall', phase: 'casting' };
    try {
        const result = TownTravel.beginRegionalRecall(session, state.actor, {
            isCurrent: () => current(session, state) && state.flight === flight,
            onSpent: () => {
                state.lastRecall = { generation: state.generation, spent: true, at: now };
                state.eligibility = snapshot(state.actor);
            },
            onDispatch: (sequence, destination) => {
                Object.assign(flight, { phase: 'teleport', sequence, landing: destination,
                    startedAt: Date.now(), pending: session.pendingActorTeleport });
            },
            onArrival: () => arrived(session, state, flight),
            onCancel: (reason, error) => {
                if (state.flight !== flight || session.journey !== state) return;
                state.flight = null;
                if (error) fatal(session, state, reason, error);
                else exclude(session, state, 'recall', 'recall', reason, Date.now());
            }
        });
        flight.recall = result;
        if (result.status === 'failed' || result.paymentUncertain) {
            state.paymentUncertain = result.paymentUncertain === true;
            return fatal(session, state, result.paymentUncertain ? 'recall_payment_unconfirmed' : result.reason, result.error);
        }
        if (result.status !== 'casting') {
            if (state.flight === flight) {
                state.flight = null;
                return exclude(session, state, 'recall', 'recall', result.reason, now);
            }
            return report(state);
        }
        return report(state, 'waiting', 'recall_cast');
    } catch (error) {
        return fatal(session, state, 'recall_action_error', error);
    }
}
function reconcile(session, state, now) {
    const flight = state.flight;
    if (!flight) return null;
    if (flight.phase === 'casting') {
        if (state.actor.teleportSequence !== state.nativeSequence) flight.recall?.cancel('teleport_superseded');
        else flight.recall?.validate();
        if (state.flight === flight) return report(state, 'waiting', 'recall_cast');
        return null;
    }
    if (flight.phase === 'dispatching') return report(state, 'waiting', 'dispatching');
    if (state.actor.teleportSequence !== flight.sequence
        || session.pendingActorTeleport && session.pendingActorTeleport !== flight.pending) {
        state.flight = null;
        discard(session, state);
        state.nativeSequence = state.actor.teleportSequence;
        return null;
    }
    // Never infer arrival from a cleared pending flag or from proximity. The
    // native callback may have been omitted; keep the debit latched and block.
    if (!session.pendingActorTeleport || now - flight.startedAt > ARRIVAL_WAIT_MS) {
        return report(state, 'blocked', 'arrival_unconfirmed', 'action');
    }
    return report(state, 'waiting', 'teleport');
}
function plan(session, state, point, values, now) {
    if (!state.planning) {
        const planner = getPlanner();
        state.actor.automation.abortAll(state.actor);
        Approach.reset(session);
        Navigation.clear(session);
        session.lastPathfinding = null;
        state.localOwned = true;
        state.moveGeneration = session.moveRouteGeneration;
        const costs = PathCosts.forPool(session.pathfindingWorkerPool);
        const planning = state.planning = { costs, owner: { cancelled: false }, point,
            revision: Geodata.navigationRevision || 0, result: null, error: null };
        const generation = state.generation;
        planner.plan({ ...state.request, ...values, from: point,
            remainingFare: Math.max(0, state.cap - state.paidFare), exclusions: exclusionInput(state, now) },
        (from, to, arrival) => costs.measure(from, to, arrival, planning.owner)).then(result => {
            if (state.planning === planning && state.generation === generation && current(session, state)) planning.result = result;
        }, error => {
            if (state.planning === planning && state.generation === generation && current(session, state)) planning.error = error;
        });
    }
    const planning = state.planning;
    if (planning.revision !== (Geodata.navigationRevision || 0)) {
        discard(session, state);
        return report(state, 'waiting', 'route_estimate_stale', 'resource');
    }
    if (planning.error) return fatal(session, state, 'route_estimate_failed', planning.error);
    if (!planning.result) return report(state, 'waiting', 'route_estimate_pending', 'resource');
    if (!near(point, planning.point, 96, 64)) {
        discard(session, state);
        return report(state, 'waiting', 'route_estimate_relocated', 'resource');
    }
    const selected = planning.result;
    state.planning = null;
    if (selected.status === 'waiting') {
        state.retryAt = now + (selected.reason === 'geodata_missing' ? EXCLUSION_MS : REPLAN_BACKOFF_MS);
        return report(state, 'waiting', selected.reason, 'resource');
    }
    if (selected.status === 'blocked') {
        const [reason, scope] = blockedReason(state);
        state.retryAt = state.expiresAt;
        return report(state, 'blocked', reason, scope);
    }
    state.itinerary = selected;
    state.plannedFare = selected.fee;
    state.index = 0;
    state.retryAt = 0;
    return null;
}
function tick(session) {
    const state = session.journey;
    if (!state) return { status: 'cancelled', reason: 'no_journey' };
    if (state.terminal || state.fatal) return report(state);
    if (!current(session, state)) return cancel(session, 'owner_invalidated');
    const now = Date.now();
    const pending = reconcile(session, state, now);
    if (pending) return pending;
    if (state.fatal) return report(state);
    const pause = interrupted(session, state);
    if (pause) return suspend(session, pause);
    if (session.pendingActorTeleport) {
        if (state.itinerary || state.localOwned || state.planning) discard(session, state);
        return report(state, 'waiting', 'external_teleport');
    }
    const values = snapshot(state.actor);
    const point = pointOf(state.actor);
    const relocated = state.observed && Math.hypot(point.locX - state.observed.point.locX,
        point.locY - state.observed.point.locY, point.locZ - state.observed.point.locZ)
        > Math.max(512, values.speed * Math.max(0, now - state.observed.at) / 1000 * 2 + 256);
    state.observed = { point, at: now };
    if (state.nativeSequence !== state.actor.teleportSequence || relocated || changed(state.eligibility, values)) {
        discard(session, state);
        state.nativeSequence = state.actor.teleportSequence;
        state.eligibility = values;
        state.retryAt = 0;
    }
    if (now < state.retryAt) return report(state);
    if (!state.itinerary) {
        const pendingPlan = plan(session, state, point, values, now);
        if (pendingPlan) return pendingPlan;
    }
    const leg = state.itinerary.legs[state.index];
    if (!leg) {
        release(session, state);
        state.terminal = true;
        return report(state, 'arrived', null);
    }
    if (leg.type === 'gatekeeper') return gatekeeper(session, state, leg, now);
    if (leg.type === 'recall') return recall(session, state, now);
    if (near(point, leg.target, leg.arrival.xy, leg.arrival.z)) {
        release(session, state);
        state.index++;
        state.terminal = true;
        return report(state, 'arrived', null);
    }
    return navigate(session, state, leg, leg.target, leg.arrival.xy, now);
}

// A key identifies one owner/order/destination for its entire lifetime.
// Repeating ensure continues it; only a genuinely new key starts a new cap.
// The first fence/policy is retained, so fresh closures cannot revive old work.
function ensure(session, request) {
    if (!request?.key || typeof request.isCurrent !== 'function') throw Error('journey_owner_required');
    if (!request.to || !['locX', 'locY', 'locZ'].every(key => Number.isFinite(request.to[key]))) throw Error('journey_destination_invalid');
    const cap = request.maxFare ?? Infinity;
    if (!(cap >= 0) || !Number.isFinite(cap) && cap !== Infinity) throw Error('journey_fare_cap_invalid');
    if (session.journey?.key !== request.key) {
        cancel(session, 'goal_changed');
        session.journey = { key: request.key, actor: session.actor,
            request: { to: Object.freeze({ ...request.to }), isCurrent: request.isCurrent,
                arrival: Object.freeze({ ...(request.arrival || { xy: 96, z: 128 }) }),
                allowedModes: Object.freeze([...(request.allowedModes || ['walk', 'gatekeeper', 'recall'])]) },
            cap, paidFare: 0, plannedFare: 0, generation: 0, index: 0, retryAt: 0,
            nativeSequence: session.actor?.teleportSequence, exclusions: new Map(), expiresAt: Infinity,
            status: 'waiting', reason: 'planning' };
    } else {
        const state = session.journey;
        if (['locX', 'locY', 'locZ'].some(key => state.request.to[key] !== request.to[key])) throw Error('journey_destination_requires_new_key');
        if (cap < state.cap) { state.cap = cap; if (!state.flight) discard(session, state); state.retryAt = 0; }
    }
    return tick(session);
}

// The duty owns its active-walk clock; exhausting one final approach must
// still try other exits before the duty is allowed to reject its destination.
function rejectFinalAccess(session) {
    const state = session.journey;
    const leg = state?.itinerary?.legs[state.index];
    if (!state || !current(session, state) || state.flight || state.terminal || state.fatal
        || state.status !== 'moving' || leg?.type !== 'walk') throw Error('journey_final_walk_not_active');
    return routeFailure(session, state, leg, 'final_access_failed', Date.now());
}

module.exports = { ensure, tick, suspend, cancel, rejectFinalAccess };
