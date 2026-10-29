'use strict';

const C = require('./GameDashboardContract');

class GameAccountService {
    constructor(store, controller) {
        this.store = store;
        this.controller = controller;
        this.verifications = new Map();
        this.attempts = new Map();
        this.epoch = 0;
    }

    current(principal) { return { link: this.store.gameAccount(principal) }; }

    checkRevision(principal, expected) {
        const link = this.store.gameAccount(principal);
        if ((link?.linkRevision ?? null) !== expected) throw C.failure('stale_link');
        return link;
    }

    limit(principal, peer) {
        const now = Date.now();
        for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
        const keys = [`user:${principal}`, `peer:${peer}`];
        if (keys.some(key => !this.attempts.has(key)) && this.attempts.size > 2046) throw C.failure('rate_limited');
        for (const key of keys) {
            const entry = this.attempts.get(key) || { count: 0, until: now + 60000 };
            this.attempts.set(key, entry);
            if (++entry.count > (key.startsWith('user:') ? 10 : 20)) throw C.failure('rate_limited');
        }
    }

    async link(principal, peer, payload) {
        const credentials = C.credentials(payload);
        // Drop the route's body reference; only the bounded IPC request needs the password.
        delete payload.password;
        this.limit(principal, peer);
        if (this.verifications.has(principal) || this.verifications.size >= 32) throw C.failure('busy');
        this.checkRevision(principal, payload.expectedLinkRevision);
        const controller = this.controller;
        const pending = { epoch: this.epoch, generation: controller.generation, child: controller.child, cancelled: false };
        this.verifications.set(principal, pending);
        try {
            const result = await controller.gameRuntime('gameAccount.verify', credentials);
            if (pending.cancelled || this.epoch !== pending.epoch) throw C.failure('stale_link');
            if (controller.closing || controller.phase !== 'running' || controller.generation !== pending.generation
                || controller.child !== pending.child || !controller.child?.connected) throw C.failure('runtime_unavailable');
            if (!C.account(result?.accountName) || result.accountName.toLowerCase() !== credentials.login.toLowerCase()) throw C.failure('runtime_unavailable');
            return { link: this.store.replaceGameAccount(principal, result.accountName, payload.expectedLinkRevision) };
        } finally {
            delete credentials.password;
            if (this.verifications.get(principal) === pending) this.verifications.delete(principal);
        }
    }

    unlink(principal, payload) {
        C.fields(payload, ['expectedLinkRevision']);
        if (!C.revision(payload.expectedLinkRevision)) throw C.failure('invalid_request');
        this.checkRevision(principal, payload.expectedLinkRevision);
        // Unlink is synchronous admission, not a queued task behind verification.
        // Cancel its commit permission so even a late successful reply cannot relink.
        const pending = this.verifications.get(principal);
        if (pending) pending.cancelled = true;
        this.store.unlinkGameAccount(principal, payload.expectedLinkRevision);
        return { link: null };
    }

    invalidate(scope) {
        ++this.epoch;
        this.store.invalidateGameAccounts(scope);
    }

    async read(principal, includeSkills) {
        const { link } = this.current(principal);
        if (!link) return { availability: 'unlinked' };
        try {
            const state = await this.controller.gameRuntime('gameDashboard.read', {
                accountName: link.accountName, linkRevision: link.linkRevision, includeSkills
            });
            this.checkRevision(principal, link.linkRevision);
            return state;
        } catch (error) {
            if (['runtime_unavailable', 'runtime_timeout', 'dashboard_not_ready'].includes(error.code)) {
                return { availability: 'unavailable', code: error.code };
            }
            throw error;
        }
    }

    command(principal, payload) {
        C.action(payload);
        if (this.verifications.has(principal)) throw C.failure('busy');
        const link = this.checkRevision(principal, payload.context.linkRevision);
        if (!link) throw C.failure('unlinked');
        // No await between ownership/revision admission and dispatch. An admitted
        // command may finish after Unlink; subsequent commands cannot be admitted.
        return this.controller.gameRuntime('gameDashboard.action', { accountName: link.accountName, command: payload });
    }
}

module.exports = GameAccountService;
