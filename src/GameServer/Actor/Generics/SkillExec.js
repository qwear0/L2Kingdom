const World = invoke('GameServer/World/World');
const ArenaCombatRules = invoke('GameServer/World/ArenaCombatRules');
const ActionOwner = invoke('GameServer/Actor/PlayerActionOwner');

function canTargetEnemyNpc(npc, data = {}) {
    return npc?.fetchAttackable?.() === true || npc?.fetchIsSummon?.() === true || data.ctrl === true;
}

function cancelFailedSupportTarget(session, actor, data, skill) {
    const target = { fetchId: () => Number(data?.id || 0) };
    invoke('GameServer/Bot/AI/BotActionFeedback').record(session, actor, target, skill, 'rejected', 'missing_target');
    invoke('GameServer/Bot/AI/BotSupportPlanner').cancelPendingSupportCast(session, actor, target, skill, 'missing_target');
    invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, target, skill);
}

function skillExec(session, actor, data) {
    const owner = data.actionOwner;
    const generation = Number(actor.playerAutoFight?.generation || 0);
    const current = () => session.actor === actor && ActionOwner.current(session, actor, owner)
        && (!!owner || Number(actor.playerAutoFight?.generation || 0) === generation);
    if (!current()) return;
    const skill = actor.skillset.fetchSkill(data.selfId);
    if (!skill || (owner && !owner.controller.allowsSkill(skill))) return;
    const SpoilSweep = invoke('GameServer/Npc/SpoilSweep');

    if (skill.fetchTargetKind() === 'self') {
        actor.attack.remoteHit(session, actor, skill, { actionOwner: owner });
        return;
    }

    if (skill.fetchTargetKind() === 'pet') {
        const summon = invoke('GameServer/Npc/SummonControl').activeSummon(actor);
        if (!summon || Number(data.id) !== Number(summon.fetchId())) {
            cancelFailedSupportTarget(session, actor, data, skill);
            return;
        }
        actor.automation.scheduleAction(session, actor, summon, skill.fetchDistance(), () => {
            if (current()) actor.attack.remoteHit(session, summon, skill, { actionOwner: owner });
        }, { action: 'support', actionOwner: owner, skill });
        return;
    }

    if (owner && skill.fetchTargetKind() === 'friendly') {
        const target = invoke('GameServer/Bot/AI/PartyAwareness').partyActors(session)
            .find(member => Number(member.fetchId()) === Number(data.id));
        if (!target || !owner.controller.legalActionTarget(target, skill)) return;
        actor.automation.scheduleAction(session, actor, target, skill.fetchDistance(), () => {
            if (current()) actor.attack.remoteHit(session, target, skill, { actionOwner: owner });
        }, { action: 'support', actionOwner: owner, skill });
        return;
    }

    // TARGET_PARTY, TARGET_ALLY and TARGET_CORPSE_ALLY are caster-centred in
    // Lisvus. Attack.resolveSkillTargets expands them to the eligible party,
    // clan/alliance or dead-clan members inside the sourced radius.
    if (['party', 'ally', 'corpse_ally'].includes(skill.fetchTargetKind())) {
        actor.attack.remoteHit(session, actor, skill, { actionOwner: owner });
        return;
    }

    // Hate Aura and similar C4 TARGET_AURA enemy skills are centred on the
    // caster as well. Attack.resolveSkillTargets will fan the native effect
    // out only to valid enemies inside the sourced radius.
    if (skill.fetchTargetKind() === 'enemy' && skill.fetchSemantic?.().sourceTarget === 'aura') {
        actor.attack.remoteHit(session, actor, skill, { actionOwner: owner });
        return;
    }

    if (owner) owner.run.lookupPending = true;
    World.fetchNpc(data.id).then((npc) => {
        if (!current()) return;
        if (owner) owner.run.lookupPending = false;
        // Only Sweep is corpse collection; offensive corpse-targeted skills
        // must still pass the live-target initiation policy.
        actor.automation.scheduleAction(session, actor, npc, skill.fetchDistance(), () => {
            if (!current()) return;
            if (SpoilSweep.isSpoilSkill(data.selfId)) {
                SpoilSweep.castSpoil(session, actor, npc, skill, owner);
                return;
            }

            if (SpoilSweep.isSpoilFestivalSkill(data.selfId)) {
                const radius = Math.max(0, Number(skill.fetchSemantic?.().radius) || 0);
                const nearby = radius > 0
                    ? actor.attack.fetchSkillTargetsInRadius(actor, npc.fetchLocX(), npc.fetchLocY(), radius)
                    : [];
                SpoilSweep.castSpoilTargets(session, actor, [npc, ...nearby], skill, owner);
                return;
            }

            if (SpoilSweep.isSweepSkill(data.selfId)) {
                SpoilSweep.castSweep(session, actor, npc, skill, owner);
                return;
            }

            if (skill.fetchTargetKind() === 'corpse_mob' && npc.fetchAttackable?.() && npc.isDead?.()) {
                actor.attack.remoteHit(session, npc, skill, { actionOwner: owner });
            }
            else if (skill.fetchTargetKind() === 'enemy' && canTargetEnemyNpc(npc, data)) {
                actor.attack.remoteHit(session, npc, skill, { actionOwner: owner });
            }
        }, { action: SpoilSweep.isSweepSkill(data.selfId) ? 'sweep' : 'skill', actionOwner: owner, skill,
            allowDeadTarget: (owner && skill.fetchTargetKind() === 'corpse_mob')
                || (SpoilSweep.isSweepSkill(data.selfId) && String(session?.accountId || '').startsWith('bot_')) });
    }).catch((error) => {
        if (!current()) return;
        if (owner) {
            owner.controller.rejectCandidate(owner.run);
            utils.infoWarn('PlayerAutoFight', 'skill failed: %s', error?.message || String(error));
            return;
        }
        World.fetchUser(data.id).then((user) => {
            if (!current()) return;
            actor.automation.scheduleAction(session, actor, user, skill.fetchDistance(), () => {
                if (!current()) return;
                if (skill.fetchTargetKind() !== 'enemy') {
                    actor.attack.remoteHit(session, user, skill);
                }
                else if (data.ctrl || user.fetchPvpFlag?.() > 0 || user.fetchKarma?.() > 0) {
                    if (!ArenaCombatRules.canInteract(actor, user)) return;
                    if (utils.isInPeaceZone(actor.fetchLocX(), actor.fetchLocY()) || utils.isInPeaceZone(user.fetchLocX(), user.fetchLocY())) {
                        const ServerResponse = invoke('GameServer/Network/Response');
                        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "You cannot attack players in a peace zone." }));
                        return;
                    }
                    actor.attack.remoteHit(session, user, skill);
                }
            });
        }).catch((err) => {
            cancelFailedSupportTarget(session, actor, data, skill);
            utils.infoWarn('GameServer', 'Skill -> ' + err);
        });
    });
}

module.exports = skillExec;
module.exports.canTargetEnemyNpc = canTargetEnemyNpc;
module.exports.cancelFailedSupportTarget = cancelFailedSupportTarget;
