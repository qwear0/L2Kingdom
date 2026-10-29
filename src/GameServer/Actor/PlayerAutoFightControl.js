'use strict';

const { randomUUID } = require('crypto');
const Controller = invoke('GameServer/Actor/PlayerAutoFight');
const Version = require('./PlayerControlVersion');
const Settings = require('./PlayerAutoFightSettings');
const actions = ['start', 'stop', 'newSession', 'setCenter', 'setRestPoint', 'setRadius', 'setPickup',
    'setBasicAttackOnly', 'setSkillAllowed', 'setThresholds', 'retryLoad', 'retrySave', 'resetDefaults'];

function skillsRevision(controller) {
    const actor = controller.actor, skills = actor.skillset.fetchSkills();
    // Skillset replaces its array on reset/populate, then appends learned models.
    // Normal polls need identity/length only, not a rebuilt skill catalogue.
    return Version.observe(controller, 'controlSkillsRevision', [skills, skills.length,
        actor.fetchClassId(), actor.fetchLevel(), controller.skillRevision]);
}
function runId(controller) {
    return controller.run ? (controller.run.controlId ||= randomUUID()) : null;
}
function version(controller) {
    return Version.observe(controller, 'controlRevision', [controller.run, controller.generation,
        controller.center?.locX, controller.center?.locY, controller.center?.locZ,
        controller.point?.locX, controller.point?.locY, controller.point?.locZ,
        controller.radius, controller.basicAttackOnly, controller.pickup,
        controller.hpEnter, controller.hpResume, controller.mpEnter, controller.mpResume,
        controller.settingsStatus, controller.settingsSave, controller.settingsEpoch, controller.settingsRevision,
        skillsRevision(controller)]);
}
function disabled(controller, action) {
    if (action === 'stop') return controller.run ? null : 'not_running';
    if (!controller.available()) return 'action_unavailable';
    if (['newSession', 'setCenter', 'setRestPoint'].includes(action)) return controller.run ? 'stop_required' : null;
    if (action === 'retryLoad') return ['load_failed', 'invalid', 'unloaded'].includes(controller.settingsStatus) ? null : 'action_unavailable';
    if (action === 'resetDefaults') return controller.run ? 'stop_required'
        : controller.settingsStatus === 'loading' ? 'settings_loading' : null;
    if (controller.settingsStatus !== 'ready') return controller.settingsStatus === 'loading' ? 'settings_loading' : 'settings_failed';
    if (action === 'retrySave') return controller.settingsSave === 'failed' ? null : 'action_unavailable';
    if (action === 'setSkillAllowed') return null; // Per-skill enable/remove rules are checked below.
    if (controller.run) return 'stop_required';
    if (action === 'start') {
        if (['saving', 'failed'].includes(controller.settingsSave)) return controller.settingsSave === 'saving' ? 'settings_loading' : 'settings_failed';
        if (!controller.center || !controller.point) return 'missing_points';
        const actor = controller.actor;
        if (Math.hypot(controller.center.locX - controller.point.locX, controller.center.locY - controller.point.locY) > 3000
            || Math.hypot(actor.fetchLocX() - controller.center.locX, actor.fetchLocY() - controller.center.locY) > 3000) return 'points_too_far';
        if (controller.busy() || actor.state.inMotion() || controller.session.moveTimer
            || controller.session.pendingPathRequest || actor.attack.bowReloading) return 'action_unavailable';
    }
    return null;
}
function capabilities(controller) {
    return Object.fromEntries(actions.map(action => {
        const reason = disabled(controller, action);
        return [`autoFight.${action}`, { enabled: !reason, reason }];
    }));
}
function result(controller, code = null, extra = {}) {
    return { outcome: code ? 'rejected' : 'applied', ...(code ? { code } : {}), version: version(controller),
        runId: runId(controller), persistence: { status: controller.settingsSave }, ...extra };
}
function execute(controller, command) {
    const action = command.action.replace(/^autoFight\./, '');
    if (!actions.includes(action)) return result(controller, 'invalid_request');
    if (action === 'stop') {
        if (controller.run && runId(controller) !== command.expectedRunId) return result(controller, 'stale_run');
        if (!controller.run) return result(controller, null, { noop: true });
        version(controller);
    } else {
        if (version(controller) !== command.expectedVersion) return result(controller, 'stale_version');
        const reason = disabled(controller, action);
        if (reason) return result(controller, ['missing_points', 'points_too_far'].includes(reason) ? 'action_unavailable' : reason, { reason });
    }
    if (action === 'setRadius' && !Settings.validRadius(command.value)) return result(controller, 'invalid_request', { reason: 'invalid_radius' });
    if (action === 'setThresholds') {
        try { Settings.validate({ ...controller.settingsSnapshot(), ...Object.fromEntries(
            ['hpEnter', 'hpResume', 'mpEnter', 'mpResume'].map(key => [key, command[key]])) }); }
        catch (_) { return result(controller, 'invalid_request', { reason: 'invalid_thresholds' }); }
    }
    // Consume before gameplay/persistence side effects; even non-idempotent setup
    // actions and rejected attempts after partial effects cannot reuse this fence.
    Version.consume(controller, 'controlRevision');
    controller.controlCommandEpoch = (controller.controlCommandEpoch || 0) + 1;
    let accepted = true, noop = false;
    if (action === 'stop') controller.stop();
    else if (action === 'start') accepted = controller.start();
    else if (action === 'newSession') controller.newSession();
    else if (action === 'setCenter') accepted = controller.rememberPoint('center');
    else if (action === 'setRestPoint') accepted = controller.rememberPoint();
    else if (action === 'retryLoad') controller.loadSettings(true);
    else if (action === 'retrySave') accepted = controller.retrySettingsSave();
    else if (action === 'resetDefaults') accepted = controller.resetSettings();
    else if (action === 'setSkillAllowed') {
        const enabled = controller.allowedSkillIds.has(command.skillId);
        if (typeof command.value !== 'boolean' || !Number.isInteger(command.skillId) || command.skillId < 1 || command.skillId > 65535) return result(controller, 'invalid_request');
        if (enabled === command.value) noop = true;
        else accepted = controller.allowSkill(command.skillId);
        if (!accepted) return result(controller, 'invalid_skill');
    } else if (action === 'setThresholds') {
        const keys = ['hpEnter', 'hpResume', 'mpEnter', 'mpResume'];
        noop = keys.every(key => controller[key] === command[key]);
        if (!noop) accepted = controller.setThresholds(...keys.map(key => command[key]));
    } else {
        const key = { setRadius: 'radius', setPickup: 'pickup', setBasicAttackOnly: 'basicAttackOnly' }[action];
        noop = controller[key] === command.value;
        if (!noop) accepted = controller[action](command.value);
    }
    return result(controller, accepted ? null : 'action_unavailable', { ...(noop ? { noop: true } : {}),
        ...(!accepted ? { reason: controller.reason } : {}) });
}
function snapshot(controller, includeSkills = false) {
    controller.loadSettings();
    const state = { version: version(controller), runId: runId(controller), state: controller.run?.state || 'stopped',
        reason: controller.reason, recovery: !!controller.run?.recovery,
        center: controller.center ? { ...controller.center } : null, restPoint: controller.point ? { ...controller.point } : null,
        ...controller.settingsSnapshot(), settingsStatus: controller.settingsStatus, settingsSave: controller.settingsSave,
        settingsError: controller.settingsError, skillsRevision: skillsRevision(controller), capabilities: capabilities(controller) };
    if (includeSkills) {
        const learned = controller.actor.skillset.fetchSkills();
        const entries = new Map();
        for (const skill of learned) if (controller.eligibleSkill(skill)) {
            const id = Number(skill.fetchSelfId());
            entries.set(id, { id, name: String(skill.fetchName()).slice(0, 160), level: skill.fetchLevel(), available: true,
                icon: `icon.skill${String(id).padStart(4, '0')}` });
        }
        for (const id of controller.allowedSkillIds) if (!entries.has(id)) entries.set(id, {
            id, name: `Unavailable saved skill #${id}`, available: false, icon: null
        });
        if (entries.size > 1024) throw Object.assign(new Error('action_unavailable'), { code: 'action_unavailable', statusCode: 409 });
        const ready = controller.settingsStatus === 'ready' && controller.available();
        state.skills = [...entries.values()].sort((a, b) => a.id - b.id).map(entry => {
            const allowed = controller.allowedSkillIds.has(entry.id);
            return { ...entry, allowed, canEnable: ready && !controller.run && entry.available
                && controller.allowedSkillIds.size < Settings.MAX_SKILLS, canDisable: ready && allowed };
        });
    }
    return state;
}
module.exports = { forActor: Controller.forActor, version, runId, skillsRevision, capabilities, snapshot, execute };
