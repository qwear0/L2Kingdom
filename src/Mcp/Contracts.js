'use strict';

const { z } = require('zod');
const ID = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const epoch = z.string().min(1).max(100);
const uuid = z.uuid();
const actorRef = z.strictObject({ characterId: ID, incarnation: uuid });
const namespace = { runtimeEpoch: epoch, sessionId: uuid };
const mutation = { ...namespace, requestId: ID };
const authority = { attachmentId: uuid, leaseId: uuid, controlGeneration: ID };
const point = z.strictObject({ locX: z.number().int().min(-1000000).max(1000000), locY: z.number().int().min(-1000000).max(1000000), locZ: z.number().int().min(-100000).max(100000) });
const entityHandle = z.strictObject({ objectId: ID, incarnation: uuid, kind: z.enum(['actor', 'npc', 'drop']) });
const eventCursor = z.strictObject({ journalId: uuid, sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
const predicate = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('action_terminal'), actionId: uuid }),
    z.strictObject({ kind: z.literal('arrived'), to: point, tolerance: ID.max(64).default(32) }),
    z.strictObject({ kind: z.literal('target_dead'), handle: entityHandle }),
    z.strictObject({ kind: z.literal('effect_present'), skillId: ID }),
    z.strictObject({ kind: z.literal('dialogue_available') }),
    z.strictObject({ kind: z.literal('ai_state'), active: z.boolean(), controller: z.enum(['native_ai', 'manual', 'resuming']).optional() }),
    z.strictObject({ kind: z.literal('events'), cursor: eventCursor }),
    z.strictObject({ kind: z.literal('inventory_revision'), revision: ID })
]);
const command = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('move'), to: point, tolerance: ID.max(64).default(32) }),
    z.strictObject({ kind: z.literal('approach'), targetId: ID, range: ID.max(512).default(80) }),
    z.strictObject({ kind: z.literal('stop') }),
    z.strictObject({ kind: z.literal('target'), targetId: ID.nullable() }),
    z.strictObject({ kind: z.literal('attack'), targetId: ID, until: z.enum(['first_swing', 'target_dead', 'bounded']).default('first_swing'), durationMs: ID.max(60000).default(10000) }),
    z.strictObject({ kind: z.literal('cast'), skillId: ID, targetId: ID.optional() }),
    z.strictObject({ kind: z.literal('state'), property: z.enum(['seated', 'walking']), value: z.boolean() }),
    z.strictObject({ kind: z.literal('item'), itemId: ID }),
    z.strictObject({ kind: z.literal('equip'), itemId: ID, equipped: z.boolean() }),
    z.strictObject({ kind: z.literal('pickup'), groundItemId: ID }),
    z.strictObject({ kind: z.literal('summon'), command: z.enum(['follow', 'stop', 'attack', 'skill', 'unsummon', 'mount', 'dismount']), targetId: ID.optional(), skillId: ID.optional() }),
    z.strictObject({ kind: z.literal('interact'), npc: entityHandle }),
    z.strictObject({ kind: z.literal('service'), revision: uuid, offerId: uuid, amount: ID.max(5000).default(1) }),
    z.strictObject({ kind: z.literal('craft'), recipeId: ID }),
    z.strictObject({ kind: z.literal('drop'), itemId: ID, amount: ID.max(5000) }),
    z.strictObject({ kind: z.literal('pet_inventory'), operation: z.enum(['deposit', 'withdraw', 'use']), itemId: ID, amount: ID.max(5000).default(1) }),
    z.strictObject({ kind: z.literal('chat'), channel: z.enum(['local', 'clan']), text: z.string().trim().min(1).max(256) }),
    z.strictObject({ kind: z.literal('party'), operation: z.enum(['leave', 'invite', 'accept', 'kick', 'distribution']), target: entityHandle.optional(), distribution: z.number().int().min(0).max(4).optional() })
]);
const schemas = Object.freeze({
    status: z.strictObject({}),
    list: z.strictObject({ runtimeEpoch: epoch, ownerCharacterId: ID, offset: z.number().int().min(0).max(100000).default(0), limit: ID.max(50).default(20) }),
    open: z.strictObject({ runtimeEpoch: epoch }),
    attach: z.strictObject({ ...mutation, actorRef }),
    observe: z.strictObject({ ...namespace, attachmentId: uuid, view: z.enum(['perception', 'diagnostic']).default('diagnostic'),
        radius: ID.max(6000).default(1500), limit: ID.max(50).default(20), cursor: uuid.optional() }),
    inspect: z.strictObject({ ...namespace, attachmentId: uuid,
        section: z.enum(['self', 'inventory', 'skills', 'effects', 'quests', 'party', 'summon', 'dialogue', 'entity', 'services', 'recipes', 'pet_inventory']),
        limit: ID.max(50).default(20), cursor: uuid.optional(), handle: entityHandle.optional() }),
    events: z.strictObject({ ...namespace, attachmentId: uuid, cursor: eventCursor.optional(), limit: ID.max(100).default(20) }),
    diagnose: z.strictObject({ ...namespace, attachmentId: uuid, kind: z.enum(['movement', 'combat', 'ai', 'evidence']),
        handle: entityHandle.optional(), actionId: uuid.optional(), checkLos: z.boolean().default(false), gridRadius: z.number().int().min(0).max(4).default(1) }),
    wait: z.strictObject({ ...namespace, attachmentId: uuid, predicate, timeoutMs: ID.max(9000).default(5000) }),
    release: z.strictObject({ ...mutation, attachmentId: uuid }),
    heartbeat: z.strictObject(namespace),
    control: z.strictObject({ ...mutation, attachmentId: uuid, mode: z.enum(['manual', 'keep_control', 'native_ai']), leaseId: uuid.optional(), controlGeneration: ID.optional() }),
    action: z.strictObject({ ...namespace, ...authority, requestId: ID, sequence: ID, timeoutMs: ID.max(120000).default(30000), command }),
    cancel: z.strictObject({ ...mutation, ...authority, actionId: uuid }),
    'action-status': z.strictObject({ ...namespace, actionId: uuid.optional(), leaseId: uuid.optional(), requestId: ID.optional() })
        .refine(value => value.actionId ? !value.leaseId && !value.requestId : !!value.leaseId && !!value.requestId),
    close: z.strictObject(mutation),
    'request-status': z.strictObject({ ...namespace, requestId: ID })
});
const limits = Object.freeze({ observationBytes: 32768, eventBytes: 4096, journalEvents: 512, journalBytes: 1048576,
    queryCursors: 16, queryTtlMs: 30000, queryCandidates: 256, queryCells: 128, waiters: 8,
    observedBots: 8, attachments: 16, sessions: 16, attachmentTtlMs: 120000,
    heartbeatMs: 30000, manualLeases: 4, handoffStates: 12, leaseTtlMs: 120000, manualIdleMs: 600000, pendingActions: 8,
    requestTtlMs: 900000, terminalReceipts: 256, receiptBytes: 1048576,
    requestBytes: 16384, responseBytes: 65536, concurrentRequests: 16 });
function fault(code, statusCode = 400, details = {}) {
    return Object.assign(new Error(code), { code, statusCode, details });
}
function parse(action, payload) {
    const result = schemas[action]?.safeParse(payload);
    if (!result?.success) throw fault('invalid_request');
    return result.data;
}
module.exports = { schemas, limits, fault, parse, actorRef, epoch, ID, authority, command };
