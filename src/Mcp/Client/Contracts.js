'use strict';

const { z } = require('zod');
const protocol = 'c4-agent/2';
const profile = 'l2solo-c4-656-0293b3ed-p1';
const requestId = z.uuid();
const epoch = z.number().int().min(1).max(0xffffffff);
const revision = z.number().int().min(0).max(0xffffffff);
const credentialFile = z.string().min(1).max(4096);
const schemas = {
    empty: z.strictObject({}),
    action: z.discriminatedUnion('action', [
        z.strictObject({ requestId, expectedEpoch: epoch, action: z.literal('login'), credentialFile }),
        z.strictObject({ requestId, expectedEpoch: epoch, expectedRevision: revision,
            action: z.literal('select_server'), serverId: z.number().int().min(1).max(255) }),
        z.strictObject({ requestId, expectedEpoch: epoch, expectedRevision: revision,
            action: z.literal('select_character'), credentialFile })
    ]),
    receipt: z.strictObject({ requestId })
};
const descriptor = z.strictObject({
    protocol: z.literal(protocol), profile: z.literal(profile), pid: z.number().int().positive(),
    host: z.literal('127.0.0.1'), port: z.number().int().min(1).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/)
});
module.exports = { protocol, profile, schemas, descriptor };
