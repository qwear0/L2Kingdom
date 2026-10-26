const Html = invoke('GameServer/World/Generics/HtmlKit');
const Response = invoke('GameServer/Network/Response');
const Controller = invoke('GameServer/Actor/PlayerAutoFight');
const PAGE_SIZE = 6;

function render(session, page = 0) {
    const controller = Controller.forActor(session.actor);
    const skills = session.actor.skillset.fetchSkills().filter(skill => controller.eligibleSkill(skill));
    const pages = Math.max(1, Math.ceil(skills.length / PAGE_SIZE));
    page = Math.min(pages - 1, Math.max(0, page));
    const revision = session.nativeAutoFightRevision = Number(session.nativeAutoFightRevision || 0) + 1;
    const prefix = `player-auto-fight ${session.nativeAutoFightEpoch} ${revision}`;
    const command = (label, action) => Html.link(label, `${prefix} ${action}`);
    const pointText = point => point ? Html.esc(`${point.locX}, ${point.locY}, ${point.locZ}`) : 'Not set';
    let body = Html.font('P3 connected-player hunting', Html.COLOR.warn) + '<br>'
        + 'Learned native skills and physical pickup. Settings are not saved yet.<br>';
    body += Html.statusTable([
        ['Status', Html.esc(controller.reason)],
        ['State', Html.esc(controller.run?.state || 'Stopped / setup')],
        ['Recovery', controller.run?.recovery ? 'Latched' : 'No'],
        ['Combat target', Html.esc(controller.combatTargetId() || 'None')],
        ['Basic attacks only', controller.basicAttackOnly ? 'ON' : 'OFF'],
        ['Allowed skills', Html.esc(controller.allowedSkillIds.size)],
        ['Pickup', controller.pickup ? 'ON' : 'OFF'],
        ['Zone center', pointText(controller.center)],
        ['Radius', Html.esc(controller.radius)],
        ['Rest point', pointText(controller.point)]
    ]);
    body += Html.button('Stop', `${prefix} stop`) + '<br>';
    if (!controller.run) {
        body += command('New session (clear both points)', 'new') + '<br>'
            + command('Set zone center here', 'center') + '<br>'
            + command('Set rest point here', 'point') + '<br>'
            + 'Radius: ' + [400, 800, 1200].map(radius => command(String(radius), `radius ${radius}`)).join(' / ') + '<br>'
            + Html.button('Start hunting', `${prefix} start`) + '<br>';
        body += 'Start requires both points. Stop preserves them; New session clears them.<br>'
            + 'Recovery: player HP &lt;35%; resume at 95%. MP: 20%/95% only for an allowed MP-cost skill or bow attack. Party recovery also pauses pulls.<br>'
            + command(`Basic attacks only: ${controller.basicAttackOnly ? 'ON' : 'OFF'} (toggle)`, 'allow 0') + '<br>'
            + command(`Physical pickup: ${controller.pickup ? 'ON' : 'OFF'} (toggle)`, 'pickup') + '<br>';
    }
    body += Html.section(controller.run ? 'Disable allowed skills' : 'Learned skill whitelist', skills.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
            .map(skill => controller.run && !controller.allowedSkillIds.has(skill.fetchSelfId()) ? Html.esc(`OFF ${skill.fetchName()}`)
                : command(`${controller.allowedSkillIds.has(skill.fetchSelfId()) ? 'ON' : 'OFF'} ${skill.fetchName()}`,
                `allow ${skill.fetchSelfId()}`)).join('<br>') || 'No eligible skills.');
    body += '<br>';
    if (page > 0) body += command('Previous', `page ${page - 1}`) + ' ';
    if (page + 1 < pages) body += command('Next', `page ${page + 1}`);
    body += '<br>' + command('Refresh', `page ${page}`);
    session.dataSendToMe(Response.npcHtml(0, Html.page(body, { title: 'Auto-fight' })));
}

function open(session) {
    if (!session?.actor) return;
    session.nativeAutoFightEpoch = Number(session.nativeAutoFightEpoch || 0) + 1;
    session.nativeAutoFightActor = session.actor;
    session.nativeAutoFightOpen = true;
    render(session);
}

function handler(session, parts) {
    if (!session?.actor || !session.nativeAutoFightOpen || session.nativeAutoFightActor !== session.actor
        || parts[1] !== String(session.nativeAutoFightEpoch) || parts[2] !== String(session.nativeAutoFightRevision)) return;
    const action = parts[3];
    if (!['stop', 'new', 'start', 'center', 'point', 'allow', 'radius', 'page', 'pickup'].includes(action)) return;
    const hasArgument = ['allow', 'radius', 'page'].includes(action);
    if (parts.length !== (hasArgument ? 5 : 4) || (hasArgument && !/^\d{1,6}$/.test(parts[4]))) return;
    const controller = Controller.forActor(session.actor);
    // Consume before dispatch so repeated setup/Start clicks cannot apply twice.
    ++session.nativeAutoFightRevision;
    if (action === 'stop') controller.stop();
    else if (action === 'new') controller.newSession();
    else if (action === 'start') controller.start();
    else if (action === 'center') controller.rememberPoint('center');
    else if (action === 'point') controller.rememberPoint();
    else if (action === 'allow') controller.allowSkill(Number(parts[4]));
    else if (action === 'radius') controller.setRadius(Number(parts[4]));
    else if (action === 'pickup') controller.setPickup(!controller.pickup);
    render(session, action === 'page' ? Number(parts[4]) : 0);
}

handler.open = open;
module.exports = handler;
