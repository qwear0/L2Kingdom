'use strict';

const { randomUUID } = require('crypto');
const { limits, fault, parse } = require('../../../Mcp/Contracts');
const World = invoke('GameServer/World/World');
const Registry = require('../../Lord/VassalService');
const Observation = require('./Observation');
const Authority = require('./Authority');
const Actions = require('./Actions');
const Results = require('./Results');
const Journal = require('./Journal');
const Queries = require('./Queries');
const Waiters = require('./Waiters');
const runtimeEpoch = randomUUID();
const sessions = new Map(), attachments = new Map(), observed = new Map(), receipts = Results.entries;
const incarnations = new WeakMap();
let cleanupTimer = null, unsubscribe = null, closed = false;
function live(characterId) {
    const record = World.registeredActorById(characterId);
    return record && !record.retired && record.session.botSession === true
        && record.actor.fetchIsOnline() === true && Registry.find(characterId) ? record : null;
}
function ref(record) {
    let incarnation = incarnations.get(record);
    if (!incarnation) { incarnation = randomUUID(); incarnations.set(record, incarnation); }
    return { characterId: record.id, incarnation };
}
function matches(attachment) {
    return live(attachment.characterId) === attachment.record;
}
function dropAttachment(id) {
    const attachment = attachments.get(id);
    if (!attachment) return false;
    Authority.closeAttachment(id);
    Waiters.close(id); Queries.close(id); Journal.unsubscribe(attachment.record, id);
    attachments.delete(id);
    sessions.get(attachment.sessionId)?.attachments.delete(id);
    const subscribers = observed.get(attachment.characterId);
    subscribers?.delete(id);
    if (!subscribers?.size) observed.delete(attachment.characterId);
    if (!attachments.size && unsubscribe) { unsubscribe(); unsubscribe = null; }
    return true;
}
function dropSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    for (const attachmentId of session.attachments) dropAttachment(attachmentId);
    sessions.delete(id);
}
function prune() {
    const now = Date.now();
    for (const [id, session] of sessions) if (now - session.lastSeen >= limits.attachmentTtlMs) dropSession(id);
    for (const [id, attachment] of attachments) if (!matches(attachment)) dropAttachment(id);
    Results.prune(now); Queries.prune();
    if (!sessions.size && cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
}
function startCleanup() {
    if (!cleanupTimer) { cleanupTimer = setInterval(prune, 5000); cleanupTimer.unref(); }
}
function subscribe() {
    if (unsubscribe) return;
    // One world listener serves every attachment. Semantic journals remain a
    // separate P3 concern; retirement also revokes this actor's authority.
    unsubscribe = World.subscribeActorPublications(event => {
        if (event.kind === 'reset') {
            for (const id of [...attachments.keys()]) dropAttachment(id);
            return;
        }
        const ids = observed.get(event.record.id);
        if (ids) for (const id of [...ids]) {
            const attachment = attachments.get(id);
            if (attachment && matches(attachment)) Journal.sample(attachment.record.session);
            if (attachment && !matches(attachment)) dropAttachment(id);
        }
    });
}
function sessionFor(id) {
    const session = sessions.get(id);
    if (!session) throw fault('session_expired', 410);
    return session;
}
function lookup(sessionId, attachmentId) {
    sessionFor(sessionId);
    const attachment = attachments.get(attachmentId);
    if (!attachment || attachment.sessionId !== sessionId) throw fault('attachment_expired', 410);
    if (!matches(attachment)) { dropAttachment(attachmentId); throw fault('actor_changed', 409); }
    return attachment;
}
function replay(receipt) {
    const value = receipt.value;
    if (!value.result?.attachmentId) return value;
    const attachment = attachments.get(value.result.attachmentId);
    const lease = attachment?.record.session.mcpControl?.lease;
    return { ...value, resourceState: attachment ? 'active' : 'closed',
        ...(value.result.leaseId ? { authorityState: lease?.id === value.result.leaseId && Authority.current(lease) ? 'active' : 'expired' } : {}) };
}
const remember = Results.remember;
function mutate(action, input, operation) {
    const key = `${input.sessionId}:${input.requestId}`;
    const fingerprint = JSON.stringify([action, input]);
    const retained = receipts.get(key);
    if (retained) {
        if (retained.value.fingerprint !== fingerprint) throw fault('request_conflict', 409);
        return publicReceipt(retained);
    }
    const session = sessionFor(input.sessionId);
    if (input.requestId <= session.highWater) throw fault('request_expired', 410);
    if (input.requestId !== session.highWater + 1) throw fault('request_out_of_order', 409, { nextRequestId: session.highWater + 1 });
    session.highWater = input.requestId; session.lastSeen = Date.now();
    const value = { runtimeEpoch, sessionId: input.sessionId, requestId: input.requestId, kind: action,
        fingerprint, status: 'accepted', result: null };
    // Reserve correlation before touching subscription state. Terminal eviction
    // never lowers the namespace high-water mark or permits executing old work.
    const entry = remember(key, value);
    const observedAttachment = attachments.get(input.attachmentId);
    const journal = observedAttachment?.sessionId === input.sessionId ? observedAttachment.record.session.mcpObservation : null;
    if (journal) journal.emit('control_request_received', 'control', { kind: action, mode: input.mode, requestId: input.requestId });
    try { value.result = operation(session); value.status = 'succeeded'; }
    catch (error) {
        value.status = error.statusCode ? 'rejected' : 'unknown';
        value.error = { code: error.statusCode ? error.code : 'control_request_unknown', ...(error.statusCode ? error.details : {}) };
        if (journal?.subscribers.size) journal.emit('control_request_rejected', 'control', { kind: action, requestId: input.requestId, code: value.error.code });
        if (!error.statusCode) throw error;
    } finally { remember(key, value); }
    return publicReceipt(entry);
}
function publicReceipt(entry) {
    const { fingerprint, ...value } = replay(entry);
    return value;
}
function status() {
    return { runtimeEpoch, phase: 'running', capabilities: { phase: 'P3', readOnlyAttachment: true,
        discovery: true, selfObservation: true, localScene: true, semanticEvents: true,
        detailPages: true, boundedWait: true, diagnostics: true,
        manualControl: true, gameplayActions: true,
        supported: ['move', 'approach', 'stop', 'target', 'attack:first_swing/target_dead/bounded', 'cast:learned_native',
            'state:seated/walking', 'item:shots/instant_self', 'equip', 'pickup:in_native_range', 'summon:follow/stop/one_swing'],
        notImplemented: ['npc_service_actions', 'quest_actions', 'dialogue_choices', 'social_actions', 'travel',
            'corpse_and_utility_skills', 'timed_or_handler_items', 'summon_skills/unsummon/mount', 'pvp_attack'] }, limits,
        usage: { sessions: sessions.size, attachments: attachments.size, observedBots: observed.size, ...Authority.usage(), pendingActions: Actions.pendingCount(), ...Journal.usage(), ...Queries.usage(), ...Waiters.usage() } };
}
function dispatch(action, raw) {
    const input = parse(action, raw);
    if (closed) throw fault('server_unavailable', 503, { phase: 'stopping' });
    prune();
    if (action === 'status') return status();
    if (input.runtimeEpoch !== runtimeEpoch) throw fault('stale_runtime_epoch', 409, { runtimeEpoch });
    if (action === 'list') {
        // Enumerate registry metadata only on explicit discovery. At most one
        // page performs live O(1) index lookups; never build observer snapshots.
        const roster = Registry.roster(input.ownerCharacterId);
        const end = Math.min(roster.length, input.offset + input.limit);
        return { runtimeEpoch, ownerCharacterId: input.ownerCharacterId, sampledAt: Date.now(),
            bots: roster.slice(input.offset, end).map(row => {
                const record = live(row.characterId);
                const cached = record ? null : invoke('GameServer/Bot/Population/BotLifeState').cachedState(row.characterId);
                return { characterId: row.characterId, ownerCharacterId: row.ownerCharacterId,
                    name: record?.actor.fetchName() ?? cached?.name ?? null,
                    classId: record?.actor.fetchClassId() ?? cached?.stats?.classId ?? null,
                    metadataSource: record ? 'live_actor' : cached ? 'cached_life_state' : 'unavailable',
                    availability: record ? 'live' : 'offline', actorRef: record ? ref(record) : null,
                    busyReasons: record ? Observation.busyReasons(record.session) : ['actor_unavailable'] };
            }), nextOffset: end < roster.length ? end : null, total: roster.length };
    }
    if (action === 'open') {
        if (sessions.size >= limits.sessions) throw fault('session_capacity', 429);
        const sessionId = randomUUID();
        sessions.set(sessionId, { attachments: new Set(), highWater: 0, lastSeen: Date.now() }); startCleanup();
        return { runtimeEpoch, sessionId, nextRequestId: 1, expiresInMs: limits.attachmentTtlMs };
    }
    if (action === 'request-status') {
        const entry = receipts.get(`${input.sessionId}:${input.requestId}`);
        if (!entry) throw fault('request_expired', 410);
        return publicReceipt(entry);
    }
    if (action === 'action-status') return Actions.read(input);
    if (action === 'action') return Actions.dispatch(input, () => lookup(input.sessionId, input.attachmentId));
    if (action === 'heartbeat') {
        const session = sessionFor(input.sessionId); session.lastSeen = Date.now();
        Authority.heartbeat(input.sessionId);
        return { runtimeEpoch, expiresInMs: limits.attachmentTtlMs, nextRequestId: session.highWater + 1,
            attachmentIds: [...session.attachments] };
    }
    if (['observe', 'inspect', 'events', 'diagnose', 'wait'].includes(action)) {
        const attachment = lookup(input.sessionId, input.attachmentId);
        Journal.sample(attachment.record.session);
        const identity = { runtimeEpoch, actorRef: ref(attachment.record), attachmentId: attachment.id };
        const bounded = result => {
            const value = { ...identity, ...result };
            if (Buffer.byteLength(JSON.stringify(value)) > limits.observationBytes) throw fault('observation_response_budget', 413);
            return value;
        };
        if (action === 'wait') return Waiters.wait(input, () => lookup(input.sessionId, input.attachmentId)).then(bounded);
        if (action === 'events') return bounded(Journal.read(attachment.record.session.mcpObservation, input));
        if (action === 'inspect') return bounded(input.section === 'self' ? Observation.snapshot(attachment.record, identity) : Queries.inspect(attachment, input));
        if (action === 'diagnose') return bounded(require('./Diagnostics').diagnose(attachment, input));
        const snapshot = Observation.snapshot(attachment.record, identity);
        if (input.view === 'perception') { snapshot.view = 'perception'; snapshot.control = { mode: Authority.view(attachment.record.session).mode }; }
        snapshot.scene = Queries.page(attachment, input);
        snapshot.completeness.localScene = !snapshot.scene.incomplete;
        snapshot.completeness.sceneCoverage = snapshot.scene.incomplete ? 'partial' : 'exhausted_live_iterator_not_snapshot';
        snapshot.completeness.omitted = snapshot.completeness.omitted.filter(name => name !== 'nearby');
        return bounded(snapshot);
    }
    if (action === 'attach') return mutate(action, input, session => {
        const record = live(input.actorRef.characterId);
        if (!record) throw fault('actor_unavailable', 409);
        if (ref(record).incarnation !== input.actorRef.incarnation) throw fault('stale_actor_ref', 409);
        for (const id of session.attachments) {
            const existing = attachments.get(id);
            if (existing.record === record) return { attachmentId: id, actorRef: ref(record), mode: 'read_only' };
        }
        if (attachments.size >= limits.attachments) throw fault('attachment_capacity', 429);
        if (!observed.has(record.id) && observed.size >= limits.observedBots) throw fault('observation_capacity', 429);
        const id = randomUUID();
        attachments.set(id, { id, sessionId: input.sessionId, characterId: record.id, record });
        session.attachments.add(id);
        Journal.subscribe(record, id);
        if (!observed.has(record.id)) observed.set(record.id, new Set());
        observed.get(record.id).add(id); subscribe();
        return { attachmentId: id, actorRef: ref(record), mode: 'read_only' };
    });
    if (action === 'control') return mutate(action, input, () => {
        const attachment = lookup(input.sessionId, input.attachmentId);
        if (input.mode === 'manual') {
            if (input.leaseId || input.controlGeneration) throw fault('invalid_request');
            return { attachmentId: attachment.id, mode: 'manual', ...Authority.acquire(attachment, ref(attachment.record)) };
        }
        const state = attachment.record.session.mcpControl;
        if (input.mode === 'native_ai' && !state) return { attachmentId: attachment.id, mode: 'native_ai' };
        const lease = Authority.requireLease(attachment, input);
        if (input.mode === 'keep_control') {
            lease.idleUntil = Date.now() + limits.manualIdleMs;
            lease.aliveUntil = Date.now() + limits.leaseTtlMs;
            return { attachmentId: attachment.id, mode: 'manual', ...Authority.grant(lease) };
        }
        Authority.revoke(state, 'native_ai_requested');
        return { attachmentId: attachment.id, ...Authority.view(attachment.record.session) };
    });
    if (action === 'cancel') return mutate(action, input, () => Actions.cancel(input, lookup(input.sessionId, input.attachmentId)));
    if (action === 'release') return mutate(action, input, () => {
        lookup(input.sessionId, input.attachmentId); dropAttachment(input.attachmentId);
        return { attachmentId: input.attachmentId, released: true };
    });
    if (action === 'close') return mutate(action, input, () => { dropSession(input.sessionId); return { closed: true }; });
    throw fault('not_found', 404);
}
function shutdown() {
    closed = true;
    Authority.shutdown();
    for (const id of [...sessions.keys()]) dropSession(id);
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
}
module.exports = { dispatch, shutdown };
