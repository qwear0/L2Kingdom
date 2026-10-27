const AttackRange = invoke('GameServer/Actor/AttackRange');
const ActionOwner = invoke('GameServer/Actor/PlayerActionOwner');

const fetchNormalAttackRange = AttackRange.fetchNormalAttackRange;

function withNormalAttackRange(actor, data) {
    return {
        ...data,
        range: fetchNormalAttackRange(actor, data),
    };
}

function attackRequest(session, actor, data) {
    if (!ActionOwner.current(session, actor, data.actionOwner)) return;
    if (!data.actionOwner) ActionOwner.takeover(session, actor);
    const Generics = invoke(path.actor);
    const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');

    if (actor.isDead()) {
        data.actionOwner?.nativeEvent?.('native_rejected', { reason: 'actor_dead' });
        return;
    }

    if (!EffectRestrictions.canAttack(actor)) {
        data.actionOwner?.nativeEvent?.('native_rejected', { reason: 'attack_restricted' });
        EffectRestrictions.reject(session);
        return;
    }

    const attackData = withNormalAttackRange(actor, data);

    if (actor.isBlocked()) {
        data.actionOwner?.nativeEvent?.('native_queued');
        Generics.queueRequest(session, actor, 'attack', attackData);
        return;
    }

    Generics.clearStoredActions(session, actor);

    // A rooted actor cannot acknowledge a StopMove with ValidatePosition.
    // Execute from its authoritative position; range still gates the action.
    if (!EffectRestrictions.canMove(actor)) {
        Generics.attackExec(session, actor, attackData);
        return;
    }

    if (actor.state.fetchTowards() === 'melee' &&
        Number(attackData.id) === Number(actor.automation.fetchDestId())) {
        return;
    }

    // StopMove is a notification, not a guaranteed position handshake.
    // A stationary client may send no ValidatePosition for a long time.
    // Start from the authoritative position now; AttackExec and meleeHit
    // still enforce weapon range and chase a target that is farther away.
    Generics.stopAutomation(session, actor);
    Generics.attackExec(session, actor, attackData);
}

module.exports = attackRequest;
module.exports.fetchNormalAttackRange = fetchNormalAttackRange;
module.exports.BOW_ATTACK_RANGE = AttackRange.BOW_ATTACK_RANGE;
module.exports.MELEE_ATTACK_RANGE = AttackRange.MELEE_ATTACK_RANGE;
module.exports.POLEARM_ATTACK_RANGE = AttackRange.POLEARM_ATTACK_RANGE;
