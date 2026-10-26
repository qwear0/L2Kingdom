const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const BotRetreatPlanner = invoke('GameServer/Bot/AI/BotRetreatPlanner');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
const ThreatAssessment = invoke('GameServer/Bot/AI/BotThreatAssessment');
const NpcObjectIndex = require('../../../World/NpcObjectIndex');

const MIN_RETREAT_MS = 1000;
const RETREAT_REPATH_COOLDOWN_MS = 750;
const MAX_RETREAT_LEG_MS = 30000;
const REASSESS_MS = 1000;
const RAID_PARTY_HOLD_DISTANCE = 1800;

function stillMoving(session, bot) {
    return !!session.moveTimer || !!bot.state?.fetchTowards?.();
}

function needsRecovery(session, bot) {
    return RestPolicy.needsRest(bot,
        bot.fetchHp() / Math.max(1, bot.fetchMaxHp()),
        bot.fetchMp() / Math.max(1, bot.fetchMaxMp()),
        { locked: !!session.recoveryLocked });
}

function distance2d(first, second) {
    return Math.hypot(first.fetchLocX() - second.fetchLocX(), first.fetchLocY() - second.fetchLocY());
}

function finishRetreat(session, bot, now, reason, target = null) {
    bot.attack?.abortCast?.(session, bot);
    bot.attack?.clearTimers?.();
    bot.automation?.abortAll?.(bot);
    bot.state?.setHits?.(false);
    bot.state?.setCasts?.(false);
    const following = session.raidSafetyResumePlan === 'following' && session.partyCompanion === true
        && session.followPlayerSession;
    const recovery = !target && (needsRecovery(session, bot) || session.raidSafetyResumePlan === 'resting');
    if (!recovery) session.recoveryLocked = false;
    session.plan = following ? 'following' : recovery ? 'resting' : 'hunting';
    session.currentTargetId = target?.fetchId();
    if (target) bot.select({ id: target.fetchId() });
    else bot.unselect?.();
    session.retreatContext.endedAt = now;
    session.retreatContext.endedReason = reason;
    session.raidSafetyResumePlan = undefined;
    session.fleeStart = undefined;
    session.lastRetreatRepathAt = undefined;
    session.lastRetreatEvaluationAt = undefined;
    session.retreatPursuerIds = undefined;
    session.incomingThreatId = undefined;
    session.incomingThreatAt = undefined;
}

module.exports = {
    tick(session, bot, Generics, BotAI) {
        if (session.followPlayerSession?.partyRaidEngagement?.phase === 'retreat'
            && invoke('GameServer/Bot/AI/PlayerPartyRaid').tick(session, bot, Generics, BotAI)) return;
        const now = Date.now();
        if (!session.fleeStart) session.fleeStart = now;
        if (session.retreatContext?.at !== session.fleeStart) {
            const npc = NpcObjectIndex.find(invoke('GameServer/World/World'), session.lastRetreatPlan?.threatId);
            session.retreatContext = { at: session.fleeStart, kind: npc ? 'npc' : 'player',
                reason: session.raidSafetyResumePlan ? 'raid_entity_protected' : 'escape_threat',
                threatId: session.lastRetreatPlan?.threatId || null,
                threatName: session.lastRetreatPlan?.threatName || null,
                hpRatio: bot.fetchHp() / Math.max(1, bot.fetchMaxHp()),
                mpRatio: bot.fetchMp() / Math.max(1, bot.fetchMaxMp()) };
            session.lastRetreatAssessment = null;
        }
        const moving = stillMoving(session, bot);
        const partyRaidThreat = session.raidSafetyResumePlan === 'following' && session.followPlayerSession
            ? PartyAwareness.findThreatTargetingPartyProjected(session.followPlayerSession)
            : null;
        if (partyRaidThreat?.type === 'raid') {
            const threatChanged = Number(partyRaidThreat.actor.fetchId?.()) !== Number(session.lastRetreatPlan?.threatId);
            const canRepath = now - Number(session.lastRetreatRepathAt || 0) >= RETREAT_REPATH_COOLDOWN_MS;
            if (distance2d(partyRaidThreat.actor, bot) < RAID_PARTY_HOLD_DISTANCE && canRepath && (!moving || threatChanged)) {
                session.lastRetreatRepathAt = now;
                BotRetreatPlanner.retreat(session, bot, partyRaidThreat.actor);
            }
            // Never send a companion back to a leader still tanking a raid.
            return;
        }

        // Pursuit is a live targeting state, not time since the last hit or
        // residual hate. A monster returning home no longer owns this escape.
        const pursuers = PartyAwareness.npcsTargetingActor(session);
        const ids = pursuers.map(npc => Number(npc.fetchId())).sort((a, b) => a - b).join(',');
        const groupChanged = session.retreatPursuerIds !== undefined && session.retreatPursuerIds !== ids;
        session.retreatPursuerIds = ids;
        const retreatThreat = pursuers.find(npc => Number(npc.fetchId()) === Number(session.lastRetreatPlan?.threatId))
            || pursuers[0];
        if (pursuers.length && session.retreatContext.kind === 'npc' && now - session.fleeStart >= MIN_RETREAT_MS
            && !session.partyCompanion && !session.followPlayerSession && !session.hotBackgroundPartyId
            && !['unsafe_hunting_ground', 'raid_entity_protected'].includes(session.retreatContext.reason)
            && now - Number(session.lastRetreatEvaluationAt || 0) >= REASSESS_MS) {
            session.lastRetreatEvaluationAt = now;
            const assessment = ThreatAssessment.evaluate(session, bot, pursuers, { recovering: true });
            if (assessment.canFight) {
                const target = pursuers.find(npc => Number(npc.fetchId()) === assessment.targetId);
                finishRetreat(session, bot, now, 'fight_with_reserve', target);
                return;
            }
        }
        const canRepath = now - Number(session.lastRetreatRepathAt || 0) >= RETREAT_REPATH_COOLDOWN_MS;
        const legExpired = now - Number(session.lastRetreatPlan?.at || session.fleeStart) >= MAX_RETREAT_LEG_MS;
        if (retreatThreat) {
            if (canRepath && (!moving || groupChanged || legExpired)) {
                if (legExpired) bot.automation?.abortAll?.(bot);
                session.lastRetreatRepathAt = now;
                BotRetreatPlanner.retreat(session, bot, retreatThreat, { threats: pursuers });
            }
            return;
        }
        if (now - session.fleeStart < MIN_RETREAT_MS) return;
        // Preserve the existing player/PK escape leg; only NPC pursuit has
        // the live targeting projection above.
        if (session.retreatContext.kind !== 'npc' && moving && !legExpired) return;
        finishRetreat(session, bot, now, 'pursuit_ended');
    }
};
