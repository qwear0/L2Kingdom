const Html = invoke('GameServer/World/Generics/HtmlKit');
const Response = invoke('GameServer/Network/Response');
const Controller = invoke('GameServer/Actor/PlayerAutoFight');
const Settings = require('../../../Actor/PlayerAutoFightSettings');
const Control = require('../../../Actor/PlayerAutoFightControl');
const PAGE_SIZE = 6;
const TABS = [['main', 'Hunt'], ['skills', 'Skills'], ['settings', 'Settings']];

function render(session, message = '') {
    const controller = Controller.forActor(session.actor);
    const tab = session.nativeAutoFightTab || 'main';
    const revision = session.nativeAutoFightRevision = Number(session.nativeAutoFightRevision || 0) + 1;
    const prefix = `player-auto-fight ${session.nativeAutoFightEpoch} ${revision}`;
    const command = (label, action) => Html.link(label, `${prefix} ${action}`);
    const editable = controller.canEditSettings();
    let body = Html.font('Connected-player auto-fight', Html.COLOR.title) + '<br>';
    if (controller.run) body += Html.button('Stop', `${prefix} stop`) + '<br>';
    if (message) body += Html.font(message, Html.COLOR.warn) + '<br>';
    if (controller.settingsError) body += Html.font(controller.settingsError, Html.COLOR.danger) + '<br>';
    body += `Preferences: ${Html.esc(controller.settingsStatus)} / ${Html.esc(controller.settingsSave)}<br>`;
    if (['load_failed', 'invalid'].includes(controller.settingsStatus)) body += command('Retry loading', 'load') + '<br>';
    if (controller.settingsSave === 'failed') body += command('Retry saving current preferences', 'save') + '<br>';

    if (tab === 'main') {
        const pointText = point => point ? Html.esc(`${point.locX}, ${point.locY}, ${point.locZ}`) : 'Not set';
        body += Html.statusTable([
            ['Status', Html.esc(controller.reason)],
            ['State', Html.esc(controller.run?.state || 'Stopped / setup')],
            ['Recovery', controller.run?.recovery ? 'Latched' : 'No'],
            ['Combat target', Html.esc(controller.combatTargetId() || 'None')],
            ['Zone center', pointText(controller.center)],
            ['Rest point', pointText(controller.point)],
            ['Radius', Html.esc(controller.radius)]
        ]);
        if (!controller.run) {
            if (controller.settingsStatus === 'ready' && !['saving', 'failed'].includes(controller.settingsSave)) {
                body += Html.button('Start', `${prefix} start`) + '<br>';
            }
            body += command('New session (clear both points)', 'new') + '<br>'
                + command('Set zone center here', 'center') + '<br>'
                + command('Set rest point here', 'point') + '<br>';
            if (editable) {
                body += `Radius (${Settings.MIN_RADIUS}-${Settings.MAX_RADIUS}; current ${controller.radius}):<br>`
                    + '<edit var="af_radius" width=90 height=15 length=4><br>'
                    + Html.button('Save radius', `${prefix} radius $af_radius`, { width: 100 }) + '<br>';
            }
        }
        body += 'Start needs both points. Stop preserves them; New session clears them. Points and active combat are never saved.<br>'
            + 'Manual movement/combat takes over. Closing this window does not stop hunting.<br>';
    } else if (tab === 'skills') {
        const skills = session.actor.skillset.fetchSkills().filter(skill => controller.eligibleSkill(skill));
        const entries = skills.map(skill => ({ id: Number(skill.fetchSelfId()), name: skill.fetchName() }));
        const learned = new Set(entries.map(entry => entry.id));
        for (const id of controller.allowedSkillIds) if (!learned.has(id)) entries.push({ id, name: `Unavailable saved skill #${id}`, unavailable: true });
        entries.sort((a, b) => a.id - b.id);
        const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
        const page = session.nativeAutoFightPage = Math.min(pages - 1, Math.max(0, session.nativeAutoFightPage || 0));
        body += `Basic attacks only: ${controller.basicAttackOnly ? 'ON (no skill casts)' : 'OFF'}<br>`
            + `Allowed: ${controller.allowedSkillIds.size}. Page ${page + 1}/${pages}.<br>`
            + 'Left-click ON/OFF. While running, only disabling is allowed. Unavailable saved skills never execute.<br>';
        body += Html.table(entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(entry => {
            const enabled = controller.allowedSkillIds.has(entry.id);
            const label = `${enabled ? 'ON' : 'OFF'} ${String(entry.name).slice(0, 48)}`;
            const toggle = controller.settingsStatus === 'ready' && (editable || enabled);
            return Html.row([
                Html.cell(entry.unavailable ? '' : Html.img(`icon.skill${String(entry.id).padStart(4, '0')}`, 24, 24), { width: 28 }),
                Html.cell(toggle ? command(label, `allow ${entry.id}`) : Html.esc(label))
            ]);
        }));
        if (!entries.length) body += 'No eligible learned skills.<br>';
        if (page > 0) body += command('Previous', `page ${page - 1}`) + ' ';
        if (page + 1 < pages) body += command('Next', `page ${page + 1}`);
    } else {
        body += Html.statusTable([
            ['Basic only', controller.basicAttackOnly ? 'ON' : 'OFF'],
            ['Physical pickup', controller.pickup ? 'ON' : 'OFF'],
            ['HP enter/resume', `${controller.hpEnter}% / ${controller.hpResume}%`],
            ['MP enter/resume', `${controller.mpEnter}% / ${controller.mpResume}%`]
        ]);
        body += 'MP recovery applies only to allowed MP-cost actions or bow attacks. Party recovery keeps its native policy.<br>';
        if (editable) {
            body += command('Toggle basic attacks only', 'basic') + '<br>'
                + command('Toggle physical pickup', 'pickup') + '<br>'
                + 'New thresholds: fill all four percentages (1 &lt;= enter &lt; resume &lt;= 100).<br>';
            body += Html.table(['hp', 'mp'].map(resource => Html.row([
                Html.cell(resource.toUpperCase(), { width: 30 }),
                Html.cell(`<edit var="af_${resource}_enter" width=50 height=15 length=3>`, { width: 60 }),
                Html.cell(`<edit var="af_${resource}_resume" width=50 height=15 length=3>`)
            ])));
            body += Html.button('Save thresholds', `${prefix} thresholds $af_hp_enter $af_hp_resume $af_mp_enter $af_mp_resume`, { width: 125 }) + '<br>';
        } else body += 'Structural settings require Stop and a completed preferences load.<br>';
        if (!controller.run && controller.settingsStatus !== 'loading') {
            body += command('Replace preferences with defaults (clear whitelist)', 'defaults') + '<br>';
        }
        body += 'Edits save automatically per character. Defaults: radius 1200, basic only ON, pickup OFF, no allowed skills, HP 35/95%, MP 20/95%.<br>';
    }
    body += '<br>' + command('Refresh', 'refresh');
    session.nativeAutoFightControlVersion = Control.version(controller);
    session.nativeAutoFightRunId = Control.runId(controller);
    session.dataSendToMe(Response.npcHtml(0, Html.page(body, {
        title: 'Auto-fight', tabs: Html.tabs(TABS, tab, `${prefix} view`)
    })));
}

function renderWithCompletion(session, controller, message = '') {
    render(session, message);
    if (controller.settingsStatus !== 'loading' && controller.settingsSave !== 'saving') return;
    const epoch = session.nativeAutoFightEpoch, revision = session.nativeAutoFightRevision;
    const htmlGeneration = session.npcHtmlGeneration;
    const commandEpoch = controller.controlCommandEpoch || 0;
    // Auto-fight revisions cannot detect another dialog replacing the shared HTML
    // window. Require both page identity and lifecycle ownership before redrawing.
    controller.settingsTask?.then(() => {
        if (session.actor === controller.actor && session.nativeAutoFightActor === controller.actor && session.nativeAutoFightOpen
            && session.nativeAutoFightEpoch === epoch && session.nativeAutoFightRevision === revision
            && session.npcHtmlGeneration === htmlGeneration
            && (controller.controlCommandEpoch || 0) === commandEpoch) render(session);
    }).catch(error => utils.infoWarn('PlayerAutoFight', 'settings page redraw failed: %s', error?.message));
}

function open(session) {
    if (!session?.actor) return;
    session.nativeAutoFightEpoch = Number(session.nativeAutoFightEpoch || 0) + 1;
    session.nativeAutoFightActor = session.actor;
    session.nativeAutoFightOpen = true;
    session.nativeAutoFightTab = 'main';
    session.nativeAutoFightPage = 0;
    const controller = Controller.forActor(session.actor);
    controller.loadSettings();
    renderWithCompletion(session, controller);
}

function handler(session, parts) {
    if (!session?.actor || !session.nativeAutoFightOpen || session.nativeAutoFightActor !== session.actor
        || parts[1] !== String(session.nativeAutoFightEpoch) || parts[2] !== String(session.nativeAutoFightRevision)) return;
    const action = parts[3];
    const noArgument = ['stop', 'new', 'start', 'center', 'point', 'pickup', 'basic', 'refresh', 'load', 'save', 'defaults'];
    if (noArgument.includes(action)) { if (parts.length !== 4) return; }
    else if (['allow', 'page'].includes(action)) {
        if (parts.length !== 5 || !/^\d{1,6}$/.test(parts[4])) return;
    } else if (action === 'view') {
        if (parts.length !== 5 || !TABS.some(([id]) => id === parts[4])) return;
    } else if (!['thresholds', 'radius'].includes(action)) return;
    const controller = Controller.forActor(session.actor);
    ++session.nativeAutoFightRevision;
    if (['view', 'page', 'refresh'].includes(action)) {
        if (action === 'view') session.nativeAutoFightTab = parts[4];
        if (action === 'page') session.nativeAutoFightPage = Number(parts[4]);
        renderWithCompletion(session, controller);
        return;
    }
    const names = { stop: 'stop', new: 'newSession', start: 'start', center: 'setCenter', point: 'setRestPoint',
        allow: 'setSkillAllowed', radius: 'setRadius', pickup: 'setPickup', basic: 'setBasicAttackOnly',
        load: 'retryLoad', save: 'retrySave', defaults: 'resetDefaults', thresholds: 'setThresholds' };
    const command = { action: `autoFight.${names[action]}`, expectedVersion: session.nativeAutoFightControlVersion };
    if (action === 'stop') command.expectedRunId = session.nativeAutoFightRunId;
    if (action === 'allow') Object.assign(command, { skillId: Number(parts[4]), value: !controller.allowedSkillIds.has(Number(parts[4])) });
    if (action === 'radius') {
        if (parts.length !== 5 || !/^\d{1,4}$/.test(parts[4])) { render(session, 'Not applied: enter an integer radius from 1 to 6000.'); return; }
        command.value = Number(parts[4]);
    }
    if (action === 'pickup') command.value = !controller.pickup;
    if (action === 'basic') command.value = !controller.basicAttackOnly;
    if (action === 'thresholds') {
        if (parts.length !== 8 || !parts.slice(4).every(value => /^\d{1,3}$/.test(value))) { render(session, 'Not applied: enter all four integer percentages.'); return; }
        ['hpEnter', 'hpResume', 'mpEnter', 'mpResume'].forEach((key, index) => { command[key] = Number(parts[4 + index]); });
    }
    const result = Control.execute(controller, command);
    renderWithCompletion(session, controller, result.outcome !== 'rejected' ? ''
        : result.code === 'stale_version' || result.code === 'stale_run'
            ? 'Controls changed elsewhere. Refreshed; review the current state before retrying.'
            : `Not applied: ${result.reason || result.code}. Stop before changing structural settings.`);
}

handler.open = open;
module.exports = handler;
