const World = invoke('GameServer/World/World');
const AttackRange = invoke('GameServer/Actor/AttackRange');
const ArenaCombatRules = invoke('GameServer/World/ArenaCombatRules');
const ActionOwner = invoke('GameServer/Actor/PlayerActionOwner');

function canAttackNpc(npc, data = {}) {
    return npc?.fetchAttackable?.() === true || npc?.fetchIsSummon?.() === true || data.ctrl === true;
}

function attackExec(session, actor, data) {
    const owner = data.actionOwner;
    const generation = Number(actor.playerAutoFight?.generation || 0);
    const current = () => session.actor === actor && ActionOwner.current(session, actor, owner)
        && (!!owner || Number(actor.playerAutoFight?.generation || 0) === generation);
    if (!current()) return;
    const attackRange = AttackRange.fetchNormalAttackRange(actor, data);

    if (owner) owner.run.lookupPending = true;
    World.fetchNpc(data.id).then((npc) => {
        if (!current()) return;
        if (owner) owner.run.lookupPending = false;
        actor.automation.scheduleAction(session, actor, npc, attackRange, () => {
            if (!current()) return;
            if (canAttackNpc(npc, data)) {
                actor.attack.meleeHit(session, npc, { actionOwner: owner });
            }
            else {
                World.npcTalk(session, npc);
            }
        }, { collisionAware: true, action: 'attack', actionOwner: owner });
    }).catch((error) => {
        if (!current()) return;
        if (owner) {
            owner.controller.rejectCandidate(owner.run);
            utils.infoWarn('PlayerAutoFight', 'attack failed: %s', error?.message || String(error));
            return;
        }
        World.fetchUser(data.id).then((user) => {
            if (!current()) return;
            actor.automation.scheduleAction(session, actor, user, attackRange, () => {
                if (!current()) return;
                if (data.ctrl || user.fetchPvpFlag?.() > 0 || user.fetchKarma?.() > 0) {
                    if (!ArenaCombatRules.canInteract(actor, user)) return;
                    if (utils.isInPeaceZone(actor.fetchLocX(), actor.fetchLocY()) || utils.isInPeaceZone(user.fetchLocX(), user.fetchLocY())) {
                        const ServerResponse = invoke('GameServer/Network/Response');
                        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "You cannot attack players in a peace zone." }));
                        return;
                    }
                    actor.attack.meleeHit(session, user);
                }
                else {
                    const BotManager = invoke('GameServer/Bot/BotManager');
                    const botSession = BotManager.sessions.find(s => s.actor && s.actor.fetchId() === user.fetchId());
                    if (botSession && botSession.plan === 'merchant') {
                        const BotMerchant = invoke('GameServer/Bot/BotMerchant');
                        BotMerchant.talk(session, user);
                    }
                }
            }, { collisionAware: true, action: 'attack' });
        }).catch((err) => {
            utils.infoWarn('GameServer', 'Attack -> ' + err);
        })
    });
}

module.exports = attackExec;
module.exports.canAttackNpc = canAttackNpc;
