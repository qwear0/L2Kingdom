'use strict';

const { randomUUID } = require('crypto');
const { limits, actionLimits, fault } = require('../../../Mcp/Contracts');
const Journal = require('./Journal');
const Queries = require('./Queries');
const waiters = new Map();
let timer = null;
function stopTimer() { if (!waiters.size && timer) { clearInterval(timer); timer = null; } }
function finish(waiter, error, result) {
    waiters.delete(waiter.id); stopTimer();
    if (error) waiter.reject(error); else waiter.resolve(result);
}
function evaluate(waiter) {
    try {
        const attachment = waiter.lookup(), { actor, session } = attachment.record;
        Journal.sample(session);
        const predicate = waiter.input.predicate;
        let satisfied = false, evidence = null;
        if (predicate.kind === 'action_terminal') {
            evidence = require('./Actions').read({ sessionId: attachment.sessionId, actionId: predicate.actionId });
            satisfied = evidence.phase === 'terminal';
        } else if (predicate.kind === 'arrived') {
            const from = Queries.point(actor), to = predicate.to;
            satisfied = Math.hypot(from.locX - to.locX, from.locY - to.locY) <= predicate.tolerance && Math.abs(from.locZ - to.locZ) <= actionLimits.arrivalZ;
            evidence = { measured: from, xyTolerance: predicate.tolerance, zTolerance: actionLimits.arrivalZ, source: 'current_position_not_route_result' };
        } else if (predicate.kind === 'target_dead') {
            if (predicate.handle.kind === 'drop') throw fault('predicate_unavailable', 409, { reason: 'Ground items have no life state.' });
            const target = Queries.resolve(actor, predicate.handle);
            satisfied = target.isDead?.() === true || target.state?.fetchDead?.() === true;
            evidence = { handle: predicate.handle, dead: satisfied };
        } else if (predicate.kind === 'effect_present') {
            let visited = 0;
            for (const key in actor.effects || {}) {
                if (++visited > limits.queryCandidates) throw fault('predicate_work_budget', 429);
                const effect = actor.effects[key];
                if (Number(effect.id) === predicate.skillId && (!effect.expiresAt || effect.expiresAt > Date.now())) { satisfied = true; break; }
            }
        } else if (predicate.kind === 'ai_state') {
            const view = require('./Authority').view(session);
            satisfied = session.aiActive === predicate.active && (!predicate.controller || predicate.controller === view.mode);
            evidence = { active: session.aiActive === true, controller: view.mode };
        } else if (predicate.kind === 'dialogue_available') {
            satisfied = !!session.activeNpcTalk && session.mcpObservation.dialogue?.objectId === session.activeNpcTalk.objectId;
        } else if (predicate.kind === 'events') {
            const journal = session.mcpObservation;
            if (predicate.cursor.journalId !== journal.id) throw fault('event_cursor_reset', 409, { cursor: Journal.cursor(journal) });
            if (predicate.cursor.sequence > journal.sequence) throw fault('invalid_event_cursor');
            satisfied = journal.sequence > predicate.cursor.sequence;
            evidence = Journal.cursor(journal);
        } else throw fault('predicate_unavailable', 409, { reason: 'No verified inventory revision exists; use an action receipt.' });
        if (satisfied || Date.now() >= waiter.deadline) finish(waiter, null, { satisfied, timedOut: !satisfied, evidence,
            sampledAt: Date.now(), eventCursor: Journal.cursor(session.mcpObservation), actionCancelled: false });
    } catch (error) { finish(waiter, error); }
}
function wait(input, lookup) {
    if (waiters.size >= limits.waiters) throw fault('wait_capacity', 429);
    if ([...waiters.values()].filter(waiter => waiter.attachmentId === input.attachmentId).length >= 2) throw fault('attachment_wait_capacity', 429);
    lookup();
    return new Promise((resolve, reject) => {
        const waiter = { id: randomUUID(), input, attachmentId: input.attachmentId, lookup,
            deadline: Date.now() + input.timeoutMs, resolve, reject };
        waiters.set(waiter.id, waiter); evaluate(waiter);
        if (waiters.size && !timer) { timer = setInterval(() => { for (const pending of waiters.values()) evaluate(pending); }, 250); timer.unref(); }
    });
}
function close(id) { for (const waiter of waiters.values()) if (waiter.attachmentId === id) finish(waiter, fault('attachment_closed', 410)); }
module.exports = { wait, close, usage: () => ({ waiters: waiters.size }) };
