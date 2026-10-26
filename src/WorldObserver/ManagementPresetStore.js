'use strict';

const path = require('path');
const Config = require('../ConfigLoader');
const { PRESETS, validateRates } = require('./SettingsDescriptors');

class ManagementPresetStore {
    constructor() {
        const runtime = Config.resolve(process.env.L2NODE_RUNTIME_DIR || 'tmp');
        this.file = Config.resolve(process.env.L2NODE_LAUNCHER_SETTINGS_FILE || path.join(runtime, 'launcher-settings.json'));
    }
    read() {
        const snapshot = Config.readFile(this.file);
        let data;
        try { data = snapshot.identity === 'absent' ? {} : JSON.parse(snapshot.raw); }
        catch (_) { throw Config.error('Invalid launcher-settings.json; repair the preset store before starting.', 409); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw Config.error('Preset store must be a JSON object.', 409);
        const forced = process.env.L2NODE_PROGRESSION_RATE || null;
        const saved = data.progressionRate === undefined ? 'x1' : data.progressionRate;
        if (!PRESETS.includes(saved) || (forced && !PRESETS.includes(forced))) throw Config.error('Preset must be exactly x1, x10 or x50; repair the explicit environment/store value.', 409);
        return { revision: Config.hash(JSON.stringify([snapshot, forced])), selected: forced || saved, saved, forced: Boolean(forced), choices: PRESETS,
            ...{ snapshot, data } };
    }
    public() {
        try {
            const { revision, selected, saved, forced, choices } = this.read();
            return { revision, selected, saved, forced, choices, error: null };
        } catch (error) { return { error: error.statusCode ? error.message : 'Could not read preset store.', choices: PRESETS, forced: Boolean(process.env.L2NODE_PROGRESSION_RATE) }; }
    }
    save({ revision, progressionRate }) {
        const current = this.read();
        if (current.forced) throw Config.error('L2NODE_PROGRESSION_RATE owns this selection.', 403);
        if (revision !== current.revision) throw Config.error('Preset changed; refresh before saving.', 409);
        if (!PRESETS.includes(progressionRate)) throw Config.error('Select x1, x10 or x50.');
        validateRates(Config.load().effective);
        const raw = JSON.stringify({ ...current.data, progressionRate }, null, 2) + '\n';
        try {
            Config.atomicReplace(this.file, raw, current.snapshot.mode, () => {
                if (this.read().revision !== revision) throw Config.error('Preset changed during save.', 409);
            });
        } catch (err) { if (err.statusCode) throw err; throw Config.error('Could not persist preset; no new selection was committed.', 500); }
        return this.public();
    }
}
module.exports = ManagementPresetStore;
