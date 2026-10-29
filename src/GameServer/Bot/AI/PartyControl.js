'use strict';

const World = invoke('GameServer/World/World');
const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const BotManager = invoke('GameServer/Bot/BotManager');
const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
const Version = require('../../Actor/PlayerControlVersion');
const Supply = () => invoke('GameServer/Bot/AI/BotSupplyErrand');
const names = ['setMovement', 'setCombat', 'setPull', 'setLoot', 'regroup', 'setMemberPull', 'follow', 'stay', 'call', 'dismiss'];
const memberActions = new Set(['setMemberPull', 'follow', 'stay', 'call', 'dismiss']);

// The World party index retains registered hidden/cold supply companions and
// publishes attach/detach changes. Never replace it with BotManager's full list
// or omit hidden members; an inconsistent roster must not be silently truncated.
function members(session) {
    const roster = World.pvpPartySessionsForKey(session).filter(member => Party.isActiveCompanion(member, session));
    if (roster.length > 8 || new Set(roster.map(member => member.actor.fetchId())).size !== roster.length) {
        throw Object.assign(new Error('action_unavailable'), { code: 'action_unavailable', statusCode: 409 });
    }
    return roster.sort((a, b) => a.actor.fetchId() - b.actor.fetchId());
}
function isAssignedPuller(member, settings = Party.getSettings(member?.followPlayerSession)) {
    return settings.pullMode === 'bot' && Number(settings.pullerId || 0) === Number(member?.actor?.fetchId());
}
function settling(member) {
    const state = member.mcpControl, run = state?.foreground;
    return !!(state && (state.blocked || state.resumingTraining || run?.nativePending || run?.asyncPending || run?.publicationBlocked));
}
function version(session, roster = members(session)) {
    const settings = Party.getSettings(session);
    const values = [session.actor, session.actor?.isDead(), !!session.pendingActorTeleport,
        session.partyControlPolicyEpoch, session.partyControlMembershipEpoch,
        settings.distribution, settings.movementMode, settings.combatMode, settings.pullMode, settings.pullerId, settings.lootPickupEnabled];
    for (const member of [...roster].sort((a, b) => a.actor.fetchId() - b.actor.fetchId())) values.push(member, member.actor,
        World.registeredActorById(member.actor.fetchId())?.token, member.botStay,
        member.stayLocation?.locX, member.stayLocation?.locY, member.stayLocation?.locZ,
        member.partyPuller, member.autoTaunt, member.actor.fetchClassId(), Roles.inferRole(member.actor),
        member.actor.fetchIsOnline(), member.actor.isDead(), !!member.pendingActorTeleport,
        member.supplyErrandHidden, member.supplyErrandPhase, member.mcpControlGeneration,
        member.mcpControl?.lease, settling(member));
    return Version.observe(session, 'partyControlRevision', values);
}
function leaderBlocked(session) {
    const actor = session.actor;
    const record = actor && World.registeredActorById(actor.fetchId());
    return !actor || record?.session !== session || record.actor !== actor || record.retired
        || actor.isDead() || !actor.fetchIsOnline() || session.socket?.destroyed === true || !!session.pendingActorTeleport;
}
function stopPullAction(member) {
    const actor = member?.actor;
    if (!actor || Supply().ownsCompanion(member)) return;
    actor.attack?.abortCast?.(member, actor);
    actor.attack?.clearTimers?.();
    actor.state?.setHits?.(false);
    actor.state?.setCasts?.(false);
    actor.automation?.abortAll?.(actor);
    member.currentTargetId = undefined;
    actor.unselect?.();
}
function clearAssignedPuller(session, roster, nextPullMode = 'auto') {
    const settings = Party.getSettings(session);
    if (settings.pullMode !== 'bot') return false;
    stopPullAction(roster.find(member => isAssignedPuller(member, settings)));
    Party.updateSettings(session, { pullMode: nextPullMode, pullerId: null });
    session.partyPullState = {};
    for (const member of roster) { member.partyPuller = false; member.autoTaunt = nextPullMode !== 'off'; }
    return true;
}
function follow(member) { member.botStay = false; member.stayLocation = null; }
function hold(member) {
    if (Supply().ownsCompanion(member)) return 'supply_errand';
    member.botStay = true;
    const actor = member.actor;
    member.stayLocation = { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() };
    return null;
}
function call(session, member, offset = 60) {
    if (Supply().ownsCompanion(member)) return 'supply_errand';
    if (member.actor.isDead()) return 'dead';
    if (member.pendingActorTeleport) return 'teleporting';
    const actor = session.actor;
    const destination = { locX: actor.fetchLocX() + offset, locY: actor.fetchLocY() + offset, locZ: actor.fetchLocZ() };
    if (!TeleportTo(member, member.actor, destination)) return 'action_unavailable';
    if (member.botStay) member.stayLocation = destination;
    return null;
}
function report(session, roster, affectedMemberIds, skippedMembers, preemptedMemberIds, changed = false, noop = false) {
    const applied = changed || affectedMemberIds.length > 0 || noop;
    return { outcome: skippedMembers.length ? (applied ? 'partial' : 'rejected') : 'applied',
        ...(!applied && skippedMembers.length ? { code: skippedMembers.some(row => row.reason === 'settling') ? 'settling' : 'action_unavailable' } : {}),
        version: version(session, roster.filter(member => Party.isActiveCompanion(member, session))),
        affectedMemberIds, skippedMembers, preemptedMemberIds, ...(changed ? { settingsApplied: true } : {}), ...(noop ? { noop: true } : {}) };
}
function execute(session, command) {
    const leaderActor = session.actor;
    const roster = members(session), action = command.action.replace(/^party\./, '');
    const actors = new Map(roster.map(member => [member, member.actor]));
    const current = version(session, roster);
    const reject = code => ({ outcome: 'rejected', code, version: current, affectedMemberIds: [], skippedMembers: [], preemptedMemberIds: [] });
    if (!names.includes(action)) return reject('invalid_request');
    if (command.expectedVersion !== current) return reject('stale_version');
    if (leaderBlocked(session)) return reject('action_unavailable');
    const named = memberActions.has(action);
    const target = named ? roster.find(member => member.actor.fetchId() === command.memberId) : null;
    if (named && !target) return reject('invalid_member');
    if ((action === 'setMovement' && !['follow', 'hold'].includes(command.value))
        || (action === 'setCombat' && !['assist', 'protect', 'passive'].includes(command.value))
        || (action === 'setPull' && !['auto', 'leader', 'off'].includes(command.value))
        || (['setLoot', 'setMemberPull'].includes(action) && typeof command.value !== 'boolean')) return reject('invalid_request');
    Version.consume(session, 'partyControlRevision');
    const settings = Party.getSettings(session);
    const affected = [], skipped = [], preempted = [];
    const policyKey = { setMovement: 'movementMode', setCombat: 'combatMode', setPull: 'pullMode', setLoot: 'lootPickupEnabled' }[action];
    const unchangedPolicy = policyKey && settings[policyKey] === command.value;
    const noop = unchangedPolicy && (action !== 'setMovement' || roster.every(member => command.value === 'hold'
        ? member.botStay && !isAssignedPuller(member, settings) : !member.botStay));
    const memberNoop = action === 'setMemberPull' && (isAssignedPuller(target, settings) === command.value);
    if (noop || memberNoop) return report(session, roster, affected, skipped, preempted, false, true);
    const targets = named ? [target] : roster;
    const preemptTargets = new Set(targets);
    // Assigning a new puller cancels the previous puller's native action too.
    // It needs the same settlement gate, not just authority over the new member.
    if (action === 'setMemberPull' && command.value) {
        const previous = roster.find(member => isAssignedPuller(member, settings));
        if (previous) preemptTargets.add(previous);
    }
    let blocked = false;
    for (const member of preemptTargets) {
        const control = member.mcpControl;
        if (!control) continue;
        const id = actors.get(member).fetchId();
        const lease = control.lease, generation = member.mcpControlGeneration;
        const ready = control.preempt('owner_party_command');
        if ((lease && control.lease !== lease) || member.mcpControlGeneration !== generation) preempted.push(id);
        if (!ready) { blocked = true; skipped.push({ id, reason: 'settling' }); break; }
    }
    // Preserve native all-or-nothing admission on unsettled MCP work. Preemptions
    // already performed are real side effects and are returned separately.
    if (blocked) {
        for (const member of targets) if (!skipped.some(row => row.id === member.actor.fetchId())) skipped.push({ id: member.actor.fetchId(), reason: 'group_settling' });
        return report(session, roster, affected, skipped, preempted);
    }
    if (leaderBlocked(session) || session.actor !== leaderActor
        || roster.some(member => member.actor !== actors.get(member) || !Party.isActiveCompanion(member, session))) {
        return { ...report(session, roster, affected, skipped, preempted), outcome: 'rejected', code: 'stale_actor' };
    }
    let settingsApplied = false;
    if (policyKey) {
        if (action === 'setMovement' && command.value === 'hold') settingsApplied = clearAssignedPuller(session, roster);
        if (action === 'setPull') {
            stopPullAction(roster.find(member => isAssignedPuller(member, settings)));
            Party.updateSettings(session, { pullMode: command.value, pullerId: null });
            session.partyPullState = {};
        } else if (!unchangedPolicy) Party.updateSettings(session, { [policyKey]: command.value });
        settingsApplied = settingsApplied || !unchangedPolicy;
    }
    let slot = 0;
    for (const member of targets) {
        const id = member.actor.fetchId();
        const registration = World.registeredActorById(id);
        if (!Party.isActiveCompanion(member, session) || registration?.session !== member || registration.actor !== member.actor) {
            skipped.push({ id, reason: 'membership_changed' }); continue;
        }
        let reason = null;
        if (action === 'setMovement') {
            if (command.value === 'hold') reason = hold(member); else follow(member);
        } else if (action === 'setCombat') { member.currentTargetId = undefined; member.actor.unselect?.(); }
        else if (action === 'setPull') {
            member.partyPuller = false;
            member.autoTaunt = command.value !== 'off';
            member.currentTargetId = undefined;
            member.actor.unselect?.();
        } else if (action === 'regroup') {
            reason = call(session, member, 60 + slot * 20);
            if (!reason) ++slot;
        } else if (action === 'setMemberPull') {
            if (command.value) {
                if (!['tank', 'dagger', 'dps'].includes(Roles.inferRole(member.actor))) reason = 'role_restricted';
                else if (Supply().ownsCompanion(member)) reason = 'supply_errand';
                else if (member.actor.isDead() || member.pendingActorTeleport) reason = 'action_unavailable';
                else {
                    const previous = roster.find(candidate => isAssignedPuller(candidate, settings));
                    if (previous && previous !== member) stopPullAction(previous);
                    Party.updateSettings(session, { pullMode: 'bot', pullerId: id });
                    session.partyPullState = {};
                    for (const candidate of roster) { candidate.partyPuller = candidate === member; candidate.autoTaunt = true; }
                    follow(member);
                    BotManager.botSay(member, "I'll pull the next mobs to the party.");
                    settingsApplied = true;
                }
            } else {
                clearAssignedPuller(session, roster, 'off');
                BotManager.botSay(member, 'Stopping pull duty and staying with the party.');
                settingsApplied = true;
            }
        } else if (action === 'follow') {
            if (isAssignedPuller(member, settings)) clearAssignedPuller(session, roster);
            follow(member);
            BotManager.botSay(member, 'Following you again!');
        } else if (action === 'stay') {
            if (Supply().ownsCompanion(member)) reason = 'supply_errand';
            else {
                if (isAssignedPuller(member, settings)) clearAssignedPuller(session, roster);
                reason = hold(member);
                if (!reason) BotManager.botSay(member, 'Holding this position.');
            }
        } else if (action === 'call') {
            reason = call(session, member);
            if (!reason) BotManager.botSay(member, 'Summoned to your side!');
        } else if (action === 'dismiss') {
            if (!Party.detach(session, member, { event: 'party_kicked', source: 'panel', refreshPanel: false,
                message: 'Leaving the party. Good luck out there!' })) reason = 'membership_changed';
        }
        if (reason) skipped.push({ id, reason }); else affected.push(id);
    }
    return report(session, roster, affected, skipped, preempted, settingsApplied);
}
function snapshot(session, roster = members(session)) {
    const settings = Party.getSettings(session), blocked = leaderBlocked(session), groupSettling = roster.some(settling);
    const capability = reason => ({ enabled: !reason, reason });
    const caps = Object.fromEntries(names.map(name => [`party.${name}`, capability(blocked ? 'action_unavailable'
        : !memberActions.has(name) && groupSettling ? 'settling' : null)]));
    return { version: version(session, roster), settings, capabilities: caps, members: roster.map(member => {
        const actor = member.actor, role = Roles.inferRole(actor), supply = Supply().ownsCompanion(member);
        const reason = blocked ? 'action_unavailable' : settling(member) ? 'settling' : null;
        const canPull = ['tank', 'dagger', 'dps'].includes(role);
        const control = member.mcpControl;
        return { id: actor.fetchId(), name: actor.fetchName(), level: actor.fetchLevel(), classId: actor.fetchClassId(),
            className: Roles.className(actor), role,
            online: actor.fetchIsOnline() === true, dead: actor.isDead(), teleporting: !!member.pendingActorTeleport,
            holding: member.botStay === true, holdPoint: member.stayLocation ? { ...member.stayLocation } : null,
            isPuller: isAssignedPuller(member, settings), canPull, supplyErrand: supply,
            targetId: Number(member.currentTargetId) || null,
            decision: member.roleDecision ? { action: String(member.roleDecision.action || '').slice(0, 80), reason: String(member.roleDecision.reason || '').slice(0, 160) } : null,
            control: { mode: control ? (control.lease ? 'manual' : 'resuming') : 'native_ai', settling: settling(member) },
            capabilities: { 'party.follow': capability(reason), 'party.stay': capability(reason || (supply ? 'supply_errand' : null)),
                'party.call': capability(reason || (supply ? 'supply_errand' : actor.isDead() ? 'dead' : member.pendingActorTeleport ? 'teleporting' : null)),
                'party.dismiss': capability(reason), 'party.setMemberPull': capability(reason || (isAssignedPuller(member, settings) ? null
                    : supply ? 'supply_errand' : !canPull ? 'role_restricted' : actor.isDead() ? 'dead' : member.pendingActorTeleport ? 'teleporting' : null)) } };
        }) };
}
module.exports = { members, isAssignedPuller, version, snapshot, execute };
