const Capabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');

// Shared priority decision only: movement, interruption and native dispatch
// remain the caller's responsibility, not a second support scheduler.
function select(actor, wounded, woundedCount, hpRatio, mpRatio, { usableOnly = false } = {}) {
    const routine = Capabilities.selectHealSkill(actor, { usableOnly });
    const emergencyCandidate = Capabilities.selectHealSkill(actor, { emergency: true, usableOnly });
    const groupCandidate = woundedCount >= 2 ? Capabilities.selectHealSkill(actor, { group: true, usableOnly }) : null;
    const canAfford = skill => !!skill && actor.canUseSkill?.(skill) !== false
        && actor.fetchMp() >= skill.fetchConsumedMp();
    const emergency = canAfford(emergencyCandidate) ? emergencyCandidate : routine;
    const group = canAfford(groupCandidate) ? groupCandidate : null;
    const topOff = group || routine;
    let action = null;
    if (wounded?.hpRatio < 0.45 && canAfford(emergency)) {
        action = { target: wounded.actor, skill: emergency, reason: 'emergency_heal', emergency: true };
    } else if (hpRatio < 0.55 && mpRatio >= 0.25 && canAfford(emergency)) {
        action = { target: actor, skill: emergency, reason: 'self_preservation', emergency: true };
    } else if (wounded?.hpRatio < 0.70 && mpRatio >= 0.35 && canAfford(topOff)) {
        action = { target: wounded.actor, skill: topOff, reason: group ? 'group_heal' : 'top_off', emergency: false };
    }
    return { action, routine, emergency, group, topOff, canAfford };
}

module.exports = { select };
