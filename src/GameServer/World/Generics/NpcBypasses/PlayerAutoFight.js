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
    session.nativeAutoFightTargetId = Number(session.actor.fetchDestId()) || 0;
    const point = controller.point;
    let body = Html.font('P1 native-control preview', Html.COLOR.warn) + '<br>'
        + 'One action only. No autonomous hunting, AoE, support or saved settings.<br>';
    body += Html.statusTable([
        ['Status', Html.esc(controller.reason)],
        ['Run', controller.run ? Html.esc(controller.run.kind) : 'Stopped'],
        ['Target', Html.esc(session.nativeAutoFightTargetId || 'None')],
        ['Skill', Html.esc(controller.allowedSkillId || 'None')],
        ['Point', point ? Html.esc(`${point.locX}, ${point.locY}, ${point.locZ}`) : 'Not set']
    ]);
    body += Html.button('Stop', `${prefix} stop`) + '<br>';
    if (!controller.run) {
        body += command('Select only (no attack)', 'select') + '<br>'
            + command('One basic attack', 'attack') + '<br>'
            + command('One allowed cast', 'skill') + '<br>'
            + command('Remember point here', 'point') + '<br>'
            + command('Move to point', 'move') + '<br>';
        body += Html.section('Allow one learned single-target skill', skills.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
            .map(skill => command(`${skill.fetchSelfId() === controller.allowedSkillId ? 'ON' : 'OFF'} ${skill.fetchName()}`,
                `allow ${skill.fetchSelfId()}`)).join('<br>') || 'No eligible skills.');
        body += '<br>';
        if (page > 0) body += command('Previous', `page ${page - 1}`) + ' ';
        if (page + 1 < pages) body += command('Next', `page ${page + 1}`);
    }
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
    const hasArgument = ['allow', 'page'].includes(action);
    if (parts.length !== (hasArgument ? 5 : 4) || (hasArgument && !/^\d{1,6}$/.test(parts[4]))) return;
    const controller = Controller.forActor(session.actor);
    const targetId = session.nativeAutoFightTargetId;
    // Consume before dispatch: repeated Start/point/skill clicks must not apply
    // twice, even if an asynchronous native lookup finishes after the redraw.
    ++session.nativeAutoFightRevision;
    if (action === 'stop') controller.stop();
    else if (action === 'select') controller.selectOnly(targetId);
    else if (['attack', 'skill', 'move'].includes(action)) controller.start(action, targetId);
    else if (action === 'point') controller.rememberPoint();
    else if (action === 'allow') controller.allowSkill(Number(parts[4]));
    render(session, action === 'page' ? Number(parts[4]) : 0);
}

handler.open = open;
module.exports = handler;
