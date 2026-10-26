'use strict';

const D = require('./SettingsDescriptors');
const generation = process.env.L2NODE_MANAGED_GENERATION;
function snapshot() {
    const config = options.default;
    const population = invoke('GameServer/Bot/Population/PopulationConfig');
    const gateway = invoke('GameServer/Bot/AI/OpenRouterGateway').config();
    const values = {};
    for (const d of D.catalogue(config)) {
        values[d.id] = d.section === 'BotPopulation' && d.key !== 'ownedOnly' ? population[d.key]
            : ['AI', 'OpenRouter'].includes(d.section) ? gateway[d.key] : D.value(config, d);
    }
    values['GameServer.playerWarehouseSlots'] = invoke('GameServer/Warehouse/PersonalWarehouseLimits').playerCapacity();
    return { values, rates: { ...invoke('GameServer/ProgressionRates').profile() }, activePreset: invoke('GameServer/ProgressionRates').selectedPreset(),
        provider: { provider: gateway.provider, credentials: gateway.apiKey ? 'configured' : 'not configured' } };
}
function install(isStopping = () => false) {
    if (!generation || !process.send) return;
    process.on('message', message => {
        if (message?.v !== 1 || message.generation !== generation || !['settings.read', 'settings.apply'].includes(message.type)
            || typeof message.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(message.requestId)) return;
        try {
            if (message.type === 'settings.apply') {
                if (isStopping()) throw new Error('Runtime stopping');
                const rows = D.catalogue(options.default);
                if (!message.changes || Array.isArray(message.changes) || Object.keys(message.changes).length > rows.length) throw new Error('Invalid patch');
                const prepared = Object.entries(message.changes).map(([id, value]) => {
                    const d = rows.find(row => row.id === id);
                    if (!d || d.mode !== 'live' || (d.env && process.env[d.env])) throw new Error('Not a live field');
                    D.validate(d, value);
                    return { d, value };
                });
                for (const { d, value } of prepared) {
                    const section = options.default[d.section] ||= {};
                    if (value === null) delete section[d.key]; else section[d.key] = value;
                }
            }
            process.send({ v: 1, generation, type: 'settings.reply', requestId: message.requestId, state: snapshot() }, () => {});
        } catch (_) {
            if (process.connected) process.send({ v: 1, generation, type: 'settings.reply', requestId: message.requestId, error: 'invalid_runtime_settings' }, () => {});
        }
    });
}
module.exports = { install, snapshot };
