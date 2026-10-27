'use strict';

const http = require('http');
const { limits, fault } = require('./Contracts');
const BASE = '/observer/api/bot-control/';

class GameBridge {
    constructor(env = process.env) {
        const url = new URL(env.L2NODE_BOT_CONTROL_URL || 'http://127.0.0.1:8088');
        if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
            || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fault('invalid_management_origin');
        this.origin = url;
        this.token = env.L2NODE_BOT_CONTROL_TOKEN || '';
        if (!/^[A-Za-z0-9_-]{32,256}$/.test(this.token)) throw fault('bot_control_credentials_unconfigured');
        this.session = null;
        this.openUncertain = false;
        this.closing = false;
        this.heartbeat = null;
        this.heartbeatError = null;
        this.tail = Promise.resolve();
        this.queued = 0;
        this.inFlight = 0;
        this.lastIssued = 0;
        this.leaseGrantHighWater = 0;
        this.leases = new Map();
    }
    async request(action, payload = {}) {
        if (this.inFlight >= limits.concurrentRequests) throw fault('request_capacity', 429);
        this.inFlight++;
        try {
            return await new Promise((resolve, reject) => {
                const body = action === 'status' ? null : Buffer.from(JSON.stringify(payload));
                const request = http.request({ hostname: this.origin.hostname.replace(/^\[|\]$/g, ''),
                    port: this.origin.port || 80, method: body ? 'POST' : 'GET', path: BASE + action,
                    headers: { 'x-l2-bot-control-token': this.token,
                        ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) } }, response => {
                    let bytes = 0; const chunks = [];
                    response.on('data', chunk => {
                        bytes += chunk.length;
                        if (bytes > limits.responseBytes) request.destroy(fault('response_too_large', 502));
                        else chunks.push(chunk);
                    });
                    response.on('aborted', () => reject(fault('management_response_interrupted', 502)));
                    response.on('error', () => reject(fault('management_response_interrupted', 502)));
                    response.on('end', () => {
                        try {
                            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
                            if (response.statusCode !== 200) {
                                const details = data.error && typeof data.error === 'object' ? data.error : {};
                                reject(fault(details.code || 'management_request_failed', response.statusCode,
                                    { ...details, httpStatus: response.statusCode }));
                            } else resolve(data);
                        } catch (_) { reject(fault('invalid_management_response', 502)); }
                    });
                });
                const deadline = setTimeout(() => request.destroy(fault('management_timeout', 504)), 14000);
                request.once('close', () => clearTimeout(deadline));
                request.once('error', error => reject(error.statusCode ? error : fault('management_unavailable', 503)));
                request.end(body);
            });
        } finally { this.inFlight--; }
    }
    async establish(runtimeEpoch) {
        if (this.session) {
            if (this.session.runtimeEpoch !== runtimeEpoch) throw fault('stale_bridge_session', 409);
            return;
        }
        if (this.openUncertain) throw fault('session_establishment_unknown_restart_bridge', 409);
        // Opening is explicit through the first attach, never a hidden recovery.
        // An uncertain reply may have allocated a namespace; do not retry it.
        this.openUncertain = true;
        this.session = await this.request('open', { runtimeEpoch });
        this.openUncertain = false;
        this.heartbeat = setInterval(() => {
            this.request('heartbeat', this.identity()).then(() => { this.heartbeatError = null; })
                .catch(error => { this.heartbeatError = error.code; });
        }, limits.heartbeatMs);
        this.heartbeat.unref();
    }
    identity() {
        if (!this.session) throw fault('bridge_not_attached', 409);
        return { runtimeEpoch: this.session.runtimeEpoch, sessionId: this.session.sessionId };
    }
    async status() {
        const status = await this.request('status');
        return { ...status, bridge: { connected: Boolean(this.session), sessionId: this.session?.sessionId || null,
            runtimeEpoch: this.session?.runtimeEpoch || null, lastIssuedRequestId: this.lastIssued,
            heartbeatError: this.heartbeatError, establishmentUncertain: this.openUncertain } };
    }
    mutate(action, input) {
        if (this.closing) return Promise.reject(fault('bridge_closing', 409));
        if (this.queued >= limits.concurrentRequests) return Promise.reject(fault('request_capacity', 429));
        this.queued++;
        const work = this.tail.then(async () => {
            if (this.closing) throw fault('bridge_closing', 409);
            if (action === 'attach') await this.establish(input.runtimeEpoch);
            const identity = this.identity();
            if (identity.runtimeEpoch !== input.runtimeEpoch) throw fault('stale_bridge_session', 409);
            this.lastIssued = Math.max(this.lastIssued, input.requestId);
            const result = await this.request(action, { ...input, ...identity });
            const grant = result.status === 'succeeded' && result.result;
            // A retained old grant must not recreate evicted sequencing state.
            // Only a newly observed acquisition can start a bridge lease context.
            if (action === 'control' && input.mode === 'manual' && grant?.leaseId && !this.leases.has(grant.leaseId)
                && result.requestId > this.leaseGrantHighWater) {
                this.leaseGrantHighWater = result.requestId;
                while (this.leases.size >= 16) this.leases.delete(this.leases.keys().next().value);
                this.leases.set(grant.leaseId, { sequence: grant.nextSequence - 1, highWater: 0, requests: new Map(), tail: Promise.resolve() });
            }
            return result;
        }).finally(() => { this.queued--; });
        this.tail = work.catch(() => {});
        return work;
    }
    gameplay(input) {
        if (this.closing) return Promise.reject(fault('bridge_closing', 409));
        const lease = this.leases.get(input.leaseId);
        if (!lease) return Promise.reject(fault('bridge_sequence_expired', 410));
        if (this.queued >= limits.concurrentRequests) return Promise.reject(fault('request_capacity', 429));
        this.queued++;
        const work = lease.tail.then(() => {
            if (this.closing) throw fault('bridge_closing', 409);
            const identity = this.identity();
            if (input.runtimeEpoch !== identity.runtimeEpoch) throw fault('stale_bridge_session', 409);
            let sequence = lease.requests.get(input.requestId);
            if (!sequence) {
                if (input.requestId <= lease.highWater) throw fault('request_expired', 410);
                sequence = ++lease.sequence; lease.highWater = input.requestId;
                if (lease.requests.size >= limits.terminalReceipts) lease.requests.delete(lease.requests.keys().next().value);
                lease.requests.set(input.requestId, sequence);
            }
            return this.request('action', { ...input, ...identity, sequence });
        }).finally(() => { this.queued--; });
        lease.tail = work.catch(() => {});
        return work;
    }
    read(action, input) {
        if (this.closing) throw fault('bridge_closing', 409);
        return this.request(action, { ...input, ...this.identity() });
    }
    async close() {
        if (this.closing) return;
        this.closing = true;
        if (this.heartbeat) clearInterval(this.heartbeat);
        await Promise.all([this.tail, ...[...this.leases.values()].map(lease => lease.tail)]);
        if (this.session) {
            try {
                const current = await this.request('heartbeat', this.identity());
                await this.request('close', { ...this.identity(), requestId: current.nextRequestId });
            } catch (error) {
                if (error.code !== 'session_expired') throw error;
            }
        }
    }
}
module.exports = GameBridge;
