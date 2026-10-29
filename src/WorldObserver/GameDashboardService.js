'use strict';

const { randomUUID } = require('crypto');
const World = invoke('GameServer/World/World');
const AutoFight = invoke('GameServer/Actor/PlayerAutoFightControl');
const Party = invoke('GameServer/Bot/AI/PartyControl');
const C = require('./GameDashboardContract');

function realPlayer(session) {
    return session?.botSession !== true && session?.constructor?.name !== 'BotSession'
        && C.account(session?.accountId) && !/^bot_/i.test(session.accountId)
        && session.socket?.destroyed !== true && session.actor?.fetchIsOnline() === true;
}
function resolve(accountName) {
    const canonical = accountName.toLowerCase();
    const matches = [];
    // Presence candidates contain online humans only, never thousands of bots.
    // Resolve all matches rather than choosing the first case variant/session.
    for (const session of World.actorPresenceSessions('onlineHuman')) {
        if (!realPlayer(session) || session.accountId.toLowerCase() !== canonical) continue;
        const actor = session.actor, record = World.registeredActorById(actor.fetchId());
        if (record?.session === session && record.actor === actor && !record.retired) matches.push({ session, actor, record });
    }
    if (matches.length !== 1) return { availability: matches.length ? 'ambiguous_session' : 'offline' };
    return { availability: 'online', ...matches[0] };
}
function check(selected, accountName) {
    const { session, actor, record } = selected;
    if (!realPlayer(session) || session.actor !== actor || World.registeredActorById(actor.fetchId()) !== record
        || record.retired || session.accountId.toLowerCase() !== accountName.toLowerCase()) throw C.failure('stale_actor');
}
function context(selected, accountName) {
    const { session, actor, record } = selected;
    let state = actor.gameDashboardContext;
    if (!state || state.session !== session || state.record !== record || state.accountName !== accountName.toLowerCase()) {
        state = actor.gameDashboardContext = { session, record, accountName: accountName.toLowerCase(), token: randomUUID() };
    }
    return state;
}
function read(payload, current) {
    const selected = resolve(payload.accountName);
    if (selected.availability !== 'online') return { availability: selected.availability, accountName: payload.accountName };
    if (!current()) throw C.failure('runtime_unavailable');
    check(selected, payload.accountName);
    const { session, actor } = selected;
    const controller = AutoFight.forActor(actor);
    const roster = Party.members(session);
    const autoFight = AutoFight.snapshot(controller, payload.includeSkills);
    const party = Party.snapshot(session, roster);
    check(selected, payload.accountName);
    return { availability: 'online', accountName: payload.accountName,
        context: { linkRevision: payload.linkRevision, actorToken: context(selected, payload.accountName).token },
        character: { id: actor.fetchId(), name: actor.fetchName(), level: actor.fetchLevel(), classId: actor.fetchClassId(),
            dead: actor.isDead(), teleporting: !!session.pendingActorTeleport }, autoFight, party };
}
function action(payload, current) {
    const selected = resolve(payload.accountName);
    if (selected.availability !== 'online') throw C.failure(selected.availability);
    check(selected, payload.accountName);
    const { session, actor, record } = selected, state = actor.gameDashboardContext;
    if (!state || state.session !== session || state.record !== record || state.accountName !== payload.accountName.toLowerCase()
        || state.token !== payload.command.context.actorToken) throw C.failure('stale_actor');
    if (!current()) throw C.failure('runtime_unavailable');
    // Commands do not await a preferences read and then replay an old click.
    // Loading/error states are returned for an explicit fresh user action.
    if (payload.command.action.startsWith('autoFight.')) return AutoFight.execute(AutoFight.forActor(actor), payload.command);
    return Party.execute(session, payload.command);
}
module.exports = { read, action };
