'use strict';

const { randomUUID } = require('crypto');
const { limits, fault } = require('../../../Mcp/Contracts');
const states = new Map();
let timer = null, closed = false;
function busy(session) {
    const actor = session.actor;
    if (!actor) return ['actor_unavailable'];
    const reasons = require('./Observation').busyReasons(session);
    for (const [reason, held] of [
        ['combat_settlement', actor.state.fetchHits() || actor.state.fetchCasts() || actor.attack.bowReloading || actor.attack.timers.size],
        ['native_animation', actor.state.fetchAnimated()],
        ['inference', session.brainInFlight], ['conversation', session.inConversation],
        ['pvp_handoff', session.pvpHandoffPending],
        ['arena_duel', invoke('GameServer/World/ArenaDuelService').duelForActor(actor)],
        ['skill_training', require('../BotSkillTraining').busy(actor)],
        ['craft', require('../../Crafting/RecipeCrafting').busy(actor.fetchId())],
        ['economy_commit', require('../Economy/EconomyCommit').busy(actor.fetchId())],
        ['inventory_award', invoke('GameServer/World/Generics/PurchaseItem').busy(actor.backpack)],
        ['quest_publication', Number(session.questMutations || 0) > 0],
        ['pickup_award', session.nativePickupPending || session.partyGroundPickupInProgress],
        ['shopping', session.pendingShoppingMeeting || session.shoppingOperation || session.supplyErrandHidden],
        ['custody', actor.fetchPrivateStoreType?.() || session.hotCompetitionCommit || session.populationStaging],
        ['journey_flight', session.journey?.flight || session.townEscape]
    ]) if (held) reasons.push(reason);
    const summon = invoke('GameServer/Npc/SummonControl').activeSummon(actor);
    if (summon && (summon.state.fetchHits() || summon.state.fetchCasts() || summon.attack?.timers?.size
        || summon.inventoryPending || summon.evolving || summon.ownerTeleport)) reasons.push('summon_settlement');
    return reasons;
}
function hasHolds(state) {
    const run = state.foreground;
    return !!(state.blocked || state.resumingTraining || run?.nativePending || run?.asyncPending || run?.publicationBlocked);
}
function current(lease) {
    const state = lease.state;
    return !closed && !state.blocked && state.lease === lease && state.session.mcpControl === state && state.matches()
        && !state.actor.isDead() && Date.now() < lease.aliveUntil && Date.now() < lease.idleUntil;
}
function stopFuture(state) {
    const { actor, session } = state;
    actor.automation.abortAll(actor);
    actor.attack.resetQueuedEvent();
    actor.storedAttack = actor.storedSpell = null;
    actor.selectionRevision = Number(actor.selectionRevision || 0) + 1;
    const summon = invoke('GameServer/Npc/SummonControl').activeSummon(actor);
    if (summon?.autoFightCommandOwner?.source === 'bot-mcp') {
        invoke('GameServer/Npc/SummonControl').releaseAutoCommand(session, summon, summon.autoFightCommandOwner);
    }
}
function revoke(state, reason = 'explicit_revoke') {
    if (!state.lease) return;
    state.lease = null;
    state.session.mcpControlGeneration = Number(state.session.mcpControlGeneration || 0) + 1;
    state.reason = reason;
    if (state.session.mcpOffers) require('./Offers').clear(state.session);
    if (state.session.mcpObservation) state.session.mcpObservation.emit('lease_revoked', 'control', { reason, generation: state.session.mcpControlGeneration });
    stopFuture(state);
    state.foreground?.cancel(reason);
    queueMicrotask(() => resume(state));
}
function resume(state) {
    if (states.get(state.session) !== state || state.session.mcpControl !== state) return;
    if (state.lease || hasHolds(state)) return;
    const reasons = busy(state.session);
    state.resumeBlocked = reasons;
    if (reasons.length && state.matches()) return;
    if (!closed && state.matches() && state.session.mcpTrainingDeferred) {
        state.session.mcpTrainingDeferred = false;
        state.resumingTraining = true;
        require('../BotSkillTraining').review(state.session, { controlResume: state }).then(() => {
            state.resumingTraining = false;
            resume(state);
        }).catch(error => {
            state.blocked = 'training_publication_failed';
            utils.infoWarn('BotControl', 'training resumption blocked actor=%s error=%s', state.actor.fetchId(), error.message);
        });
        return;
    }
    states.delete(state.session);
    if (state.session.mcpControl === state) state.session.mcpControl = null;
    if (!closed && state.matches() && state.wasAiActive) invoke('GameServer/Bot/BotAI').init(state.session);
}
function sweep() {
    for (const state of states.values()) {
        try {
            if (state.lease && !current(state.lease)) revoke(state, !state.matches() ? 'actor_changed'
                : state.actor.isDead() ? 'actor_dead' : Date.now() >= state.lease.idleUntil ? 'idle_expired' : 'lease_expired');
            if (!state.blocked) state.foreground?.poll();
            resume(state);
        } catch (error) {
            if (state.blocked) continue;
            state.blocked = 'control_settlement_failed';
            utils.infoWarn('BotControl', 'settlement blocked actor=%s error=%s', state.actor.fetchId(), error.message);
        }
    }
    require('./Results').prune();
    if (!states.size && timer) { clearInterval(timer); timer = null; }
}
function acquire(attachment, actorRef) {
    const { session, actor } = attachment.record;
    if (closed) throw fault('server_unavailable', 503);
    if (session.mcpControl) throw fault('controller_busy', 409);
    if (states.size >= limits.handoffStates) throw fault('handoff_capacity', 429);
    if ([...states.values()].filter(state => state.lease).length >= limits.manualLeases) throw fault('lease_capacity', 429);
    const reasons = busy(session);
    if (actor.isDead()) reasons.push('actor_dead');
    if (reasons.length) throw fault('native_busy', 409, { reasons });
    const state = { session, actor, actorRef, attachmentId: attachment.id, sessionId: attachment.sessionId,
        matches: () => invoke('GameServer/World/World').registeredActorById(attachment.characterId) === attachment.record
            && !attachment.record.retired && session.actor === actor && actor.fetchIsOnline() === true,
        wasAiActive: session.aiActive === true, foreground: null, resumeBlocked: [], reason: null };
    states.set(session, state);
    session.mcpControl = state;
    session.mcpControlGeneration = Number(session.mcpControlGeneration || 0) + 1;
    if (session.mcpOffers) require('./Offers').clear(session);
    state.preempt = reason => { revoke(state, reason); return !hasHolds(state); };
    if (!timer) { timer = setInterval(sweep, 250); timer.unref(); }
    try {
        invoke('GameServer/Bot/BotAI').stop(session, { controlHandoff: true });
        require('../AI/VassalOrders').invalidate(session);
        const summon = invoke('GameServer/Npc/SummonControl').activeSummon(actor);
        if (summon) invoke('GameServer/Npc/SummonControl').stop(session, summon);
        stopFuture(state);
    } catch (error) {
        state.blocked = 'handoff_failed';
        throw fault('handoff_failed', 409);
    }
    const now = Date.now();
    const lease = state.lease = { id: randomUUID(), state, generation: session.mcpControlGeneration,
        highWater: 0, aliveUntil: now + limits.leaseTtlMs, idleUntil: now + limits.manualIdleMs };
    if (session.mcpObservation) session.mcpObservation.emit('lease_granted', 'control', { generation: lease.generation });
    return grant(lease);
}
function grant(lease) {
    return { leaseId: lease.id, controlGeneration: lease.generation, actorRef: lease.state.actorRef,
        aliveUntil: lease.aliveUntil, idleUntil: lease.idleUntil, nextSequence: lease.highWater + 1 };
}
function requireLease(attachment, input) {
    const lease = attachment.record.session.mcpControl?.lease;
    if (!lease || lease.state.attachmentId !== attachment.id || lease.id !== input.leaseId
        || lease.generation !== input.controlGeneration || !current(lease)) throw fault('stale_authority', 409);
    return lease;
}
function heartbeat(sessionId) {
    const now = Date.now();
    for (const state of states.values()) if (state.sessionId === sessionId && state.lease && current(state.lease)) {
        state.lease.aliveUntil = Math.min(now + limits.leaseTtlMs, state.lease.idleUntil);
    }
}
function closeAttachment(id, reason = 'attachment_closed') {
    for (const state of states.values()) if (state.attachmentId === id) revoke(state, reason);
}
function view(session) {
    const state = session.mcpControl;
    return state ? { mode: state.lease ? 'manual' : 'resuming', controlGeneration: session.mcpControlGeneration,
        leaseAliveUntil: state.lease?.aliveUntil || null, idleUntil: state.lease?.idleUntil || null,
        reason: state.reason, resumptionBlocked: state.blocked || (hasHolds(state) ? 'native_settlement' : state.resumeBlocked),
        foregroundActionId: state.foreground?.receipt.actionId || null } : { mode: 'native_ai', resumptionBlocked: null };
}
function shutdown() {
    closed = true;
    for (const state of states.values()) { revoke(state, 'shutdown'); resume(state); }
    if (timer) clearInterval(timer);
    timer = null;
}
function usage() { return { manualLeases: [...states.values()].filter(state => state.lease).length, handoffStates: states.size }; }
module.exports = { usage, acquire, requireLease, grant, current, revoke, heartbeat, closeAttachment, view, busy, resume, shutdown };
