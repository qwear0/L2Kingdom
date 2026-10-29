'use strict';

const { z } = require('zod');
const protocol = 'c4-agent/4';
const profile = 'l2solo-c4-656-0293b3ed-p1';
const requestId = z.uuid();
const epoch = z.number().int().min(1).max(0xffffffff);
const revision = z.number().int().min(0).max(0xffffffff);
const credentialFile = z.string().min(1).max(4096);
const instance = z.string().regex(/^[a-f0-9]{32}$/);
const cursor = z.strictObject({ instance, after: revision });
const eventKind = z.enum(['sample', 'epoch_changed', 'session_changed', 'movement_changed', 'physics_changed', 'owner_changed']);
const waitBase = { expectedEpoch: epoch, timeoutMs: z.number().int().min(100).max(30000) };
const schemas = {
    empty: z.strictObject({}),
    action: z.discriminatedUnion('action', [
        z.strictObject({ requestId, expectedEpoch: epoch, action: z.literal('login'), credentialFile }),
        z.strictObject({ requestId, expectedEpoch: epoch, expectedRevision: revision,
            action: z.literal('select_server'), serverId: z.number().int().min(1).max(255) }),
        z.strictObject({ requestId, expectedEpoch: epoch, expectedRevision: revision,
            action: z.literal('select_character'), credentialFile }),
        z.strictObject({ requestId, expectedEpoch: epoch, action: z.literal('move'),
            destination: z.strictObject({ x: z.number().min(-1000000).max(1000000),
                y: z.number().min(-1000000).max(1000000), z: z.number().min(-1000000).max(1000000) }),
            timeoutMs: z.number().int().min(1000).max(15000) }),
        z.strictObject({ requestId, expectedEpoch: epoch, action: z.literal('stop') })
    ]),
    receipt: z.strictObject({ requestId }),
    events: z.strictObject({ cursor, limit: z.number().int().min(1).max(16).default(16) }),
    wait: z.discriminatedUnion('predicate', [
        z.strictObject({ ...waitBase, predicate: z.literal('world_entered') }),
        z.strictObject({ ...waitBase, predicate: z.literal('action_terminal'), requestId }),
        z.strictObject({ ...waitBase, predicate: z.literal('stopped'), requestId }),
        z.strictObject({ ...waitBase, predicate: z.literal('event'), cursor, kind: eventKind })
    ]),
    capture: z.discriminatedUnion('operation', [
        z.strictObject({ operation: z.literal('start'), captureId: requestId, expectedEpoch: epoch,
            durationMs: z.number().int().min(1000).max(10000) }),
        z.strictObject({ operation: z.literal('read'), captureId: requestId,
            offset: z.number().int().min(0).max(256).default(0), limit: z.number().int().min(1).max(16).default(16) }),
        z.strictObject({ operation: z.literal('stop'), captureId: requestId }),
        z.strictObject({ operation: z.literal('export'), captureId: requestId })
    ])
};
const descriptor = z.strictObject({
    protocol: z.literal(protocol), profile: z.literal(profile), instance, pid: z.number().int().positive(),
    host: z.literal('127.0.0.1'), port: z.number().int().min(1).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/)
});
module.exports = { protocol, profile, schemas, descriptor };
