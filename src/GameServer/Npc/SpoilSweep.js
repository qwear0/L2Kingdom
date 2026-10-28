const DataCache      = invoke('GameServer/DataCache');
const ServerResponse = invoke('GameServer/Network/Response');
const ConsoleText    = invoke('GameServer/ConsoleText');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');
const Formulas = invoke('GameServer/Formulas');
const HotPartyCastTracker = invoke('GameServer/Bot/AI/HotPartyCastTracker');
const NpcObjectIndex = require('../World/NpcObjectIndex');

const SPOIL_SKILL_ID = 254;
const SPOIL_FESTIVAL_SKILL_ID = 302;
const SWEEP_SKILL_ID = 42;
const SPOILED_CORPSE_TIME = 30000;

function fetchSpoilGroups(npc) {
    let spoils = [];
    DataCache.fetchNpcRewardsFromSelfId(npc.fetchSelfId(), (result) => {
        spoils = result.spoils ?? [];
    });
    return spoils;
}

function hasSpoils(npc) {
    return fetchSpoilGroups(npc).some((group) => (group.items ?? []).length > 0);
}

function rollSpoils(npc) {
    const awarded = [];
    const dropState = npc.model ?? npc;
    const rewardContext = {
        npcLevel: npc.fetchLevel?.() ?? npc.model?.level,
        killerLevel: dropState.dropLastAttackerLevel,
        attackerLevels: dropState.dropAttackerLevels ?? []
    };

    fetchSpoilGroups(npc).forEach((group) => {
        const groupRoll = ProgressionRates.rewardGroupRoll(group, 'spoil', rewardContext);
        if (!groupRoll.hit) {
            return;
        }

        let number = Math.random() * 100;
        let rewardPartition = 0;

        for (const item of group.items ?? []) {
            rewardPartition += item.chance;

            if (number <= rewardPartition) {
                const baseAmount = utils.oneFromSpan(item.min, item.max);
                awarded.push({
                    selfId: item.selfId,
                    name: item.name,
                    amount: ProgressionRates.scaleAmount(baseAmount, groupRoll.amountMultiplier)
                });
                break;
            }
        }
    });

    return awarded;
}

function spendSkillMp(session, actor, skill) {
    if (actor.fetchMp() < skill.fetchConsumedMp()) {
        ConsoleText.transmit(session, ConsoleText.caption.depletedMp);
        return false;
    }

    actor.setMp(actor.fetchMp() - skill.fetchConsumedMp());
    actor.statusUpdateVitals(actor);
    actor.automation.replenishVitals(actor);
    return true;
}

function castUtilitySkill(session, actor, target, skill, effect, offensiveTargets = null, actionOwner = null, resumeAttack = null) {
    if (!invoke('GameServer/Actor/PlayerActionOwner').current(session, actor, actionOwner)) return;
    const autoFight = offensiveTargets && invoke('GameServer/Actor/PlayerAutoFightPolicy').forAction(session, actor, actionOwner);
    if (autoFight && !autoFight.canInitiate(offensiveTargets, actor)) return;
    if (actor.state.fetchCasts()) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    if (actor.fetchMp() < skill.fetchConsumedMp()) {
        ConsoleText.transmit(session, ConsoleText.caption.depletedMp);
        return;
    }

    // Utility casts bypass Attack.remoteHit. Admit/register offensive recipients
    // before entering casting state; Sweep needs tracking, not a live-target claim.
    const cast = autoFight || actionOwner ? { target, skill, actionOwner, autoFightTargets: offensiveTargets || [] } : null;
    if (autoFight) autoFight.acceptTargets(offensiveTargets);

    skill.setCalculatedHitTime(skill.fetchHitTime());
    session.dataSendToMeAndOthers(ServerResponse.skillStarted(actor, target.fetchId(), skill), actor);
    session.dataSendToMe(ServerResponse.skillDurationBar(skill.fetchCalculatedHitTime()));
    actor.state.setCasts(true);
    if (!actor.attack.queue.name || actor.attack.queue.name === 'skill') actor.attack.queue.resumeAttack = resumeAttack;
    HotPartyCastTracker.begin(session, actor, target, skill);
    if (cast) actor.attack.activeCast = cast;
    actionOwner?.nativeEvent?.('cast_started');

    actor.attack.queueTimer(() => {
        if (cast && actor.attack.activeCast !== cast) return;
        if (cast) actor.attack.activeCast = null;
        HotPartyCastTracker.clear(actor);
        actor.state.setCasts(false);
        if (actor.isDead() || session.actor !== actor || !spendSkillMp(session, actor, skill)) {
            actionOwner?.nativeEvent?.('native_cancelled');
            return;
        }
        actionOwner?.nativeEvent?.('cast_resources', { mpCost: skill.fetchConsumedMp() });
        Promise.resolve().then(effect).then(outcome => {
            actionOwner?.nativeEvent?.('cast_effect', { targetId: target.fetchId(), skillId: skill.fetchSelfId(), ...outcome });
            actionOwner?.nativeEvent?.('cast_end');
            if (resumeAttack && (actor.attack.queue.name || actor.attack.queue.resumeAttack)) actor.attack.dequeueEvent(session);
        }).catch(error => {
            actionOwner?.nativeEvent?.('native_settlement_failed', { reason: 'utility_cast_settlement_failed' });
            utils.infoWarn('SpoilSweep', 'native utility settlement failed: %s', error.message);
        });
    }, skill.fetchCalculatedHitTime());
}

function spoilRecipientSession(session, npc, selfId) {
    const leaderSession = session?.partyCompanion === true && session.followPlayerSession
        ? session.followPlayerSession
        : session;
    if (leaderSession?.hotBackgroundPartyId) {
        return PartyCompanionService.resolveLootSession(session, selfId, npc, { spoil: true });
    }
    const distribution = PartyCompanionService.distributionForLeader(leaderSession);
    if (distribution === 2 || distribution === 4) {
        return PartyCompanionService.resolveLootSession(session, selfId, npc, { spoil: true });
    }
    return session;
}

function markSpoiled(session, actor, npc, skill, { announce = false, festival = false } = {}) {
    if (!npc?.fetchAttackable?.() || npc.isDead?.() || !hasSpoils(npc) || npc.model?.spoil?.spoiled) return false;

    npc.model = npc.model || {};
    npc.model.spoil = {
        spoiled: true,
        swept: false,
        spoilerId: actor.fetchId(),
        spoilerName: actor.fetchName(),
        spoiledAt: Date.now()
    };
    if (festival) {
        const effect = EffectStore.apply(npc, {
            key: 'spoil_festival',
            id: SPOIL_FESTIVAL_SKILL_ID,
            level: skill.fetchLevel?.() || 1,
            name: skill.fetchName?.() || 'Spoil Festival',
            type: 'debuff',
            category: 'spoil',
            stats: { pAtkSpdMul: 0.77 },
            durationMs: 15000
        });
        EffectTicker.scheduleExpiry(session, npc, effect);
    }
    npc.enterCombatState?.(session, actor);
    if (announce) ConsoleText.transmit(session, ConsoleText.caption.spoilActivated);
    return true;
}

function spoilLands(actor, npc, skill, rng = Math.random) {
    return Formulas.calcSpoilSuccess({
        skillId: skill?.fetchSelfId?.(),
        skillLevel: skill?.fetchLevel?.(),
        attackerLevel: actor?.fetchLevel?.(),
        targetLevel: npc?.fetchLevel?.()
    }, rng);
}

const SpoilSweep = {
    isSpoilSkill(selfId) {
        return Number(selfId) === SPOIL_SKILL_ID;
    },

    isSpoilFestivalSkill(selfId) {
        return Number(selfId) === SPOIL_FESTIVAL_SKILL_ID;
    },

    isSweepSkill(selfId) {
        return Number(selfId) === SWEEP_SKILL_ID;
    },

    isSweepable(npc) {
        return !!npc.model.spoil?.spoiled && !npc.model.spoil?.swept && hasSpoils(npc);
    },

    markSpoiled(session, actor, npc, skill, options) {
        return markSpoiled(session, actor, npc, skill, options);
    },

    trySpoilCrush(session, actor, npc, skill, rng = Math.random) {
        if (!npc?.fetchAttackable?.() || npc.isDead?.() || !hasSpoils(npc) || npc.model?.spoil?.spoiled) return false;
        if (!spoilLands(actor, npc, skill, rng)) return false;
        return markSpoiled(session, actor, npc, skill, { announce: true });
    },

    corpseTime(npc) {
        const corpseTime = Number(npc.fetchCorpseTime()) || 0;
        return this.isSweepable(npc) ? Math.max(corpseTime, SPOILED_CORPSE_TIME) : corpseTime;
    },

    castSpoil(session, actor, npc, skill, actionOwner = null, resumeAttack = null) {
        this.castSpoilTargets(session, actor, [npc], skill, actionOwner, resumeAttack);
    },

    castSpoilTargets(session, actor, targets, skill, actionOwner = null, resumeAttack = null) {
        const eligible = [...new Map((targets || []).filter(Boolean)
            .map((npc) => [npc.fetchId?.(), npc]))].map(([, npc]) => npc)
            .filter((npc) => npc.fetchAttackable?.() && !npc.isDead?.() && hasSpoils(npc) && !npc.model?.spoil?.spoiled);
        if (eligible.length === 0) {
            actionOwner?.nativeEvent?.('native_rejected', { reason: 'no_spoilable_targets' });
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        castUtilitySkill(session, actor, eligible[0], skill, () => {
            const spoiled = eligible.filter((npc) => !npc.isDead?.() && !npc.model?.spoil?.spoiled);
            if (spoiled.length === 0) {
                session.dataSendToMe(ServerResponse.actionFailed());
                return;
            }

            const festival = Number(skill.fetchSelfId?.()) === SPOIL_FESTIVAL_SKILL_ID;
            let landed = 0;
            spoiled.forEach((npc) => {
                // Like Lisvus Spoil.java, a failed spoil still draws the target into combat.
                if (!spoilLands(actor, npc, skill)) {
                    npc.enterCombatState?.(session, actor);
                    return;
                }
                if (markSpoiled(session, actor, npc, skill, { festival })) landed += 1;
            });
            for (const npc of spoiled) invoke('GameServer/Quest/QuestService').onSkillSee(session, npc, skill, actor)
                .catch(error => utils.infoWarn('Quest', 'skill callback failed: %s', error.message));
            if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info('SpoilSweep :: %s spoiled %d of %d targets with %s', actor.fetchName(), landed, spoiled.length, skill.fetchName());
            if (landed > 0) ConsoleText.transmit(session, ConsoleText.caption.spoilActivated);
            return { effective: landed > 0, spoiled: landed, eligible: spoiled.length };
        }, eligible, actionOwner, resumeAttack);
    },

    castSweep(session, actor, npc, skill, actionOwner = null, resumeAttack = null) {
        // A hot bot may finish its queued approach after the corpse decayed.
        const expiredBotCorpse = () => String(session?.accountId || '').startsWith('bot_')
            && (npc.corpseDecayState === 'removed'
                || Number(npc.corpseDecayAt || Infinity) <= Date.now());
        if (expiredBotCorpse()) { actionOwner?.nativeEvent?.('native_rejected', { reason: 'corpse_expired' }); return; }
        if (!npc.isDead()) {
            actionOwner?.nativeEvent?.('native_rejected', { reason: 'corpse_required' });
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        if (!this.isSweepable(npc)) {
            actionOwner?.nativeEvent?.('native_rejected', { reason: 'not_sweepable' });
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        if (npc.model.spoil?.spoilerId && npc.model.spoil.spoilerId !== actor.fetchId()) {
            actionOwner?.nativeEvent?.('native_rejected', { reason: 'not_spoiler' });
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        castUtilitySkill(session, actor, npc, skill, async () => {
            if (expiredBotCorpse() || !this.isSweepable(npc)) {
                session.dataSendToMe(ServerResponse.actionFailed());
                return;
            }

            const awarded = rollSpoils(npc);
            npc.model.spoil.swept = true;

            const settlements = [];
            if (awarded.length === 0) {
                session.dataSendToMe(ServerResponse.actionFailed());
            } else {
                awarded.forEach((item) => {
                    const recipientSession = spoilRecipientSession(session, npc, item.selfId);
                    settlements.push(invoke('GameServer/World/World').purchaseItem(recipientSession, item.selfId, item.amount));
                    const textName = { kind: ConsoleText.kind.item, value: item.selfId };
                    const textAmount = { kind: ConsoleText.kind.number, value: item.amount };
                    item.amount > 1
                        ? ConsoleText.transmit(recipientSession, ConsoleText.caption.pickupAmountOf, [textName, textAmount])
                        : ConsoleText.transmit(recipientSession, ConsoleText.caption.pickup, [textName]);
                    if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info('SpoilSweep :: %s swept %d %s from %s', actor.fetchName(), item.amount, item.name, npc.fetchName());
                });
            }

            session.dataSendToMeAndOthers(ServerResponse.deleteOb(npc.fetchId()), npc);
            const World = invoke('GameServer/World/World');
            NpcObjectIndex.remove(World, npc);
            World.npc.spawns = World.npc.spawns.filter((ob) => ob.fetchId() !== npc.fetchId());
            const results = await Promise.all(settlements);
            if (results.some(result => result.status !== 'awarded')) throw Error('sweep_award_uncertain');
            return { effective: awarded.length > 0, awarded: awarded.map(item => ({ templateId: item.selfId, amount: item.amount })),
                recipients: results.length };
        }, null, actionOwner, resumeAttack);
    }
};

module.exports = SpoilSweep;
module.exports.rollSpoils = rollSpoils;
module.exports.hasSpoils = hasSpoils;
