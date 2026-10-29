'use strict';

const { timingSafeEqual } = require('crypto');
const C = require('./GameDashboardContract');
const generation = process.env.L2NODE_MANAGED_GENERATION;

async function dispatch(type, payload, current) {
    if (type === 'gameAccount.verify') {
        // Use the existing game-process DB owner, never AuthLogin: that adapter
        // can auto-create accounts and attaches a native authentication session.
        const rows = await invoke('Database').fetchUserPassword(payload.login);
        if (!current()) throw C.failure('runtime_unavailable');
        const account = rows[0];
        if (!account || !C.account(account.username) || typeof account.password !== 'string' || !account.password) throw C.failure('invalid_credentials');
        const submitted = Buffer.from(payload.password.trim(), 'utf8');
        const stored = Buffer.from(account.password, 'utf8');
        if (submitted.length !== stored.length || !timingSafeEqual(submitted, stored)) throw C.failure('invalid_credentials');
        return { accountName: account.username };
    }
    // P1 establishes the authenticated transport only. P2 supplies authoritative
    // actor/card/run fences and gameplay dispatch; never invent an offline state.
    throw C.failure('dashboard_not_ready');
}

function install(isUnavailable) {
    if (!generation || !process.send) return;
    const active = new Set();
    process.on('message', message => {
        if (message?.v !== 1 || message.generation !== generation || !C.REQUEST_TYPES.includes(message.type)
            || typeof message.requestId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(message.requestId)) return;
        const current = () => process.connected && !isUnavailable() && Number.isFinite(message.expiresAt)
            && message.expiresAt > Date.now() && message.expiresAt <= Date.now() + 5000;
        const reply = body => {
            if (process.connected) process.send({ v: 1, generation, type: 'game.reply', requestId: message.requestId, ...body }, () => {});
        };
        if (active.has(message.requestId)) return;
        if (!current()) { reply({ code: 'runtime_unavailable' }); return; }
        if (active.size >= 32) { reply({ code: 'busy' }); return; }
        active.add(message.requestId);
        (async () => {
            try {
                C.runtimePayload(message.type, message.payload);
                const result = await dispatch(message.type, message.payload, current);
                if (!current()) throw C.failure('runtime_unavailable');
                if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 262144) throw C.failure('runtime_unavailable');
                reply({ result });
            } catch (error) {
                reply({ code: Object.hasOwn(C.REASONS, error.code) ? error.code : 'runtime_unavailable' });
            } finally {
                if (message.type === 'gameAccount.verify' && message.payload) delete message.payload.password;
                active.delete(message.requestId);
            }
        })();
    });
}

module.exports = { install };
