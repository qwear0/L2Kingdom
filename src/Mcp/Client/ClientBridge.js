'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomBytes, createHash } = require('node:crypto');
const { z } = require('zod');
const { protocol, profile, descriptor } = require('./Contracts');

function fail(code) { return Object.assign(new Error(code), { code }); }
const credentials = z.strictObject({
    login: z.string().regex(/^[!-~]{1,14}$/),
    password: z.string().regex(/^[!-~]{1,16}$/),
    character: z.string().min(1).max(64).refine(value => !value.includes('\0'))
});

async function privateJson(filename, maximum) {
    if (!path.isAbsolute(filename)) throw fail('private_file_absolute_path_required');
    let file;
    let bytes;
    try {
        const parent = await fs.lstat(path.dirname(filename));
        if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077)) throw fail('private_directory_required');
        file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum) {
            throw fail('private_file_required');
        }
        // Bound reads even if a local writer grows the file after fstat.
        bytes = Buffer.alloc(maximum + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (!bytesRead || bytesRead > maximum) throw fail('private_file_size');
        try { return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); }
        catch { throw fail('private_file_invalid_json'); }
    } catch (error) {
        if (error.message === error.code) throw error;
        throw fail('private_file_unreadable');
    } finally {
        bytes?.fill(0);
        await file?.close();
    }
}

class ClientBridge {
    constructor() {
        this.owner = randomBytes(16).toString('hex');
        this.owned = false;
        this.lost = false;
        this.closed = false;
        this.pending = false;
        this.payloads = new Map();
        this.rejections = new Map();
    }

    async connection() {
        if (this.closed) throw fail('adapter_closed');
        if (!this.connectionPromise) {
            const filename = process.env.C4_CLIENT_SESSION;
            if (!filename) throw fail('session_descriptor_required');
            this.connectionPromise = privateJson(filename, 2048).then(value => {
                const result = descriptor.safeParse(value);
                if (!result.success) throw fail('unsupported_descriptor');
                return result.data;
            });
        }
        return this.connectionPromise;
    }

    async rpc(command, mutation = false) {
        const target = await this.connection();
        if (command.includes('\n') || Buffer.byteLength(command) > 440) throw fail('invalid_rpc_command');
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            let used = 0;
            let sent = false;
            let settled = false;
            const buffer = Buffer.alloc(16384);
            const done = (error, result) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                buffer.fill(0);
                if (error) reject(error); else resolve(result);
            };
            const unavailable = () => done(fail(mutation && sent ? 'rpc_outcome_unknown' : 'rpc_unavailable'));
            socket.setTimeout(3000, unavailable);
            socket.on('error', unavailable);
            socket.on('end', unavailable);
            socket.on('data', chunk => {
                if (used + chunk.length > buffer.length) return done(fail('invalid_rpc_response'));
                chunk.copy(buffer, used);
                used += chunk.length;
                const end = buffer.indexOf(10, 0);
                if (end < 0 || end >= used) return;
                let result;
                try { result = JSON.parse(buffer.subarray(0, end).toString('utf8')); }
                catch { return done(fail('invalid_rpc_response')); }
                if (!result || typeof result !== 'object' || Array.isArray(result)) return done(fail('invalid_rpc_response'));
                done(null, result);
            });
            socket.connect(target.port, target.host, () => {
                sent = true;
                const payload = Buffer.from(`${target.token} ${command}\n`, 'ascii');
                socket.write(payload, () => payload.fill(0));
            });
        });
    }

    async observe() {
        const result = await this.rpc('sample');
        const target = await this.connection();
        if (result.protocol !== protocol || result.profile !== profile || result.pid !== target.pid
            || !Number.isInteger(result.epoch) || !Number.isInteger(result.sequence) || !result.session) throw fail('session_identity_mismatch');
        const names = result.session.characterNamesUtf16le;
        const selected = result.session.selectedCharacterUtf16le;
        const validName = value => typeof value === 'string' && value.length <= 256 && /^(?:[a-f0-9]{4})*$/.test(value);
        if (!Array.isArray(names) || names.length > 7 || !names.every(validName) || !validName(selected)
            || !Array.isArray(result.session.serverIds) || result.session.serverIds.length > 32
            || !result.session.serverIds.every(id => Number.isInteger(id) && id > 0 && id <= 255)) throw fail('invalid_session_lists');
        return { ...result, session: { ...result.session,
            characters: names.map((name, index) => ({ index, name: Buffer.from(name, 'hex').toString('utf16le') })),
            selectedCharacter: selected ? Buffer.from(selected, 'hex').toString('utf16le') : null },
            captureStage: 'post_native_tick', receivedAt: new Date().toISOString(),
            evidence: { pawn: 'client_native', session: 'client_network', mapCompleteness: 'unknown', feetCalibration: 'unavailable' } };
    }

    async status() {
        const sample = await this.observe();
        return { protocol, profile, pid: sample.pid, sequence: sample.sequence, epoch: sample.epoch, ageMs: sample.ageMs,
            tickThread: sample.tickThread, session: sample.session, pawnAvailable: !!sample.pawn,
            movement: sample.movement,
            capabilities: ['client_status', 'client_observe', 'login', 'select_server', 'select_character', 'move', 'stop', 'client_action_status'],
            unavailable: ['consent_automation', 'security_pad_answers', 'events', 'wait', 'capture', 'correction_classification', 'calibrated_geometry'],
            control: { owned: this.owned, lost: this.lost, disconnect: 'Release/15s lease expiry revokes queued commands and requests native stop for foreground movement. Inspect movement.stop: dispatch is not stationary confirmation. Dispatched session actions are not undone.' } };
    }

    async claim() {
        if (this.lost) throw fail('owner_lost');
        if (this.owned) return;
        const result = await this.rpc(`claim ${this.owner}`, true);
        if (result.error) throw fail(result.error);
        this.owned = true;
        this.heartbeat = setInterval(() => {
            if (this.heartbeatPending || this.closed || this.lost) return;
            this.heartbeatPending = true;
            void this.rpc(`keep ${this.owner}`).then(result => {
                if (result.error) { this.lost = true; this.owned = false; clearInterval(this.heartbeat); }
            }, () => { this.lost = true; this.owned = false; clearInterval(this.heartbeat); })
                .finally(() => { this.heartbeatPending = false; });
        }, 3000);
        this.heartbeat.unref();
    }

    async action(input) {
        if (this.pending) throw fail('adapter_action_busy');
        this.pending = true;
        let accountBytes;
        let passwordBytes;
        let characterBytes;
        try {
            const id = input.requestId.replaceAll('-', '').toLowerCase();
            const replay = this.payloads.has(id);
            if (!replay) {
                const sample = await this.observe();
                if (sample.epoch !== input.expectedEpoch) throw fail('stale_epoch');
                if (['select_server', 'select_character'].includes(input.action) && sample.session.revision !== input.expectedRevision) throw fail('stale_revision');
            }
            let payload;
            if (input.action === 'move') {
                payload = `move ${id} ${input.expectedEpoch} ${input.destination.x} ${input.destination.y} ${input.destination.z} ${input.timeoutMs}`;
            } else if (input.action === 'stop') {
                payload = `stop ${id} ${input.expectedEpoch}`;
            } else if (input.action === 'select_server') {
                payload = `server ${id} ${input.expectedEpoch} ${input.expectedRevision} ${input.serverId}`;
            } else {
                const parsed = credentials.safeParse(await privateJson(input.credentialFile, 4096));
                if (!parsed.success) throw fail('credentials_shape_unsupported');
                if (input.action === 'login') {
                    accountBytes = Buffer.from(parsed.data.login, 'utf16le');
                    passwordBytes = Buffer.from(parsed.data.password, 'utf16le');
                    payload = `login ${id} ${input.expectedEpoch} ${accountBytes.toString('hex')} ${passwordBytes.toString('hex')}`;
                } else if (input.action === 'select_character') {
                    characterBytes = Buffer.from(parsed.data.character, 'utf16le');
                    payload = `char ${id} ${input.expectedEpoch} ${input.expectedRevision} ${characterBytes.toString('hex')}`;
                } else throw fail('unsupported_action');
            }
            // JS strings cannot be reliably zeroed. Do not retain parsed data,
            // wire payloads, secrets, or secret-derived hashes in tool results.
            const digest = createHash('sha256').update(payload).digest('hex');
            if (this.payloads.has(id) && this.payloads.get(id) !== digest) throw fail('request_conflict');
            if (!this.payloads.has(id) && this.payloads.size >= 32) throw fail('receipt_capacity');
            if (this.rejections.has(id)) return this.rejections.get(id);
            if (!replay) await this.claim();
            this.payloads.set(id, digest);
            const split = payload.indexOf(' ');
            const result = { ...this.normalizeReceipt(await this.rpc(`${payload.slice(0, split)} ${this.owner} ${payload.slice(split + 1)}`, true), input.requestId),
                guidance: 'Queued/dispatched is not completion. Inspect client_observe and the original receipt. Movement outcomes use native progress/stationarity; reached_xy_stopped does not establish floor/contact or vertical arrival. A void native call has nativeReturn=null. Never retry an uncertain action with a new requestId.' };
            if (result.error) this.rejections.set(id, result);
            return result;
        } finally {
            accountBytes?.fill(0);
            passwordBytes?.fill(0);
            characterBytes?.fill(0);
            this.pending = false;
        }
    }

    normalizeReceipt(result, requestId) {
        if (result.error) return result;
        if (result.requestId !== requestId.replaceAll('-', '').toLowerCase() || !Number.isInteger(result.epoch)
            || !['login', 'select_server', 'select_character', 'move', 'stop'].includes(result.action)
            || !['queued', 'dispatched', 'stale_epoch', 'owner_lost', 'native_unavailable', 'native_rejected', 'queue_expired', 'stale_revision'].includes(result.status)
            || (['move', 'stop'].includes(result.action) ? result.nativeReturn !== null : !Number.isInteger(result.nativeReturn))
            || !['not_observed', 'pending', 'moving', 'reached_xy_stopped', 'stopped', 'stalled', 'timed_out', 'interrupted', 'world_lost', 'manual_override', 'unknown'].includes(result.outcome)
            || !['not_requested', 'pending', 'dispatched', 'observed_stopped', 'unconfirmed'].includes(result.stop)) throw fail('invalid_receipt');
        return { ...result, requestId: requestId.toLowerCase() };
    }

    async receipt({ requestId }) {
        return this.normalizeReceipt(await this.rpc(`receipt ${requestId.replaceAll('-', '').toLowerCase()}`), requestId);
    }

    async close() {
        clearInterval(this.heartbeat);
        if (this.owned) {
            const result = await this.rpc(`release ${this.owner}`, true);
            if (result.error) throw fail(result.error);
        }
        this.owned = false;
        this.closed = true;
    }
}
module.exports = ClientBridge;
