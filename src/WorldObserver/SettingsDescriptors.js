'use strict';

const { isIP } = require('net');
const { error } = require('../ConfigLoader');
const PRESETS = Object.freeze(['x1', 'x10', 'x50']);
const bool = (value, fallback = false) => value === undefined || value === null || value === '' ? fallback
    : typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
const aiSection = config => config.AI && typeof config.AI === 'object' && !Array.isArray(config.AI) ? 'AI' : 'OpenRouter';

function aiConfig(config, env = process.env) {
    const section = aiSection(config), legacy = section === 'OpenRouter', opt = config[section] || {};
    const prefix = legacy ? 'OPENROUTER' : 'L2NODE_AI';
    const apiUrl = String(env.L2NODE_AI_API_URL || (legacy ? env.OPENROUTER_API_URL : '') || opt.apiUrl
        || (legacy ? 'https://openrouter.ai/api/v1/chat/completions' : '')).trim();
    const model = String(env[`${prefix}_MODEL`] || opt.model || '');
    const apiKey = String(env[`${prefix}_API_KEY`] || opt.apiKey || '');
    return { section, enabled: bool(opt.enabled), apiUrl, apiKey, model,
        partyRouterModel: String(env[`${prefix}_PARTY_ROUTER_MODEL`] || opt.partyRouterModel || model),
        maxConcurrentRequests: Math.max(1, Math.floor(Number.isFinite(Number(opt.maxConcurrentRequests)) ? Number(opt.maxConcurrentRequests) : 32)),
        provider: apiUrl.replace(/\/+$/, '') === 'https://openrouter.ai/api/v1/chat/completions' ? 'openrouter' : 'openai-compatible',
        temperature: opt.temperature === undefined || opt.temperature === '' || opt.temperature === null ? null : Number(opt.temperature),
        completionLimitParam: ['max_tokens', 'max_completion_tokens'].includes(opt.completionLimitParam) ? opt.completionLimitParam
            : legacy ? 'max_completion_tokens' : 'max_tokens',
        reasoningEffort: ['off', 'low', 'medium', 'high'].includes(opt.reasoningEffort) ? opt.reasoningEffort : 'off' };
}

function catalogue(config) {
    const rows = [];
    function add(tab, group, section, key, label, type, fallback, help, extra = {}) {
        rows.push({ id: `${section}.${key}`, tab, group, section, key, label, type, fallback, help, mode: 'live', ...extra });
    }
    const rateHelp = 'Future rewards only; multiplied by the active preset. Does not rebalance existing characters or items.';
    for (const [key, label, sibling, advanced] of [
        ['expRate', 'EXP', null, false], ['spRate', 'SP', 'expRate', false],
        ['adenaRate', 'Adena', null, false], ['dropChanceRate', 'Drop', null, false], ['spoilRate', 'Spoil', 'dropChanceRate', false],
        ['questRewardRate', 'Common quest modifier', null, true], ['questAdenaRate', 'Quest Adena', 'questRewardRate', true],
        ['questExpRate', 'Quest EXP', 'questRewardRate', true], ['questSpRate', 'Quest SP', 'questRewardRate', true]
    ]) add('world', advanced ? 'Quest rewards (advanced)' : 'Progression modifiers', 'General', key, label, 'number', 1,
        `${rateHelp}${['dropChanceRate', 'spoilRate'].includes(key) ? ' Saturated chance scales quantities, not simply probability.' : ''}${advanced ? ' Authored objective counts are unchanged.' : ''}`,
        { min: 0, max: 10, optional: true, sibling, rate: true });
    for (const prefix of ['', 'blessed', 'crystal']) for (const category of ['Weapon', 'Armor', 'Accessory']) {
        const key = prefix ? `${prefix}${category}Chance` : `${category.toLowerCase()}Chance`;
        add('world', 'Enchant success (%)', 'Enchant', key, `${prefix || 'Normal'} ${category.toLowerCase()}`, 'number',
            category === 'Weapon' ? 68 : category === 'Armor' ? 52 : 54, 'Success percentage for the next attempt; an already started attempt may use captured values.', { min: 0, max: 100 });
    }
    for (const [key, fallback] of [['safeMax', 3], ['safeMaxFull', 4], ['maxWeapon', 0], ['maxArmor', 0], ['maxAccessory', 0]]) {
        add('world', 'Safe enchant and limits', 'Enchant', key, key, 'integer', fallback,
            'Next attempt only. Never downgrades items. Maximum 0 removes the configured gameplay cap, not the signed 16-bit transport ceiling (32767).', { min: 0, max: 32767 });
    }
    add('world', 'Death and storage', 'General', 'pkDeathDropChance', 'PK drop continuation (%)', 'number', 0.4,
        'Red characters with 6+ PK: continuation probability through the ordered death-drop procedure, not an independent roll per item.', { min: 0, max: 1, percent: true });
    add('world', 'Death and storage', 'GameServer', 'playerWarehouseSlots', 'Player warehouse slots', 'integer', 300,
        'Account-shared. Reducing capacity preserves contents and withdrawal. Deposits creating a slot obey the new cap; existing stack merges retain native behavior. Bot storage is unchanged.', { min: 1, max: 1000 });
    add('world', 'Beginner policy (advanced)', 'General', 'newbieRewardPolicy', 'Beginner reward policy', 'enum', 'strict',
        'strict: unknown legacy characters are ineligible; grant: treat unknown legacy characters as eligible; always: override eligibility. No immediate grant or receipt reset.', { choices: ['strict', 'grant', 'always'] });
    add('world', 'World presentation', 'General', 'showMonsterLevel', 'Monster level titles', 'boolean', true,
        'NPC titles are constructed at spawn; changing the saved value requires a game restart.', { mode: 'restart' });
    add('world', 'Chronicle', 'General', 'protocol', 'Protocol', 'integer', 656, 'C4 context; no protocol editing.', { mode: 'readonly' });
    add('world', 'Chronicle', 'General', 'maxLevel', 'Level cap', 'integer', 78, 'Read-only; no support above C4 caps is implied.', { mode: 'readonly' });
    add('bots', 'Vassal behavior', 'BotPopulation', 'ownedOnly', 'Runtime mode', 'text', 'Owned vassals only', 'Enforced after overrides. Ambient/cold/autonomous clan systems cannot be enabled here.', { mode: 'readonly', forced: 'Owned vassals only' });
    add('bots', 'Vassal behavior', 'BotPopulation', 'pvpAggression', 'PvP aggression', 'number', 0.5,
        'Initiation, risk tolerance and retreat; not the probability of attacking each encounter. Self-defense remains at 0.', { min: 0, max: 1, mode: 'restart', env: 'BOT_PVP_AGGRESSION' });
    add('bots', 'Vassal behavior', 'BotPopulation', 'knowledgeErrorsEnabled', 'Personal errors and learning', 'boolean', true,
        'Controls personal estimates and new learning; accumulated knowledge is not erased.', { mode: 'restart', env: 'BOT_KNOWLEDGE_ERRORS_ENABLED' });
    add('bots', 'Vassal behavior', 'BotPopulation', 'useBssdOutOfCombat', 'Use BSSD outside combat', 'boolean', false,
        'Use blessed spiritshots for out-of-combat buffs, healing and other magic. Offensive casts and support during combat still use them when disabled.', { mode: 'restart', env: 'BOT_USE_BSSD_OUT_OF_COMBAT' });
    add('bots', 'MCP control', 'BotControl', 'enabled', 'Bot MCP enabled', 'boolean', false,
        'Existing-vassal observation and explicit manual native-action leases. Requires the private game observer and L2NODE_BOT_CONTROL_TOKEN in the management environment. No administrative actions.', { mode: 'restart' });
    const section = aiSection(config), prefix = section === 'AI' ? 'L2NODE_AI' : 'OPENROUTER';
    add('bots', 'Optional AI dialogue', section, 'enabled', 'AI dialogue enabled', 'boolean', false,
        'External requests transfer dialogue and game context. Native behavior is separate. Disabling gates queued unsent requests; already sent requests may finish.');
    add('bots', 'Optional AI dialogue', section, 'model', 'Dialogue model', 'text', '', 'Current model is selected immediately before each future provider dispatch.', { env: `${prefix}_MODEL` });
    add('bots', 'Optional AI dialogue', section, 'partyRouterModel', 'Party / clan router model', 'text', '', 'Uses the dialogue model when no router model is configured.', { env: `${prefix}_PARTY_ROUTER_MODEL`, optional: true });
    add('bots', 'Optional AI dialogue', section, 'maxConcurrentRequests', 'Request concurrency', 'integer', 32,
        'Admission limit. Lowering never aborts in-flight work; raising is observed at the next existing admission/pump opportunity.', { min: 1, max: 128 });
    add('server', 'Accounts and connections', 'AuthServer', 'autoCreate', 'Automatically create accounts', 'boolean', true, 'Live for subsequent account-creation checks. Existing accounts are unchanged.');
    for (const [owner, port] of [['AuthServer', 2106], ['GameServer', 7777]]) {
        add('server', 'Accounts and connections', owner, 'hostname', `${owner} bind address`, 'text', '0.0.0.0', 'Listener binding, distinct from the address advertised to clients.', { mode: 'readonly' });
        add('server', 'Accounts and connections', owner, 'port', `${owner} port`, 'integer', port, 'Game restart disconnects clients; management remains available.', { min: 1, max: 65535, mode: 'restart' });
    }
    add('server', 'Accounts and connections', 'GameServer', 'advertisedHostname', 'Advertised IPv4', 'ipv4', '', 'Sent during server selection; not a listener bind address. Inherit removes only the local override and retains native automatic detection when unset.', { mode: 'restart', optional: true });
    add('server', 'Diagnostics', 'BotPopulation', 'developerDiagnostics', 'Developer diagnostics', 'boolean', false,
        'Master diagnostic switch; detail switches cannot enable it. Restart required.', { mode: 'restart', env: 'BOT_DEVELOPER_DIAGNOSTICS' });
    add('server', 'Diagnostics', 'BotPopulation', 'economyDiagnostics', 'Economy diagnostics', 'boolean', false,
        'Detail switch; effective only with developerDiagnostics. Does not enable the master switch.', { mode: 'restart' });
    for (const [key, fallback] of [['hostname', '127.0.0.1'], ['port', 8088]]) add('server', 'Management service', 'WorldObserver', key,
        `Backend management ${key}`, key === 'port' ? 'integer' : 'text', fallback, 'Management API binding, not the frontend address. With publicOrigin set, hostname must be 127.0.0.1. Management-service restart is external; in-page Stop affects only the game.', { mode: 'service' });
    add('server', 'Management service', 'WorldObserver', 'publicOrigin', 'L2Kingdom frontend origin', 'text', '',
        'Absolute HTTP browser origin without credentials, path, query or fragment. Enables the same-host loopback proxy boundary; empty disables proxy trust and browser auto-open, not API access. Edit externally and restart management.', { mode: 'service' });
    return rows;
}

function rawValue(config, d) {
    return config?.[d.section]?.[d.key] ?? (d.sibling ? config?.[d.section]?.[d.sibling] : undefined) ?? d.fallback;
}
function value(config, d, env = process.env) {
    if (d.forced !== undefined) return d.forced;
    if (['AI', 'OpenRouter'].includes(d.section)) return aiConfig(config, env)[d.key];
    const raw = d.env && env[d.env] !== undefined ? env[d.env] : rawValue(config, d);
    // Reads describe the existing consumer's effective value, including native
    // normalization of legacy input. New edits are validated before this path;
    // raw local values remain visible in the secondary source details.
    if (d.rate) return raw !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : 1;
    if (d.id === 'GameServer.playerWarehouseSlots') return Number.isSafeInteger(Number(raw)) && Number(raw) >= 1 && Number(raw) <= 1000 ? Number(raw) : 300;
    if (d.id === 'General.pkDeathDropChance') return Number.isFinite(Number(raw)) && Number(raw) >= 0 && Number(raw) <= 1 ? Number(raw) : 0.4;
    if (d.id === 'General.newbieRewardPolicy') return ['strict', 'grant', 'always'].includes(String(raw).toLowerCase()) ? String(raw).toLowerCase() : 'strict';
    if (d.id === 'General.showMonsterLevel' || d.id === 'AuthServer.autoCreate') return Boolean(config[d.section]?.[d.key]);
    if (d.id === 'BotPopulation.pvpAggression') return require('../GameServer/Social/PvpAggression').normalize(raw);
    return d.type === 'boolean' ? bool(raw, d.fallback) : ['number', 'integer'].includes(d.type) ? Number(raw) : String(raw ?? '');
}
function validate(d, input) {
    if (input === null && d.optional) return;
    if (d.type === 'boolean' ? typeof input !== 'boolean' : ['number', 'integer'].includes(d.type) ? typeof input !== 'number' : typeof input !== 'string') throw error(`${d.id}: invalid type.`);
    if (['number', 'integer'].includes(d.type) && (!Number.isFinite(input) || input < d.min || input > d.max || (d.type === 'integer' && !Number.isInteger(input)))) throw error(`${d.id}: expected ${d.min}..${d.max}${d.type === 'integer' ? ' integer' : ''}.`);
    if (d.type === 'enum' && !d.choices.includes(input)) throw error(`${d.id}: unsupported choice.`);
    if (d.type === 'ipv4' && isIP(input) !== 4) throw error(`${d.id}: expected IPv4 or inherit.`);
    if (typeof input === 'string' && (!input.trim() || input.length > 200 || /[\r\n\x00-\x1f=;#\[\]]/.test(input))) throw error(`${d.id}: invalid text.`);
}
function validateRates(config) {
    for (const d of catalogue(config).filter(row => row.rate)) {
        const input = rawValue(config, d);
        validate(d, input);
        for (const preset of PRESETS) {
            const effective = input * Number(preset.slice(1));
            if (!Number.isFinite(effective) || effective > 500) throw error(`${d.id}: unsafe product at ${preset}.`);
        }
    }
}
function safeProvider(config) {
    const cfg = aiConfig(config);
    return { provider: cfg.provider, credentials: cfg.apiKey ? 'configured' : 'not configured' };
}
module.exports = { PRESETS, bool, aiSection, aiConfig, catalogue, rawValue, value, validate, validateRates, safeProvider };
