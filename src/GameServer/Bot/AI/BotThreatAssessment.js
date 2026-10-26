const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Utility = invoke('GameServer/Bot/AI/BotCombatUtility');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Rest = invoke('GameServer/Bot/AI/RestPolicy');
const Readiness = invoke('GameServer/Bot/AI/BotEncounterReadiness');
const RaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Formulas = invoke('GameServer/Formulas');

const RESERVE_HP_RATIO = 0.20;
const DAMAGE_MARGIN = 0.75;
const MAX_ASSESSED_ATTACKERS = 6;

function incomingRate(npc, bot) {
    const hit = Utility.basicAttackDamageEstimate(npc, bot);
    const speed = Number(npc.fetchCollectiveAtkSpd?.() ?? npc.fetchAtkSpd?.());
    if (!(hit > 0) || !(speed > 0)) return null;
    let rate = hit * 1000 / Formulas.calcMeleeAtkTime(speed);
    for (const skill of npc.fetchCombatSkills?.() || []) {
        if (skill.fetchSkillType?.() !== 'damage' || !skill.fetchSpell?.()
            || Number(skill.fetchConsumedMp?.()) > Number(npc.fetchMp?.())) continue;
        const attack = Number(npc.fetchCollectiveMAtk?.() ?? npc.fetchMAtk?.());
        const defense = Number(bot.fetchCollectiveMDef?.() ?? bot.fetchMDef?.());
        const casting = Number(npc.fetchCollectiveCastSpd?.() ?? npc.fetchCastSpd?.());
        if (!(attack > 0) || !(defense > 0) || !(casting > 0)) return null;
        const duration = Math.max(1000, Number(skill.fetchReuseTime?.()) || 0,
            Formulas.calcSkillHitTime(skill.fetchHitTime(), casting, { magic: true }));
        rate = Math.max(rate, Formulas.calcMagicDamage(attack, skill.fetchPower(), defense) * 1000 / duration);
    }
    return rate;
}

function evaluate(session, bot, threats, { recovering = false } = {}) {
    const hp = Number(bot.fetchHp()), maxHp = Number(bot.fetchMaxHp());
    const mp = Number(bot.fetchMp()), maxMp = Number(bot.fetchMaxMp());
    const hpRatio = hp / Math.max(1, maxHp), mpRatio = mp / Math.max(1, maxMp);
    const attackers = [...new Map(threats.map(npc => [Number(npc.fetchId()), npc])).values()];
    const result = { canFight: false, reason: 'no_pursuers', attackerCount: attackers.length, hpRatio, mpRatio };
    const finish = (reason) => {
        result.reason = reason;
        session.lastRetreatAssessment = { ...result, at: Date.now() };
        return result;
    };
    if (!attackers.length) return finish('no_pursuers');
    if (attackers.some(npc => RaidSafety.isProtectedRaidEntity(npc))) return finish('raid_entity_protected');
    if (attackers.length > MAX_ASSESSED_ATTACKERS) return finish('too_many_attackers');
    if (Rest.needsRest(bot, hpRatio, mpRatio)) return finish('critical_resources');
    if (!Restrictions.canUseBasicAction(bot)) return finish('disabled');
    if (Roles.combatRoleFor(bot) === 'mage' ? !Restrictions.canCast(bot) : !Restrictions.canAttack(bot)) {
        return finish('combat_actions_restricted');
    }

    // Use current HP/MP and only an already present summon. Share MP across
    // attackers: the same remaining mana cannot fund every fight again.
    const profiles = TargetMatchup.actorProfiles([bot]).slice(0, bot.summon && !bot.summon.isDead?.() ? 2 : 1)
        .map((profile, index) => {
            const availableMp = index ? Number(bot.summon.fetchMp()) : mp;
            return { ...profile, maxHp: index ? profile.maxHp : hp - maxHp * RESERVE_HP_RATIO,
                maxMp: availableMp / attackers.length, soloDamageReceiver: index === 0,
                skills: profile.skills.filter(skill => Number(skill.mp || 0) <= availableMp / attackers.length) };
        });
    const stats = TargetMatchup.profileStats(profiles);
    const fights = [];
    for (const npc of attackers) {
        const target = TargetMatchup.targetView(npc, stats);
        const targetHp = Number(npc.fetchHp());
        const survival = TargetMatchup.soloSurvival(profiles, { ...target, maxHp: targetHp });
        const outgoing = TargetMatchup.damageRate(profiles, target) * DAMAGE_MARGIN;
        const incoming = incomingRate(npc, bot);
        if (!Number.isFinite(targetHp) || !(targetHp > 0) || !Number.isFinite(outgoing) || !(outgoing > 0)
            || !Number.isFinite(incoming) || !(incoming > 0) || survival.survivalRatio === null) {
            return finish('unknown_combat_stats');
        }
        if (!survival.eligible || !TargetMatchup.evaluate(profiles, target).eligible) return finish('overmatched');
        fights.push({ npc, incoming, seconds: targetHp / outgoing });
    }
    fights.sort((a, b) => a.seconds - b.seconds);
    const first = fights[0].npc;
    Object.assign(result, { targetId: Number(first.fetchId()), targetName: first.fetchName?.() || null });
    if (recovering) {
        const readiness = Readiness.evaluate({ hp, maxHp, mp, maxMp, level: bot.fetchLevel(),
            manaDependent: Roles.shouldRestForMana(bot) },
        { hp: first.fetchHp(), maxHp: first.fetchMaxHp(), level: first.fetchLevel() });
        if (!readiness.ready) return finish(readiness.reason);
    }
    let seconds = 0, damage = 0;
    for (const fight of fights) {
        seconds += fight.seconds;
        // Every attacker can land an immediate hit. Budget extra time/damage
        // for approach, misses and interrupted casts, not just nominal DPS.
        damage += fight.incoming * (seconds + 2) / DAMAGE_MARGIN;
    }
    Object.assign(result, { estimatedFightMs: Math.round(seconds * 1000),
        expectedIncomingDamage: Math.ceil(damage), reserveHp: Math.ceil(maxHp * RESERVE_HP_RATIO) });
    if (hp - damage <= result.reserveHp) return finish('insufficient_survival_margin');
    if (!invoke('GameServer/Geodata/GeodataEngine').hasLineOfSight(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ(),
        first.fetchLocX(), first.fetchLocY(), first.fetchLocZ())) return finish('pursuer_not_reachable');
    result.canFight = true;
    return finish('fight_with_reserve');
}

module.exports = { evaluate };
