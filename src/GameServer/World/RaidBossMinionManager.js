const DiagnosticConfig = require('../Bot/Population/PopulationConfig');
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const NpcDecay = invoke('GameServer/World/Generics/NpcDecay');
const RaidEntityIndex = invoke('GameServer/World/RaidEntityIndex');
const SpawnPlacement = invoke('GameServer/Geodata/SpawnPlacement');

// One manager for every Lisvus minion group: raid bosses and ordinary group
// leaders (data/Npcs/Minions). Lisvus keeps the raid rules apart: only raid
// minions return on a timer while their boss lives and leave with its death.
// An ordinary leader's minions spawn with it, are not replaced while it lives,
// outlive it, and give way to a fresh group when its spawn brings it back.
const groupsByBoss = new Map();
const minionTemplates = new Map();
// The last ordinary leader of each spawn definition, to replace its group.
const leaderBySpawnDefinition = new WeakMap();
const MINION_MAINTENANCE_INTERVAL_MS = 5000;
// C4/Lisvus Config.RAID_MINION_RESPAWN_TIME defaults to five minutes.
const MINION_RESPAWN_DELAY_MS = 300000;
const telemetry = {
    engagements: 0,
    minionsAlerted: 0,
    lastEngagementAt: 0,
    lastBossObjectId: null,
    lastAttackerId: null
};

[
    ...require('../../../data/Npcs/Minions/c4_raid_bosses.json'),
    ...require('../../../data/Npcs/Minions/c4_group_leaders.json')
].forEach((row) => {
    if (!groupsByBoss.has(Number(row.bossId))) groupsByBoss.set(Number(row.bossId), []);
    groupsByBoss.get(Number(row.bossId)).push({
        minionId: Number(row.minionId),
        min: Number(row.min),
        max: Number(row.max)
    });
});

function randomCount(min, max) {
    const low = Math.max(1, Number(min) || 1);
    const high = Math.max(low, Number(max) || low);
    return low + Math.floor(Math.random() * (high - low + 1));
}

function templateFor(minionId) {
    const id = Number(minionId);
    if (!minionTemplates.has(id)) {
        minionTemplates.set(id, ItemTemplateIndex.find(DataCache.npcs, id) || null);
    }
    return minionTemplates.get(id);
}

function isRaidBoss(boss) {
    return boss?.fetchIsRaidBoss?.() === true;
}

function liveNpc(world, npc) {
    return RaidEntityIndex.has(world, npc);
}

function aliveMinions(world, group) {
    group.members = group.members.filter((minion) => liveNpc(world, minion));
    return group.members.filter((minion) => minion.state?.fetchDead?.() !== true && minion.isDead?.() !== true);
}

function minionCoords(boss) {
    const coords = SpawnPlacement.nearLeader(boss);
    return coords ? { ...coords, head: Math.floor(Math.random() * 65536) } : null;
}

function spawnMinion(world, boss, group) {
    const template = templateFor(group.minionId);
    if (!template || boss.state?.fetchDead?.() === true) return null;

    const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');
    // The boss ids mark raid entities for raid rules and bot safety; an
    // ordinary minion is a plain monster that only knows its leader.
    const link = isRaidBoss(boss) ? {
        minionBossTemplateId: Number(boss.fetchSelfId?.() || 0),
        minionBossObjectId: Number(boss.fetchId?.() || 0),
        minionGroup: group
    } : { minionLeader: boss, minionGroup: group };
    const coords = minionCoords(boss);
    if (!coords) {
        if (!group.placementWarning) utils.infoWarn('SpawnPlacement',
            'Minions of NPC %d deferred: leader has no supported geodata surface', boss.fetchSelfId());
        group.placementWarning = true;
        return null;
    }
    group.placementWarning = false;
    const minion = SpawnNpcs.spawnChildNpc(world, template, coords, link);
    if (minion) group.members.push(minion);
    return minion;
}

function scheduleDeferredMinions(world, state) {
    if (state.minionPlacementTimer || !state.deferredMinionGroups?.size) return;
    state.minionPlacementTimer = setTimeout(() => {
        state.minionPlacementTimer = null;
        if (world.npc !== state) return;
        for (const [group, entry] of state.deferredMinionGroups) {
            const { boss } = entry;
            if (!liveNpc(world, boss) || boss.state?.fetchDead?.() === true || boss.isDead?.() === true
                || !boss.minionState?.groups.includes(group)) {
                state.deferredMinionGroups.delete(group);
                continue;
            }
            // Only uncreated members are retried. Dead ordinary minions must
            // not be resurrected by the placement-recovery mechanism.
            try {
                while (entry.remaining > 0 && spawnMinion(world, boss, group)) entry.remaining--;
            } catch (error) {
                // Unlike a null placement result, an exception may follow a
                // published child. Replaying the remaining count could duplicate it.
                state.deferredMinionGroups.delete(group);
                utils.infoWarn('SpawnPlacement', 'Deferred minion creation failed for NPC %d; automatic retry stopped after possible partial creation: %s',
                    boss.fetchSelfId(), error.message);
            }
            if (!entry.remaining) state.deferredMinionGroups.delete(group);
        }
        scheduleDeferredMinions(world, state);
    }, 60000);
    state.minionPlacementTimer.unref?.();
}

function fillGroup(world, boss, group, count = group.desired) {
    const live = aliveMinions(world, group).length;
    for (let index = live; index < count; index++) {
        if (spawnMinion(world, boss, group)) continue;
        if (!isRaidBoss(boss)) {
            world.npc.deferredMinionGroups ||= new Map();
            world.npc.deferredMinionGroups.set(group, { boss, remaining: count - index });
            scheduleDeferredMinions(world, world.npc);
        }
        break;
    }
}

function attachBoss(world, boss) {
    const bossId = Number(boss?.fetchSelfId?.() || 0);
    const definitions = groupsByBoss.get(bossId) || [];
    if (!boss || definitions.length === 0 || boss.minionState) return boss?.minionState || null;
    if (!isRaidBoss(boss) && boss.spawnDefinition) {
        const previous = leaderBySpawnDefinition.get(boss.spawnDefinition);
        if (previous && previous !== boss) removeMinions(world, previous);
        leaderBySpawnDefinition.set(boss.spawnDefinition, boss);
    }

    const state = {
        boss,
        groups: definitions.map((definition) => ({
            ...definition,
            desired: randomCount(definition.min, definition.max),
            members: [],
            respawnAt: 0
        }))
    };
    boss.minionState = state;
    state.groups.forEach((group) => fillGroup(world, boss, group));
    return state;
}

function onBossAttacked(world, boss, attacker, sourceSession) {
    if (!boss || !attacker || boss.state?.fetchDead?.() === true || attacker.isDead?.() === true) return 0;
    const state = boss.minionState || attachBoss(world, boss);
    if (!state) return 0;

    const session = sourceSession || {
        dataSendToMeAndOthers() {},
        dataSendToMe() {}
    };
    let alerted = 0;
    state.groups.forEach((group) => {
        aliveMinions(world, group).forEach((minion) => {
            if (minion.state?.fetchCombats?.() === true) return;
            try {
                minion.enterCombatState?.(session, attacker, { skipMinionAssist: true });
                if (minion.state?.fetchCombats?.() === true) alerted++;
            } catch (_) {}
        });
    });
    // `alerted > 0` is naturally edge-triggered: later hits see the same
    // minions already in combat, so one encounter produces one concise line.
    if (DiagnosticConfig.developerDiagnostics && alerted > 0 && isRaidBoss(boss)) {
        const observedAt = Date.now();
        telemetry.engagements += 1;
        telemetry.minionsAlerted += alerted;
        telemetry.lastEngagementAt = observedAt;
        telemetry.lastBossObjectId = Number(boss.fetchId?.() || 0) || null;
        telemetry.lastAttackerId = Number(attacker.fetchId?.() || 0) || null;
        console.info(
            'RaidCombat :: engaged boss=%s attacker=%s minionsAlerted=%d',
            telemetry.lastBossObjectId || 'unknown',
            telemetry.lastAttackerId || 'unknown',
            alerted
        );
    }
    return alerted;
}

function bossForMinion(world, minion) {
    return minion?.minionLeader || RaidEntityIndex.bossFor(world, minion);
}

// Lisvus TARGET_CLAN of a minion: its leader and the leader's live minions.
function leaderGroup(world, leader) {
    const members = [leader];
    leader?.minionState?.groups?.forEach((group) => members.push(...aliveMinions(world, group)));
    return members;
}

// A raid minion's aggression alerts the whole group, including idle respawns
// while the boss is already fighting. Do not retarget an engaged boss or fan
// assistance back through each member; one bounded group pass is enough.
// Ordinary leaders retain their existing idle-only assistance rule.
function onMinionAttacked(world, minion, attacker, sourceSession) {
    if (!minion || !attacker || minion.state?.fetchDead?.() === true || attacker.isDead?.() === true) return 0;

    const boss = bossForMinion(world, minion);
    if (
        !boss ||
        boss.state?.fetchDead?.() === true ||
        boss.isDead?.() === true ||
        (boss.state?.fetchCombats?.() === true && !isRaidBoss(boss))
    ) return 0;

    const session = sourceSession || {
        dataSendToMeAndOthers() {},
        dataSendToMe() {}
    };
    if (boss.state?.fetchCombats?.() !== true) {
        boss.enterCombatState?.(session, attacker, { skipMinionAssist: true });
    }
    if (boss.state?.fetchCombats?.() !== true) return 0;
    return onBossAttacked(world, boss, attacker, session);
}

function onMinionDeath(world, minion) {
    const boss = RaidEntityIndex.bossFor(world, minion);
    const group = minion?.minionGroup;
    if (!boss?.minionState || !group) return false;
    if (!group.respawnAt) group.respawnAt = Date.now() + MINION_RESPAWN_DELAY_MS;
    return true;
}

function cleanupMinion(world, minion, sourceSession) {
    if (!liveNpc(world, minion)) return false;
    try {
        minion.destructor?.(sourceSession || { dataSendToMeAndOthers() {}, dataSendToMe() {} });
    } catch (_) {}
    return NpcDecay.decay(world, minion, sourceSession);
}

// A raid boss's death and an ordinary leader's replacement remove the group.
function removeMinions(world, boss, sourceSession) {
    const state = boss?.minionState;
    if (!state) return 0;
    let removed = 0;
    state.groups.forEach((group) => {
        world.npc.deferredMinionGroups?.delete(group);
        group.members.forEach((minion) => {
            if (cleanupMinion(world, minion, sourceSession)) removed++;
        });
        group.members = [];
    });
    boss.minionState = null;
    return removed;
}

function stats() {
    if (!DiagnosticConfig.developerDiagnostics) return { enabled: false };
    return { ...telemetry };
}

function maintain(world, now = Date.now()) {
    if (!world?.npc?.spawns) return 0;
    let spawned = 0;
    RaidEntityIndex.bosses(world).forEach((boss) => {
        if (boss.state?.fetchDead?.() === true || boss.isDead?.() === true) return;
        const state = boss.minionState || attachBoss(world, boss);
        state?.groups?.forEach((group) => {
            const alive = aliveMinions(world, group).length;
            if (alive >= group.desired) {
                group.respawnAt = 0;
                return;
            }
            if (!group.respawnAt) group.respawnAt = now + MINION_RESPAWN_DELAY_MS;
            if (now >= group.respawnAt) {
                const before = group.members.length;
                fillGroup(world, boss, group);
                spawned += Math.max(0, group.members.length - before);
                group.respawnAt = 0;
            }
        });
    });
    return spawned;
}

function start(world) {
    stop(world);
    if (!world?.npc) return null;
    world.npc.raidBossMinionTicker = setInterval(() => maintain(world), MINION_MAINTENANCE_INTERVAL_MS);
    world.npc.raidBossMinionTicker.unref?.();
    scheduleDeferredMinions(world, world.npc);
    return world.npc.raidBossMinionTicker;
}

function stop(world) {
    if (!world?.npc) return;
    clearInterval(world.npc.raidBossMinionTicker);
    world.npc.raidBossMinionTicker = undefined;
    clearTimeout(world.npc.minionPlacementTimer);
    world.npc.minionPlacementTimer = null;
}

module.exports = {
    MINION_RESPAWN_DELAY_MS,
    attachBoss,
    onBossAttacked,
    onMinionAttacked,
    onMinionDeath,
    onBossDeath: removeMinions,
    removeMinions,
    leaderGroup,
    maintain,
    start,
    stop,
    stats,
    groupsByBoss
};
