'use strict';

const { z } = require('zod');
const ID = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const epoch = z.string().min(1).max(100);
const uuid = z.uuid();
const actorRef = z.strictObject({ characterId: ID, incarnation: uuid });
const namespace = { runtimeEpoch: epoch, sessionId: uuid };
const mutation = { ...namespace, requestId: ID };
const schemas = Object.freeze({
    status: z.strictObject({}),
    list: z.strictObject({ runtimeEpoch: epoch, ownerCharacterId: ID, offset: z.number().int().min(0).max(100000).default(0), limit: ID.max(50).default(20) }),
    open: z.strictObject({ runtimeEpoch: epoch }),
    attach: z.strictObject({ ...mutation, actorRef }),
    observe: z.strictObject({ ...namespace, attachmentId: uuid }),
    release: z.strictObject({ ...mutation, attachmentId: uuid }),
    heartbeat: z.strictObject(namespace),
    close: z.strictObject(mutation),
    'request-status': z.strictObject({ ...namespace, requestId: ID })
});
const limits = Object.freeze({ observedBots: 8, attachments: 16, sessions: 16, attachmentTtlMs: 120000,
    heartbeatMs: 30000, requestTtlMs: 900000, terminalReceipts: 256, receiptBytes: 1048576,
    requestBytes: 16384, responseBytes: 65536, concurrentRequests: 16 });
function fault(code, statusCode = 400, details = {}) {
    return Object.assign(new Error(code), { code, statusCode, details });
}
function parse(action, payload) {
    const result = schemas[action]?.safeParse(payload);
    if (!result?.success) throw fault('invalid_request');
    return result.data;
}
module.exports = { schemas, limits, fault, parse, actorRef, epoch, ID };
