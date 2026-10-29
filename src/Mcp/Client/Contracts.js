'use strict';

const { z } = require('zod');
const protocol = 'c4-agent/1';
const profile = 'l2solo-c4-656-0293b3ed-p1';
const requestId = z.uuid();
const schemas = {
    empty: z.strictObject({}),
    login: z.strictObject({
        requestId,
        expectedEpoch: z.number().int().min(1).max(0xffffffff),
        action: z.literal('login'),
        credentialFile: z.string().min(1).max(4096)
    }),
    receipt: z.strictObject({ requestId })
};
const descriptor = z.strictObject({
    protocol: z.literal(protocol), profile: z.literal(profile), pid: z.number().int().positive(),
    host: z.literal('127.0.0.1'), port: z.number().int().min(1).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/)
});
module.exports = { protocol, profile, schemas, descriptor };
