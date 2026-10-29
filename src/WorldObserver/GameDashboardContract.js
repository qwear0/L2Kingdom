'use strict';

const { error } = require('../ConfigLoader');
const REQUEST_TYPES = ['gameAccount.verify', 'gameDashboard.read', 'gameDashboard.action'];
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const ACCOUNT = /^[A-Za-z0-9_]{1,14}$/;
// Browser auth treats 401 as an expired frontend session. A failed game-password
// check is 403 so it cannot log out a valid personal-key session.
const REASONS = Object.freeze({
    invalid_request: 400, invalid_credentials: 403, authentication_required: 401,
    account_already_linked: 409, stale_link: 409, stale_actor: 409, stale_version: 409,
    stale_run: 409, ambiguous_session: 409, busy: 409, unlinked: 409, offline: 409,
    settings_loading: 409, settings_failed: 409, stop_required: 409, action_unavailable: 409,
    invalid_member: 409, invalid_skill: 409, rate_limited: 429,
    runtime_unavailable: 503, runtime_timeout: 503, dashboard_not_ready: 503
});
function failure(code) { return Object.assign(error(code, REASONS[code] || 503), { code }); }
function fields(value, names) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw failure('invalid_request');
}
function token(value) { return typeof value === 'string' && TOKEN.test(value); }
function account(value) { return typeof value === 'string' && ACCOUNT.test(value); }
function revision(value) { return value === null || token(value); }
function credentials(value) {
    fields(value, ['login', 'password', 'expectedLinkRevision']);
    if (!account(value.login) || typeof value.password !== 'string' || value.password.length > 16
        || !value.password.trim() || /[\x00-\x1f\x7f]/.test(value.password) || !revision(value.expectedLinkRevision)) throw failure('invalid_request');
    return { login: value.login, password: value.password.trim() };
}
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const boolean = value => typeof value === 'boolean';
const oneOf = values => value => values.includes(value);
const noFields = {};
// Desired-state values avoid stale read/modify/toggle. Stop alone targets a run;
// every other action consumes the independent version of its owning card in P2.
const ACTIONS = Object.freeze({
    'autoFight.start': noFields,
    'autoFight.stop': noFields,
    'autoFight.newSession': noFields,
    'autoFight.setCenter': noFields,
    'autoFight.setRestPoint': noFields,
    'autoFight.setRadius': { value: value => integer(value, 1, 6000) },
    'autoFight.setPickup': { value: boolean },
    'autoFight.setBasicAttackOnly': { value: boolean },
    'autoFight.setSkillAllowed': { skillId: value => integer(value, 1, 65535), value: boolean },
    'autoFight.setThresholds': Object.fromEntries(['hpEnter', 'hpResume', 'mpEnter', 'mpResume'].map(key => [key, value => integer(value, 1, 100)])),
    'autoFight.retryLoad': noFields,
    'autoFight.retrySave': noFields,
    'autoFight.resetDefaults': noFields,
    'party.setMovement': { value: oneOf(['follow', 'hold']) },
    'party.setCombat': { value: oneOf(['assist', 'protect', 'passive']) },
    'party.setPull': { value: oneOf(['auto', 'leader', 'off']) },
    'party.setLoot': { value: boolean },
    'party.regroup': noFields,
    'party.setMemberPull': { memberId: value => integer(value, 1, 0x7fffffff), value: boolean },
    'party.follow': { memberId: value => integer(value, 1, 0x7fffffff) },
    'party.stay': { memberId: value => integer(value, 1, 0x7fffffff) },
    'party.call': { memberId: value => integer(value, 1, 0x7fffffff) },
    'party.dismiss': { memberId: value => integer(value, 1, 0x7fffffff) }
});
function action(value) {
    if (!value || !Object.hasOwn(ACTIONS, value.action)) throw failure('invalid_request');
    const extra = ACTIONS[value.action], fence = value.action === 'autoFight.stop' ? 'expectedRunId' : 'expectedVersion';
    fields(value, ['context', 'action', fence, ...Object.keys(extra)]);
    fields(value.context, ['linkRevision', 'actorToken']);
    if (!token(value.context.linkRevision) || !token(value.context.actorToken) || !token(value[fence])
        || Object.entries(extra).some(([key, valid]) => !valid(value[key]))) throw failure('invalid_request');
    if (value.action === 'autoFight.setThresholds' && (value.hpEnter >= value.hpResume || value.mpEnter >= value.mpResume)) throw failure('invalid_request');
    return value;
}
function runtimePayload(type, payload) {
    if (type === 'gameAccount.verify') {
        fields(payload, ['login', 'password']);
        credentials({ ...payload, expectedLinkRevision: null });
    } else if (type === 'gameDashboard.read') {
        fields(payload, ['accountName', 'linkRevision', 'includeSkills']);
        if (!account(payload.accountName) || !token(payload.linkRevision) || !boolean(payload.includeSkills)) throw failure('invalid_request');
    } else if (type === 'gameDashboard.action') {
        fields(payload, ['accountName', 'command']);
        if (!account(payload.accountName)) throw failure('invalid_request');
        action(payload.command);
    } else throw failure('invalid_request');
}
module.exports = { REQUEST_TYPES, REASONS, ACTIONS, failure, fields, token, account, revision, credentials, action, runtimePayload };
