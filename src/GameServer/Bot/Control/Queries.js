'use strict';

const { randomUUID } = require('crypto');
const { limits, fault } = require('../../../Mcp/Contracts');
const { steps } = require('../../World/BoundedCellQuery');
const { NPC_GRID_SIZE } = require('../../World/WorldConstants');
const Ground = require('../../World/GroundItemIndex');
const Npcs = require('../../World/NpcObjectIndex');
const Journal = require('./Journal');
const World = invoke('GameServer/World/World');
const cursors = new Map(), incarnations = new WeakMap();
const point = actor => ({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
function handle(entity, kind) {
    let incarnation = incarnations.get(entity);
    if (!incarnation) { incarnation = randomUUID(); incarnations.set(entity, incarnation); }
    return { objectId: entity.fetchId(), incarnation, kind };
}
function local(actor, entity, radius) {
    return Math.hypot(actor.fetchLocX() - entity.fetchLocX(), actor.fetchLocY() - entity.fetchLocY()) <= radius;
}
function resolve(actor, input) {
    const entity = input.kind === 'actor' ? World.registeredActorById(input.objectId)?.actor
        : input.kind === 'drop' ? Ground.find(World, input.objectId) : Npcs.find(World, input.objectId);
    if (!entity || incarnations.get(entity) !== input.incarnation) throw fault('stale_entity_handle', 409);
    if (!local(actor, entity, 6000)) throw fault('entity_outside_local_range', 409);
    return entity;
}
function row(entity, kind, origin, view) {
    const location = point(entity), dx = location.locX - origin.locX, dy = location.locY - origin.locY;
    const base = { handle: handle(entity, kind), templateId: entity.fetchSelfId?.() ?? null,
        name: String(entity.fetchName?.() || '').slice(0, 64), position: location,
        distance: Math.hypot(dx, dy), bearingRadians: Math.atan2(dy, dx), elevationDelta: location.locZ - origin.locZ,
        nearby: true, visible: 'unknown', reachable: 'unknown',
        attackableHint: entity.fetchAttackable?.() ?? false, interactableHint: kind === 'npc' && entity.fetchAttackable?.() !== true };
    if (kind === 'drop') base.amount = entity.fetchAmount();
    else {
        base.dead = entity.isDead?.() ?? entity.state?.fetchDead?.() ?? null;
        base.combatTargetId = view === 'diagnostic' ? entity.combatTarget?.fetchId?.() || null : null;
        base.vitals = view === 'diagnostic' ? { hp: entity.fetchHp?.() ?? null, maxHp: entity.fetchMaxHp?.() ?? null } : null;
    }
    return base;
}
function* scene(origin, radius) {
    for (const step of World.actorQuerySteps(origin, radius)) {
        const record = step.entity;
        if (record) yield { entity: record.actor, kind: 'actor', record };
        else yield step;
    }
    for (const step of steps(origin, radius, NPC_GRID_SIZE, key => World.npc.grid[key])) yield { ...step, kind: 'npc' };
    for (const step of Ground.near(World, origin, radius)) yield { ...step, kind: 'drop' };
}
function* properties(object) {
    for (const key in object || {}) if (Object.hasOwn(object, key)) yield object[key];
}
function collection(attachment, section) {
    const { actor, session } = attachment.record;
    return section === 'inventory' ? actor.backpack.fetchItems() : section === 'skills' ? actor.skillset.fetchSkills()
        : section === 'effects' ? actor.effects : section === 'quests' ? session.questStates : null;
}
function details(attachment, section) {
    const { actor, session } = attachment.record;
    if (section === 'inventory') return actor.backpack.fetchItems().values();
    if (section === 'skills') return actor.skillset.fetchSkills().values();
    if (section === 'effects') return properties(actor.effects);
    if (section === 'quests') return (session.questStates || new Map()).values();
    if (section === 'party') return World.actorPartyEntries(session);
    throw fault('detail_unavailable', 409);
}
function questVariables(variables) {
    const values = Object.create(null); let count = 0;
    for (const key in variables || {}) {
        if (!Object.hasOwn(variables, key)) continue;
        if (++count > 8) break;
        const value = variables[key];
        values[key.slice(0, 64)] = typeof value === 'string' ? value.slice(0, 128)
            : typeof value === 'number' || typeof value === 'boolean' ? value : null;
    }
    return { values, partial: count > 8, source: 'loaded_native_state' };
}
function detailRow(value, section, actor) {
    if (section === 'inventory') return { objectId: value.fetchId(), templateId: value.fetchSelfId(),
        name: String(value.fetchName?.() || '').slice(0, 64), amount: value.fetchAmount(), equipped: value.fetchEquipped(), enchant: value.fetchEnchantLevel?.() ?? null };
    if (section === 'skills') return { skillId: value.fetchSelfId(), level: value.fetchLevel?.() ?? null,
        name: String(value.fetchName?.() || '').slice(0, 64), targetKind: value.fetchTargetKind(),
        mpCost: value.fetchConsumedMp?.() ?? null, nativeCanUseNow: actor.canUseSkill(value) };
    if (section === 'effects') return value.expiresAt && value.expiresAt <= Date.now() ? null
        : { skillId: value.id, key: String(value.key).slice(0, 64), level: value.level, type: value.type,
            remainingMs: value.expiresAt ? Math.max(0, value.expiresAt - Date.now()) : null };
    if (section === 'quests') return value.actorId !== actor.fetchId() ? null : { questId: value.quest.id, state: value.state,
        name: String(value.quest.name || '').slice(0, 64), variables: questVariables(value.variables) };
    if (section === 'party') return !value.retired && value.actor && World.registeredActorById(value.id) === value ? { characterId: value.id,
        name: String(value.actor.fetchName()).slice(0, 64), online: value.actor.fetchIsOnline() === true } : null;
    return null;
}
function prune() { for (const [id, cursor] of cursors) if (Date.now() >= cursor.expiresAt) cursors.delete(id); }
function close(id) { for (const [key, cursor] of cursors) if (cursor.attachmentId === id) cursors.delete(key); }
function page(attachment, input, section = 'scene') {
    prune();
    const actor = attachment.record.actor;
    const fingerprint = JSON.stringify([section, input.radius ?? null, input.view ?? null]);
    let query;
    if (input.cursor) {
        query = cursors.get(input.cursor);
        if (!query || query.attachmentId !== attachment.id) throw fault('query_cursor_expired', 410);
        if (query.fingerprint !== fingerprint) throw fault('query_cursor_conflict', 409);
    } else {
        if (cursors.size >= limits.queryCursors) throw fault('query_capacity', 429);
        query = { id: randomUUID(), attachmentId: attachment.id, fingerprint, origin: point(actor), section,
            expiresAt: Date.now() + limits.queryTtlMs, sampledAt: Date.now() };
        query.source = collection(attachment, section);
        query.iterator = section === 'scene' ? scene(query.origin, input.radius) : details(attachment, section);
        cursors.set(query.id, query);
    }
    if (section !== 'scene' && query.source !== collection(attachment, section)) {
        cursors.delete(query.id); throw fault('detail_collection_changed', 409);
    }
    if (section === 'scene' && (Math.hypot(actor.fetchLocX() - query.origin.locX, actor.fetchLocY() - query.origin.locY) > 128
        || Math.abs(actor.fetchLocZ() - query.origin.locZ) > 64)) {
        cursors.delete(query.id); throw fault('query_origin_changed', 409);
    }
    const rows = []; let candidates = 0, cells = 0, bytes = 0, done = false;
    while (rows.length < input.limit && candidates < limits.queryCandidates && cells < limits.queryCells) {
        const next = query.buffer ? { value: query.buffer, done: false } : query.iterator.next(); query.buffer = null;
        if (next.done) { done = true; break; }
        let projected;
        if (section === 'scene') {
            const step = next.value;
            if (step.cell) { cells++; continue; }
            candidates++;
            const entity = step.entity;
            if (!entity || entity === actor || (step.record && (step.record.retired || World.registeredActorById(step.record.id) !== step.record))) continue;
            if (step.kind === 'npc' && Npcs.find(World, entity.fetchId()) !== entity) continue;
            if (step.kind === 'drop' && Ground.find(World, entity.fetchId()) !== entity) continue;
            if (Math.hypot(entity.fetchLocX() - query.origin.locX, entity.fetchLocY() - query.origin.locY) > input.radius) continue;
            if (input.view === 'perception' && Math.abs(entity.fetchLocZ() - query.origin.locZ) > 512) continue;
            if (entity.fetchIsOnline?.() === false || entity.corpseDecayState === 'removed') continue;
            projected = row(entity, step.kind, query.origin, input.view);
        } else { candidates++; projected = detailRow(next.value, section, actor); }
        if (!projected) continue;
        const size = Buffer.byteLength(JSON.stringify(projected));
        if (bytes + size > 22000) { query.buffer = next.value; break; }
        rows.push(projected); bytes += size;
    }
    if (done) cursors.delete(query.id);
    return { section, view: input.view || 'diagnostic', source: 'live_native_index', rows, origin: query.origin,
        sampledAt: Date.now(), queryStartedAt: query.sampledAt, nextCursor: done ? null : query.id,
        incomplete: !done, work: { candidates, cells, rowBytes: bytes },
        consistency: 'live_cursor_not_snapshot; movement/removal can cause omissions or duplicates',
        sort: 'native_cell_order_not_nearest', inventoryRevision: null,
        ...(section === 'quests' ? { loaded: attachment.record.session.questStatesLoaded === true } : {}),
        ...(section === 'party' ? { coverage: 'registered_live_memberships_only; offline membership unavailable' } : {}) };
}
function inspect(attachment, input) {
    const { actor, session } = attachment.record;
    if (input.section === 'entity') {
        if (!input.handle) throw fault('entity_handle_required');
        return { section: 'entity', view: 'diagnostic', sampledAt: Date.now(), entity: row(resolve(actor, input.handle), input.handle.kind, point(actor), 'diagnostic') };
    }
    if (input.section === 'summon') {
        const summon = invoke('GameServer/Npc/SummonControl').activeSummon(actor);
        return { section: 'summon', sampledAt: Date.now(), summon: summon ? { ...row(summon, 'npc', point(actor), 'diagnostic'),
            ownerId: summon.fetchOwnerId(), controlMode: summon.controlMode || null } : null };
    }
    if (input.section === 'dialogue') {
        const current = session.activeNpcTalk, text = session.mcpObservation.dialogue;
        return { section: 'dialogue', sampledAt: Date.now(), context: current ? Journal.compact(current) : null,
            dialogue: current?.objectId === text?.objectId ? text : null, textCoverage: 'selected_native_html_publishers_only',
            optionsUnavailable: 'P4_adapter_not_enabled', untrusted: true };
    }
    return page(attachment, input, input.section);
}
module.exports = { page, inspect, close, prune, point, resolve, handle, row, usage: () => ({ queryCursors: cursors.size }) };
