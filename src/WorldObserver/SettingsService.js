'use strict';

const Config = require('../ConfigLoader');
const D = require('./SettingsDescriptors');
const clone = value => JSON.parse(JSON.stringify(value));
const own = (object, key) => Object.hasOwn(object || {}, key);
function locked(d) {
    return d.mode === 'readonly' || d.mode === 'service' || (d.env && (d.section === 'BotPopulation' ? process.env[d.env] !== undefined : Boolean(process.env[d.env])));
}
function ownership(snapshot, d) {
    if (d.forced !== undefined) return 'enforced policy';
    if (d.env && (d.section === 'BotPopulation' ? process.env[d.env] !== undefined : Boolean(process.env[d.env]))) return `environment: ${d.env}`;
    for (const layer of [...snapshot.layers].reverse()) if (own(layer.data[d.section], d.key)) return layer.name;
    if (d.sibling) {
        for (const layer of [...snapshot.layers].reverse()) if (own(layer.data[d.section], d.sibling)) return `${layer.name}: ${d.sibling} fallback`;
    }
    if (d.key === 'partyRouterModel') return 'dialogue model fallback';
    return 'native default';
}
class SettingsService {
    constructor(controller) { this.controller = controller; this.writing = false; }
    revision(snapshot) {
        const envOwnership = D.catalogue(snapshot.effective).filter(d => d.env).map(d => [d.env, process.env[d.env]]);
        return Config.hash(JSON.stringify([snapshot.revision, envOwnership, this.controller.generation]));
    }
    async read() {
        const saved = Config.load();
        let runtime = null, runtimeError = null;
        if (this.controller.phase === 'running') {
            try { runtime = await this.controller.runtime('settings.read'); }
            catch (_) { runtimeError = 'Runtime values could not be confirmed; saved is not proof of applied.'; }
        }
        const fields = D.catalogue(saved.effective).map(d => {
            const savedValue = D.value(saved.effective, d);
            const localWithoutKey = clone(saved.layers[2].data);
            if (localWithoutKey[d.section]) delete localWithoutKey[d.section][d.key];
            const withoutLocalKey = Config.merge(clone(saved.inherited), localWithoutKey);
            const defaultConfig = { [d.section]: saved.layers[0].data[d.section] || {} };
            const active = d.mode === 'service' ? this.controller.binding?.[d.key]
                : runtime && own(runtime.values, d.id) ? runtime.values[d.id] : null;
            const equal = active !== null && JSON.stringify(active) === JSON.stringify(savedValue);
            let pending = null;
            if (!['readonly', 'service'].includes(d.mode) && this.controller.child) {
                if (active === null) pending = 'Runtime unconfirmed; Stop -> Start required if the saved value is not active.';
                else if (!equal) pending = d.mode === 'live' ? 'Saved, not applied; Stop -> Start required.' : 'Saved for game restart.';
            } else if (d.mode === 'service' && !equal) pending = 'Management-service restart required (external).';
            const localOverride = own(saved.layers[2].data[d.section], d.key);
            return { ...d, saved: savedValue, active, inherited: D.value(withoutLocalKey, d),
                default: D.value(defaultConfig, d, {}), localOverride,
                siblingFallback: Boolean(d.sibling && saved.effective[d.section]?.[d.key] == null),
                inheritedSiblingFallback: Boolean(d.sibling && withoutLocalKey[d.section]?.[d.key] == null),
                override: localOverride ? saved.layers[2].data[d.section][d.key] : null,
                source: ownership(saved, d), editable: !locked(d),
                reason: locked(d) ? d.env && ownership(saved, d).startsWith('environment:') ? ownership(saved, d)
                    : d.mode === 'service' ? 'Owned by the management listener; edit externally and restart the management service.' : 'Read-only context / enforced policy.' : null,
                pending, status: pending || (this.controller.child ? active === null ? 'Runtime unavailable' : 'Active' : 'Saved for next start') };
        });
        const rates = config => Object.fromEntries(D.catalogue(config).filter(d => d.rate).map(d => [d.key, D.value(config, d)]));
        return { revision: this.revision(saved), phase: this.controller.phase, runtimeError, fields,
            provider: { ...D.safeProvider(saved.effective), active: runtime?.provider || null }, preset: this.controller.presets.public(), activePreset: this.controller.child ? runtime?.activePreset || this.controller.activePreset : null,
            runningRates: runtime?.rates || null, savedModifiers: rates(saved.effective) };
    }
    async patch(payload) {
        if (this.writing) throw Config.error('A settings save is already in progress.', 409);
        this.writing = true;
        try {
            if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['revision', 'tab', 'changes'].includes(key))
                || typeof payload.revision !== 'string' || !['world', 'bots', 'server'].includes(payload.tab)
                || !payload.changes || typeof payload.changes !== 'object' || Array.isArray(payload.changes)) throw Config.error('Invalid settings patch.');
            const snapshot = Config.load();
            const revision = this.revision(snapshot);
            if (revision !== payload.revision) throw Config.error('Settings changed; refresh and review the retained draft.', 409);
            const descriptors = D.catalogue(snapshot.effective);
            const entries = Object.entries(payload.changes);
            if (!entries.length || entries.length > descriptors.length) throw Config.error('Expected a non-empty bounded patch.');
            const targeted = entries.map(([id, value]) => {
                const d = descriptors.find(row => row.id === id);
                if (!d || d.tab !== payload.tab) throw Config.error('Unknown or cross-tab setting.');
                if (locked(d)) throw Config.error(`${id}: field is externally owned or read-only.`, 403);
                D.validate(d, value);
                return { ...d, value };
            });
            const raw = Config.editIni(snapshot.layers[2].raw, targeted);
            const candidate = clone(snapshot.inherited);
            Config.merge(candidate, require('js-ini').parse(raw));
            if (targeted.some(d => d.rate)) D.validateRates(candidate);
            // Validate resolved inheritance as well as the submitted scalar. No
            // mutation or IPC is performed until every field is prepared.
            for (const d of targeted) {
                if (d.optional && candidate[d.section]?.[d.key] === undefined && !d.rate) continue;
                D.validate(d, D.value(candidate, d));
            }
            try {
                Config.atomicReplace(snapshot.localPath, raw, snapshot.layers[2].mode, () => {
                    if (this.revision(Config.load()) !== revision) throw Config.error('Configuration layers changed during save.', 409);
                });
            } catch (error) {
                if (error.statusCode) throw error;
                throw Config.error('Could not persist settings; no successful save is confirmed.', 500);
            }
            const live = targeted.filter(d => d.mode === 'live');
            if (live.length && this.controller.phase === 'running') {
                try {
                    const changes = Object.fromEntries(live.map(d => [d.id, candidate[d.section]?.[d.key] ?? null]));
                    await this.controller.runtime('settings.apply', changes);
                } catch (_) { /* Persistence succeeded. The authoritative read below owns pending recovery. */ }
            }
            const state = await this.read();
            const applied = targeted.filter(d => {
                const row = state.fields.find(field => field.id === d.id);
                return row && this.controller.phase === 'running' && row.active !== null && !row.pending;
            }).map(d => d.id);
            const pending = targeted.map(d => d.id).filter(id => !applied.includes(id));
            return { ...state, applied, pending, saved: targeted.map(d => d.id) };
        } finally { this.writing = false; }
    }
}
module.exports = SettingsService;
