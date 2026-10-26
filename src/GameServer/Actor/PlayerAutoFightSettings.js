const MAX_JSON_BYTES = 8192;
const MAX_SKILLS = 512;
const RADII = [400, 800, 1200];
const KEYS = ['radius', 'allowedSkillIds', 'basicAttackOnly', 'pickup', 'hpEnter', 'hpResume', 'mpEnter', 'mpResume'];

function defaults() {
    return { radius: 800, allowedSkillIds: [], basicAttackOnly: true, pickup: false,
        hpEnter: 35, hpResume: 95, mpEnter: 20, mpResume: 95 };
}

function validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(value, key))
        || !RADII.includes(value.radius) || typeof value.basicAttackOnly !== 'boolean' || typeof value.pickup !== 'boolean'
        || !Array.isArray(value.allowedSkillIds) || value.allowedSkillIds.length > MAX_SKILLS
        || value.allowedSkillIds.some(id => !Number.isInteger(id) || id < 1 || id > 65535)
        || new Set(value.allowedSkillIds).size !== value.allowedSkillIds.length) throw Error('invalid_auto_fight_settings');
    for (const resource of ['hp', 'mp']) {
        const enter = value[`${resource}Enter`], resume = value[`${resource}Resume`];
        if (!Number.isInteger(enter) || !Number.isInteger(resume) || enter < 1 || enter >= resume || resume > 100) {
            throw Error('invalid_auto_fight_thresholds');
        }
    }
    return Object.fromEntries(KEYS.map(key => [key, key === 'allowedSkillIds' ? [...value[key]].sort((a, b) => a - b) : value[key]]));
}

function encode(value) {
    const json = JSON.stringify(validate(value));
    if (Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) throw Error('auto_fight_settings_too_large');
    return json;
}

function decode(json) {
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) throw Error('invalid_auto_fight_settings');
    return validate(JSON.parse(json));
}

module.exports = { defaults, validate, encode, decode, RADII, MAX_SKILLS };
