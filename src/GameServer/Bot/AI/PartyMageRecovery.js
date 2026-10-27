const Roles = invoke('GameServer/Bot/AI/BotRoles');
const CombatUtility = invoke('GameServer/Bot/AI/BotCombatUtility');
const ClassPolicy = invoke('GameServer/Bot/AI/BotClassPolicy');
const SkillRules = invoke('GameServer/Skills/C4SkillRules');
const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Response = invoke('GameServer/Network/Response');

const RECOVERED_MP_RATIO = 0.30;

function manaExhausted(bot, mp) {
    if (mp <= 0) return true;
    let hasAttack = false;
    for (const skill of bot.skillset?.skills || []) {
        if (!skill || skill.fetchPassive?.() || skill.fetchTargetKind?.() !== 'enemy'
            || !CombatUtility.OFFENSIVE_TYPES.has(skill.fetchSkillType?.())
            || !ClassPolicy.skillAllowed(bot, skill)) continue;
        const semantic = skill.fetchSemantic?.() || {};
        if (skill.fetchSkillType() === SkillRules.EFFECT && semantic.effectType === 'debuff') continue;
        hasAttack = true;
        // Reuse and temporary cast restrictions are not mana exhaustion.
        if (mp >= Math.max(0, Number(skill.fetchConsumedMp?.() || 0))) return false;
    }
    return hasAttack;
}

function stand(session, bot) {
    if (!bot.state.fetchSeated()) return;
    bot.state.setSeated(false);
    session.dataSendToOthers(Response.sitAndStand(bot), bot);
}

// Keep this outside party combat/state routing: the leader's target and raid
// hand-offs would otherwise stand an exhausted mage on every combat tick.
// Do not change the plan, so HP recovery and explicit rest retain their owner.
function tick(session, bot) {
    const eligible = (session.partyCompanion === true || session.hotBackgroundPartyId || bot.party?.partyId)
        && Roles.inferRole(bot) === 'mage' && ['following', 'hunting', 'resting'].includes(session.plan)
        && !session.explicitRestOrder;
    if (!eligible) {
        if (session.partyMageRecovering && !session.explicitRestOrder) stand(session, bot);
        session.partyMageRecovering = false;
        return false;
    }
    const mp = Number(bot.fetchMp());
    if (mp / Math.max(1, Number(bot.fetchMaxMp())) >= RECOVERED_MP_RATIO) {
        if (session.partyMageRecovering) stand(session, bot);
        session.partyMageRecovering = false;
        return false;
    }
    if (!session.partyMageRecovering && !manaExhausted(bot, mp)) return false;
    if (Awareness.underDirectNpcAttack(session)) {
        stand(session, bot);
        return false;
    }
    if (!Restrictions.canUseBasicAction(bot) || bot.state.fetchCasts?.()) return false;
    session.partyMageRecovering = true;
    if (!bot.state.fetchSeated()) {
        Tactics.stop(session, bot);
        session.currentTargetId = undefined;
        bot.unselect?.();
        bot.state.setSeated(true);
        session.dataSendToOthers(Response.sitAndStand(bot), bot);
    }
    bot.automation.replenishVitals(bot);
    session.lastDecision = { action: 'party_mage_recovery', at: Date.now() };
    session.roleDecision = { role: 'mage', ...session.lastDecision, reason: 'recover_mp_to_30_percent' };
    return true;
}

module.exports = { tick };
