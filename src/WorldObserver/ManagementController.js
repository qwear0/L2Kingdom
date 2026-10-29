'use strict';

const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const Config = require('../ConfigLoader');
const Descriptors = require('./SettingsDescriptors');
const PresetStore = require('./ManagementPresetStore');
const SavedGames = require('../../scripts/saved-games');
const { acquireDatabaseAccess } = require('../../scripts/database-access');
const HistoryStore = require('../HistoryStore');
const GameContract = require('./GameDashboardContract');

class ManagementController {
    constructor() {
        this.phase = 'stopped';
        this.child = null;
        this.generation = null;
        this.endpoint = null;
        this.observerState = 'unavailable';
        this.startedAt = null;
        this.activePreset = null;
        this.lastExit = null;
        this.shutdownOutcome = 'unknown';
        this.treeConfirmed = true;
        this.operation = null;
        this.lastOperation = null;
        this.requests = new Map();
        this.logs = [];
        this.presets = new PresetStore();
        const runtime = Config.resolve(process.env.L2NODE_RUNTIME_DIR || 'tmp');
        this.savesDir = path.join(runtime, 'saves');
        this.logsDir = Config.resolve(process.env.L2NODE_LOG_DIR || path.join(runtime, 'logs'));
        this.latestLog = path.join(this.logsDir, 'latest-server.log');
        this.previousLog = path.join(this.logsDir, 'previous-server.log');
        this.llm = null;
        this.llmFingerprint = null;
        this.llmPromise = null;
        this.closing = false;
        this.invalidateGameAccounts = null;
    }
    config() { return Config.load(); }
    databasePaths() {
        const config = this.config().effective.Database || {};
        const world = Config.resolve(config.path || 'tmp/nodel2.sqlite');
        return { world, history: HistoryStore.pathFor(world, config.historyPath || '', Config.ROOT) };
    }
    append(source, chunk) {
        for (const raw of String(chunk).split(/\r?\n/).filter(Boolean)) {
            const line = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(0, 8192);
            this.logs.push({ at: Date.now(), source, line });
            try { fs.appendFileSync(this.latestLog, `[${new Date().toISOString()}] [${source}] ${line}\n`); }
            catch (_) { console.warn('Management :: could not append server log'); }
        }
        this.logs = this.logs.slice(-80);
    }
    public() {
        const config = this.config().effective;
        const observerEnabled = Descriptors.bool(config.WorldObserver?.enabled, true);
        return { phase: this.phase, generation: this.generation, pid: this.child?.pid || null,
            startedAt: this.startedAt, uptimeMs: this.child ? Date.now() - this.startedAt : 0,
            readiness: this.phase === 'running', observer: this.child ? this.observerState : !observerEnabled ? 'disabled' : 'unavailable',
            listeners: { management: 'listening', auth: this.phase === 'running' ? 'ready' : 'not confirmed', game: this.phase === 'running' ? 'ready' : 'not confirmed' },
            mapUrl: this.phase === 'running' && this.endpoint ? '/observer/' : null,
            logUrl: '/observer/api/server/logs', logFile: path.basename(this.latestLog),
            activePreset: this.child ? this.activePreset : null, preset: this.presets.public(),
            lastExit: this.lastExit, shutdownOutcome: this.shutdownOutcome, treeConfirmed: this.treeConfirmed,
            operation: this.operation, lastOperation: this.lastOperation, logs: this.logs.slice(-40),
            llm: this.inferenceState(), version: require('../../package.json').version,
            configSources: ['default.ini', ...(process.env.L2NODE_SHARED_CONFIG_FILE ? ['shared file'] : []), process.env.L2NODE_CONFIG_FILE ? 'selected local file' : 'local.ini'] };
    }
    reserve(kind, stopped = false) {
        if (this.closing || this.operation) throw Config.error('Management is busy; inspect status before retrying.', 409);
        if (stopped && (this.child || !this.treeConfirmed || !['stopped', 'error'].includes(this.phase))) throw Config.error('Fully stop the game and confirm child exit before this operation.', 409);
        this.operation = { id: randomUUID(), kind, startedAt: Date.now() };
        return this.operation;
    }
    finish(operation, outcome, details = {}) {
        if (this.operation?.id !== operation.id) return;
        this.lastOperation = { ...operation, outcome, finishedAt: Date.now(), ...details };
        this.operation = null;
    }
    async start() {
        const operation = this.reserve('start', true);
        try {
            const { selected } = this.presets.read();
            Descriptors.validateRates(this.config().effective);
            const release = acquireDatabaseAccess(this.databasePaths().world); release();
            fs.mkdirSync(this.logsDir, { recursive: true });
            if (fs.existsSync(this.latestLog)) fs.copyFileSync(this.latestLog, this.previousLog);
            fs.writeFileSync(this.latestLog, `WorldObserver managed game log\nStarted: ${new Date().toISOString()}\n`);
            this.logs = []; this.endpoint = null; this.observerState = 'unavailable'; this.startedAt = Date.now(); this.lastExit = null;
            this.phase = 'starting'; this.activePreset = selected; this.shutdownOutcome = 'unknown'; this.treeConfirmed = false;
            const generation = this.generation = randomUUID();
            const child = this.child = spawn(process.execPath, ['scripts/run-server.js'], {
                cwd: Config.ROOT, env: { ...process.env, L2NODE_PROGRESSION_RATE: selected, L2NODE_MANAGED_GENERATION: generation },
                stdio: ['ignore', 'pipe', 'pipe', 'ipc']
            });
            this.append('management', `starting wrapper ${child.pid || 'pending'}`);
            child.stdout.on('data', chunk => this.append('stdout', chunk));
            child.stderr.on('data', chunk => this.append('stderr', chunk));
            let treeReport = null;
            // Full-world geodata connectivity preparation runs before readiness and
            // can take several minutes. Keep a hard bound without skipping it.
            const startupTimer = setTimeout(() => {
                if (this.child !== child || this.phase !== 'starting') return;
                this.append('management', 'startup readiness deadline exceeded; initiating shutdown');
                this.phase = 'stopping'; this.finish(operation, 'failed', { message: 'Startup readiness timed out.' });
                if (child.connected) child.send({ v: 1, type: 'shutdown', generation, reason: 'startup_timeout' }, () => {});
                else child.kill('SIGTERM');
            }, 30 * 60 * 1000);
            startupTimer.unref();
            child.on('message', message => {
                if (this.child !== child || this.generation !== generation || message?.v !== 1 || message.generation !== generation) return;
                if (message.type === 'ready' && this.phase === 'starting') {
                    if (!message.listeners?.auth || !message.listeners?.game) return;
                    if (message.observer !== 'disabled' && (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535)) return;
                    this.endpoint = message.observer === 'disabled' ? null : { host: '127.0.0.1', port: message.port, generation };
                    this.observerState = message.observer === 'disabled' ? 'disabled' : 'ready';
                    this.phase = 'running'; clearTimeout(startupTimer); this.finish(operation, 'completed');
                } else if (message.type === 'startup-failed') {
                    this.endpoint = null; this.phase = 'stopping';
                    this.finish(operation, 'failed', { message: 'Required initialization or listener failed; shutting down.' });
                } else if (message.type === 'tree-exited') {
                    treeReport = message;
                } else if (['settings.reply', 'game.reply'].includes(message.type)) {
                    const pending = this.requests.get(message.requestId);
                    if (!pending || pending.generation !== generation || pending.replyType !== message.type) return;
                    this.requests.delete(message.requestId); clearTimeout(pending.timer);
                    if (this.phase !== 'running' || this.closing) pending.reject(GameContract.failure('runtime_unavailable'));
                    else if (pending.expiresAt <= Date.now()) pending.reject(GameContract.failure('runtime_timeout'));
                    else if (message.type === 'game.reply') {
                        if (message.code) pending.reject(GameContract.failure(Object.hasOwn(GameContract.REASONS, message.code) ? message.code : 'runtime_unavailable'));
                        else pending.resolve(message.result);
                    } else if (message.error) pending.reject(Config.error('Runtime settings request failed.', 503));
                    else pending.resolve(message.state);
                }
            });
            child.on('error', () => { this.append('management', 'wrapper process error'); });
            child.on('close', (code, signal) => {
                if (this.child !== child) return;
                clearTimeout(startupTimer);
                this.endpoint = null; this.child = null;
                this.treeConfirmed = Boolean(treeReport?.confirmed) || !child.pid;
                this.shutdownOutcome = treeReport?.outcome || 'unknown';
                this.phase = this.treeConfirmed && this.shutdownOutcome === 'clean' ? 'stopped' : 'error';
                this.lastExit = { code, signal, at: Date.now(), shutdownOutcome: this.shutdownOutcome, treeConfirmed: this.treeConfirmed };
                this.rejectRequests();
                if (this.operation?.kind === 'stop') this.finish(this.operation, this.shutdownOutcome === 'clean' ? 'completed' : 'failed', { shutdownOutcome: this.shutdownOutcome });
                else this.finish(operation, 'failed', { message: 'Game exited before readiness.' });
                this.append('management', `wrapper exited code=${code} signal=${signal || '-'} cleanup=${this.shutdownOutcome} tree=${this.treeConfirmed ? 'exited' : 'unknown'}`);
            });
            return this.public();
        } catch (error) { this.finish(operation, 'failed', { message: error.statusCode ? error.message : 'Start failed.' }); throw error; }
    }
    stop() {
        if (this.phase === 'starting' && this.operation?.kind === 'start') throw Config.error('Startup is in progress; wait for readiness or its bounded shutdown.', 409);
        const operation = this.reserve('stop');
        if (!this.child) { this.finish(operation, 'completed'); return this.public(); }
        if (this.phase === 'stopping') { this.finish(operation, 'failed'); throw Config.error('Already stopping.', 409); }
        this.phase = 'stopping'; this.endpoint = null; this.observerState = 'unavailable';
        this.rejectRequests();
        const child = this.child;
        if (child.connected) child.send({ v: 1, type: 'shutdown', generation: this.generation, reason: 'management_stop' }, error => { if (error) child.kill('SIGTERM'); });
        else child.kill('SIGTERM');
        // Never kill the wrapper here: only it can reap and attest its descendant.
        setTimeout(() => {
            if (this.child !== child) return;
            this.shutdownOutcome = 'timed_out';
            this.append('management', 'wrapper has not confirmed descendant exit; conflicting operations remain blocked');
        }, 22000).unref();
        return this.public();
    }
    runtime(type, changes) {
        if (!['settings.read', 'settings.apply'].includes(type)) return Promise.reject(GameContract.failure('invalid_request'));
        return this.requestRuntime(type, changes ? { changes } : {}, 'settings.reply');
    }
    gameRuntime(type, payload) {
        GameContract.runtimePayload(type, payload);
        return this.requestRuntime(type, { payload }, 'game.reply');
    }
    rejectRequests() {
        for (const pending of this.requests.values()) {
            clearTimeout(pending.timer); pending.reject(GameContract.failure('runtime_unavailable'));
        }
        this.requests.clear();
    }
    requestRuntime(type, body, replyType) {
        if (this.closing || this.phase !== 'running' || !this.child?.connected) return Promise.reject(GameContract.failure('runtime_unavailable'));
        if (this.requests.size >= 32) return Promise.reject(GameContract.failure('busy'));
        const requestId = randomUUID(), generation = this.generation, child = this.child;
        const expiresAt = Date.now() + 4000;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.requests.delete(requestId); reject(GameContract.failure('runtime_timeout')); }, 4000);
            this.requests.set(requestId, { generation, replyType, expiresAt, resolve, reject, timer });
            const failed = () => {
                if (!this.requests.has(requestId)) return;
                clearTimeout(timer); this.requests.delete(requestId); reject(GameContract.failure('runtime_unavailable'));
            };
            try {
                child.send({ v: 1, generation, requestId, type, expiresAt, ...body }, error => { if (error) failed(); });
            } catch (_) { failed(); }
        });
    }
    async dataOperation(kind, payload) {
        const operation = this.reserve(kind, true);
        let linksInvalidated = false;
        try {
            const paths = this.databasePaths();
            if (kind === 'load' || kind === 'wipe') {
                if (typeof this.invalidateGameAccounts !== 'function') throw Config.error('Account-link invalidation is unavailable.', 503);
                this.invalidateGameAccounts(kind === 'load' ? 'all' : payload.scope);
                linksInvalidated = true;
            }
            let result;
            if (kind === 'wipe') {
                const WorldWipe = require('../../scripts/world-wipe');
                const release = acquireDatabaseAccess(paths.world);
                try { result = await WorldWipe.wipe(payload.scope, { databasePath: paths.world, historyPath: paths.history }); } finally { release(); }
            } else result = await SavedGames.run({ operation: kind, databasePath: paths.world, historyPath: paths.history,
                savesDir: this.savesDir, name: payload.name, id: payload.id });
            this.finish(operation, 'completed', { result, gameAccountLinksInvalidated: linksInvalidated });
            return { result, operation: this.lastOperation };
        } catch (error) {
            // Wipe world commit can precede a history error. Do not claim rollback.
            const message = kind === 'wipe' ? 'Wipe failed; world deletion may already be committed. Inspect logs/history recovery before any retry.' : 'Saved-game operation failed; inspect the result before retrying.';
            this.finish(operation, 'failed', { gameAccountLinksInvalidated: linksInvalidated,
                message: message + (linksInvalidated ? ' Affected game-account links were cleared; relink before dashboard access.' : '') });
            this.append('management', `${kind} failed: ${error.message}`);
            throw Config.error(this.lastOperation.message, error.statusCode || 500);
        }
    }
    inferenceState() {
        const cfg = Descriptors.aiConfig(this.config().effective);
        const fingerprint = Config.hash(JSON.stringify(cfg));
        if (this.llmFingerprint !== fingerprint) {
            this.llmFingerprint = fingerprint;
            let endpoint = '';
            try {
                const url = new URL(cfg.apiUrl);
                // Provider paths can also contain tokens, not just query/auth.
                if (['http:', 'https:'].includes(url.protocol)) endpoint = `${url.origin}/…`;
            } catch (_) { /* Invalid private URL is not echoed. */ }
            const configured = Boolean(endpoint && cfg.model && (cfg.provider !== 'openrouter' || cfg.apiKey));
            this.llm = { phase: !cfg.enabled ? 'disabled' : !configured ? 'unconfigured' : 'untested', enabled: cfg.enabled,
                provider: cfg.provider, endpoint, model: cfg.model, latencyMs: null, checkedAt: null, message: configured ? 'One explicit synthetic inference call; not gameplay acceptance.' : 'Check private provider configuration.' };
        }
        return this.llm;
    }
    async testInference() {
        if (this.llmPromise) throw Config.error('Inference test already in progress.', 409);
        const cfg = Descriptors.aiConfig(this.config().effective);
        const status = this.inferenceState();
        if (status.phase === 'disabled' || status.phase === 'unconfigured') return this.public();
        const fingerprint = this.llmFingerprint, startedAt = Date.now();
        this.llm = { ...status, phase: 'testing', message: 'Testing one synthetic request…' };
        this.llmPromise = (async () => {
            const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
            try {
                const body = { model: cfg.model, messages: [{ role: 'user', content: 'Reply with exactly L2SOLO_LLM_OK and nothing else.' }], [cfg.completionLimitParam]: 128 };
                if (Number.isFinite(cfg.temperature)) body.temperature = cfg.temperature;
                if (cfg.provider === 'openrouter') {
                    if (cfg.reasoningEffort !== 'off') body.reasoning = { effort: cfg.reasoningEffort, exclude: true };
                } else body.reasoning_effort = cfg.reasoningEffort === 'off' ? 'none' : cfg.reasoningEffort;
                const headers = { 'Content-Type': 'application/json' };
                if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
                const response = await fetch(cfg.apiUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
                // Never echo raw provider errors (they can contain credentials or URLs).
                if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}.`);
                const reader = response.body.getReader(); let bytes = 0; const chunks = [];
                for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length;
                    if (bytes > 65536) { await reader.cancel(); throw new Error('Provider response exceeded the bounded limit.'); } chunks.push(Buffer.from(value)); }
                let json; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { throw new Error('Provider returned invalid JSON.'); }
                if (typeof json?.choices?.[0]?.message?.content !== 'string' || !json.choices[0].message.content.trim()) throw new Error('Provider returned no assistant message.');
                if (this.llmFingerprint === fingerprint) this.llm = { ...status, phase: 'online', latencyMs: Date.now() - startedAt, checkedAt: Date.now(), message: 'Synthetic inference responded; gameplay AI remains unverified.' };
            } catch (error) {
                const safe = error.name === 'AbortError' ? 'Inference timed out after 30 seconds.' : /^Provider /.test(error.message) ? error.message : 'Inference request failed; inspect private provider configuration.';
                if (this.llmFingerprint === fingerprint) this.llm = { ...status, phase: 'error', latencyMs: Date.now() - startedAt, checkedAt: Date.now(), message: safe };
            } finally { clearTimeout(timer); }
        })();
        try { await this.llmPromise; return this.public(); } finally { this.llmPromise = null; }
    }
    async shutdown() {
        if (this.closing) return;
        if (this.child && this.phase !== 'stopping') {
            // Service shutdown may interrupt startup, but still reaps the wrapper.
            if (this.operation?.kind === 'start') this.finish(this.operation, 'failed', { message: 'Management shutting down.' });
            this.stop();
        }
        this.closing = true;
        if (this.child) await new Promise(resolve => this.child.once('close', resolve));
        while (this.operation) await new Promise(resolve => setTimeout(resolve, 50));
        if (this.llmPromise) await this.llmPromise;
    }
}
module.exports = ManagementController;
