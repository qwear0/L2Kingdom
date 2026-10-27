const DataCache = invoke('GameServer/DataCache');
const SpeckMath = invoke('GameServer/SpeckMath');
const BotLootEtiquette = invoke('GameServer/Bot/AI/BotLootEtiquette');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

function isBotSession(session) {
    return !!(session && (session.constructor.name === 'BotSession' || (session.accountId && session.accountId.startsWith('bot_'))));
}

function awardDrop(world, session, npc, selfId, amount, drops) {
    DataCache.fetchItemFromSelfId(selfId, (itemDetails) => {
        const details = utils.crushOb(itemDetails);
        const stackable = details.stackable === true;
        const instances = stackable ? 1 : amount;
        const instanceAmount = stackable ? amount : 1;
        for (let index = 0; index < instances; index++) {
            spawnGroundDrop(world, session, npc, selfId, instanceAmount);
        }
        if (drops) {
            const previous = drops.get(selfId);
            drops.set(selfId, { name: details.name, amount: (previous?.amount || 0) + amount });
        }
        if (!isBotSession(session)) {
            BotLootEtiquette.observeDrop(session, npc, selfId, amount);
        }
    });
}

function spawnGroundDrop(world, session, npc, selfId, amount) {
    const origin = { locX: npc.fetchLocX(), locY: npc.fetchLocY(), locZ: npc.fetchLocZ() };
    let coords = origin;
    // A nearest-height lookup can scatter loot onto an adjacent roof. Keep
    // scatter on a walkable continuation of the corpse's floor; if bounded
    // attempts fail, drop at the corpse instead of inventing another layer.
    for (let attempt = 0; attempt < 6; attempt++) {
        const point = new SpeckMath.Circle(origin.locX, origin.locY, 50).createPointWithin().toCoords();
        const destination = GeodataEngine.walkSegment(origin, { ...point, locZ: origin.locZ });
        if (destination) { coords = destination; break; }
    }
    const leaderSession = PartyCompanionService.groundLootLeader(session);
    world.spawnItem(session, selfId, amount, {
        ...coords,
        // Ground items have no native owner metadata in this runtime. Keep a
        // lightweight provenance marker so an idle party never treats another
        // group's nearby drop as its own recovery work.
        partyLootLeaderId: Number(leaderSession?.actor?.fetchId?.() || 0)
    }, (item) => {
        PartyCompanionService.queueRandomGroundPickup(session, item);
    });
}

function npcRewards(session, npc) {
    let drops = null;
    // DataCache callbacks are synchronous. Return the actual ground-drop totals
    // for raid announcements without rerolling rewards or retaining per-NPC state.
    DataCache.fetchNpcRewardsFromSelfId(npc.fetchSelfId(), (result) => {
        if (npc.fetchIsRaidBoss?.() === true) drops = new Map();
        const rewards = result.rewards ?? [];
        const dropState = npc.model ?? npc;
        const rewardContext = {
            npcLevel: npc.fetchLevel?.() ?? npc.model?.level,
            killerLevel: dropState.dropLastAttackerLevel ?? session?.actor?.fetchLevel?.(),
            attackerLevels: dropState.dropAttackerLevels ?? []
        };

        rewards.forEach((reward) => {
            const groupRoll = ProgressionRates.rewardGroupRoll(reward, 'drop', rewardContext);
            if (groupRoll.hit) {
                const item = ProgressionRates.selectDropItem(reward, groupRoll.itemRate);
                if (!item) return;
                const amount = ProgressionRates.rollDropAmount(reward, item, groupRoll.itemRate);
                awardDrop(this, session, npc, item.selfId, amount, drops);
            }
        });
    });
    return drops;
}

module.exports = npcRewards;
