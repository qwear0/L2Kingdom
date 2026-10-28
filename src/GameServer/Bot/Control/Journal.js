'use strict';

const { randomUUID } = require('crypto');
const { limits, fault } = require('../../../Mcp/Contracts');
const journals = new Set();
function compact(value, depth = 0) {
    if (typeof value === 'string') return value.slice(0, 512);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (!value || typeof value !== 'object' || depth >= 3) return null;
    if (Array.isArray(value)) return value.slice(0, 16).map(entry => compact(entry, depth + 1));
    const result = {}; let count = 0;
    for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (++count > 16) { result.truncated = true; break; }
        result[key.slice(0, 64)] = compact(value[key], depth + 1);
    }
    return result;
}
function subscribe(record, id) {
    let journal = record.session.mcpObservation;
    if (!journal) {
        journal = { id: randomUUID(), record, subscribers: new Set(), sequence: 0, bytes: 0, dropped: 0,
            events: new Map(), lastSampleAt: 0, dialogue: null,
            emit(kind, source, data = {}, actionId = null) {
                let event = { sequence: ++journal.sequence, at: Date.now(), actorId: record.id, actionId,
                    kind, source, data: compact(data) };
                let bytes = Buffer.byteLength(JSON.stringify(event));
                if (bytes > limits.eventBytes) { event.data = { truncated: true }; bytes = Buffer.byteLength(JSON.stringify(event)); }
                while (journal.events.size && (journal.events.size >= limits.journalEvents || journal.bytes + bytes > limits.journalBytes)) {
                    const key = journal.events.keys().next().value;
                    journal.bytes -= journal.events.get(key).bytes; journal.events.delete(key); journal.dropped++;
                }
                journal.events.set(event.sequence, { event, bytes }); journal.bytes += bytes;
            } };
        record.session.mcpObservation = journal; journals.add(journal);
        journal.emit('subscription_started', 'control');
    }
    if (journal.record !== record) throw fault('actor_changed', 409);
    journal.subscribers.add(id);
    return journal;
}
function unsubscribe(record, id) {
    const journal = record.session.mcpObservation;
    if (!journal || journal.record !== record) return;
    journal.subscribers.delete(id);
    if (!journal.subscribers.size) {
        journals.delete(journal); journal.events.clear(); journal.bytes = 0; journal.dialogue = null;
        record.session.mcpObservation = null;
        require('./Offers').clear(record.session);
    }
}
function sample(session) {
    const journal = session.mcpObservation;
    if (!journal || Date.now() - journal.lastSampleAt < 500) return;
    journal.lastSampleAt = Date.now();
    const actor = session.actor;
    if (actor !== journal.record.actor) return;
    const state = { targetId: actor.fetchDestId() || null, hp: actor.fetchHp(), mp: actor.fetchMp(), dead: actor.isDead(),
        aiActive: session.aiActive === true, plan: session.plan || null };
    const previous = journal.previous;
    for (const key of Object.keys(state)) if (previous && state[key] !== previous[key]) {
        journal.emit(key === 'dead' ? state.dead ? 'death' : 'revive' : 'self_changed', 'native_sample', { field: key, before: previous[key], after: state[key] });
    }
    const decision = session.lastDecision;
    if (decision && decision !== journal.decision) {
        journal.emit('ai_decision', 'native_policy', decision); journal.decision = decision;
    }
    const path = session.lastPathfinding;
    if (path && path !== journal.path) {
        journal.emit('route_result', 'native_pathfinding', { strategy: path.strategy, reason: path.reason, error: path.error,
            routeUsable: path.routeUsable, lowLodWarp: path.lowLodWarp, requestedTo: path.requestedTo }); journal.path = path;
    }
    journal.previous = state;
}
function cursor(journal) { return { journalId: journal.id, sequence: journal.sequence }; }
function read(journal, input) {
    const supplied = input.cursor;
    if (supplied && supplied.journalId !== journal.id) throw fault('event_cursor_reset', 409, { cursor: cursor(journal) });
    const first = journal.events.keys().next().value ?? journal.sequence + 1;
    const after = supplied?.sequence ?? first - 1;
    if (after > journal.sequence) throw fault('invalid_event_cursor');
    const events = []; let bytes = 0, next = after;
    for (const { event, bytes: size } of journal.events.values()) {
        if (event.sequence <= after) continue;
        if (events.length >= input.limit || bytes + size > 24000) break;
        events.push(event); next = event.sequence; bytes += size;
    }
    return { events, cursor: { journalId: journal.id, sequence: next }, latestCursor: cursor(journal),
        gap: after < first - 1, dropped: journal.dropped, more: next < journal.sequence, source: 'observed_session_journal' };
}
function dialogue(session, objectId, html, source) {
    const journal = session.mcpObservation;
    if (!journal) return;
    // Native text is untrusted data. Reading it never issues a selectable bypass.
    const text = String(html).slice(0, 8192).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2048);
    journal.dialogue = { objectId, revision: randomUUID(), at: Date.now(), text, untrusted: true, source,
        ...require('./Offers').capture(session, objectId, html) };
    journal.emit('dialogue', source, { objectId, revision: journal.dialogue.revision, text: text.slice(0, 512) });
}
function recent(journal, actionId = null, limit = 3) {
    const events = [];
    for (const { event } of journal.events.values()) {
        if (actionId && event.actionId !== actionId) continue;
        events.push(event); if (events.length > limit) events.shift();
    }
    return { events, latestCursor: cursor(journal), dropped: journal.dropped, coverage: 'retained_instrumented_events_only', actionId };
}
function usage() { let bytes = 0; for (const journal of journals) bytes += journal.bytes; return { journals: journals.size, journalBytes: bytes }; }
module.exports = { subscribe, unsubscribe, sample, cursor, read, recent, compact, dialogue, usage };
