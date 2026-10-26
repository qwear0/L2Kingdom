const NpcObjectIndex = require('../World/NpcObjectIndex');
const TownGuard = require('./TownGuard');

const LEASH_RADIUS = 2500;
const HOME_TOLERANCE = 32;
const RETRY_MS = 5000;
let raidSafety;

function ordinaryMonster(npc) {
    if (npc.fetchKind?.() !== 'Monster' || npc.fetchIsSummon?.() || npc.fetchIsPet?.()
        || !(npc.spawnDefinition || npc.minionLeader) || !npc.spawnOrigin) return false;
    raidSafety ||= invoke('GameServer/Bot/AI/BotRaidSafety');
    return !raidSafety.isProtectedRaidEntity(npc) && !TownGuard.isTownGuard(npc);
}

function outsideLeash(npc) {
    const home = npc.spawnOrigin;
    if (!home) return false;
    const dx = npc.fetchLocX() - home.locX, dy = npc.fetchLocY() - home.locY;
    return dx * dx + dy * dy >= LEASH_RADIUS * LEASH_RADIUS && ordinaryMonster(npc);
}

function cancel(npc) {
    const state = npc.returningHome;
    if (!state) return;
    npc.returningHome = null;
    clearTimeout(state.timer);
    invoke('GameServer/Geodata/PathfindingWorkerPool').cancel(`npc:${npc.fetchId()}`);
}

function start(npc, session, reason) {
    if (!ordinaryMonster(npc) || npc.state.fetchDead()) return false;
    if (npc.returningHome) return true;
    npc.abortCombatState(session);
    npc.attack.abortCast?.(session, npc);
    npc.attack.clearTimers?.();
    const Effects = invoke('GameServer/Effects/EffectTicker');
    Effects.clearAll(npc);
    invoke('GameServer/Effects/EffectRestrictions').stopFear(npc);
    npc.effects = {};
    npc.activeBuffs = {};
    const state = npc.returningHome = { reason, at: Date.now(), timer: null, path: [], warned: false };
    const World = invoke('GameServer/World/World');
    const home = npc.spawnOrigin;
    const current = () => npc.returningHome === state && !npc.state.fetchDead()
        && NpcObjectIndex.find(World, npc.fetchId()) === npc;
    const schedule = (delay) => {
        if (!current()) return;
        state.timer = setTimeout(step, delay);
        state.timer.unref?.();
    };
    const retry = (error) => {
        if (!current()) return;
        state.path = [];
        if (!state.warned) {
            utils.infoWarn('NpcReturn', 'NPC %d cannot return home (%s); retrying bounded pathfinding',
                npc.fetchId(), error?.code || error?.message || 'no_route');
            state.warned = true;
        }
        schedule(RETRY_MS);
    };
    const step = () => {
        if (!current()) return;
        if (npc.state.inMotion()) { schedule(500); return; }
        if (Math.hypot(npc.fetchLocX() - home.locX, npc.fetchLocY() - home.locY) <= HOME_TOLERANCE
            && Math.abs(npc.fetchLocZ() - home.locZ) <= 64) {
            npc.fillupVitals();
            delete npc.model.spoil;
            delete npc.model.overhitContext;
            delete npc.model.dropAttackerLevels;
            delete npc.model.dropLastAttackerLevel;
            npc.petDamage?.clear();
            npc.returningHome = null;
            npc.setStateRun(false);
            session.dataSendToMeAndOthers(invoke('GameServer/Network/Response').walkAndRun(
                npc.fetchId(), npc.fetchStateRun()), npc);
            npc.broadcastVitals();
            invoke('GameServer/Npc/NpcAggro').armSpawnGrace(npc);
            return;
        }
        const next = state.path[0];
        if (next) {
            if (Math.hypot(npc.fetchLocX() - next.locX, npc.fetchLocY() - next.locY) <= 1
                && Math.abs(npc.fetchLocZ() - next.locZ) <= 1) {
                state.path.shift();
                schedule(0);
            } else if (npc.automation.scheduleMoveToCoords(session, npc, next)) schedule(500);
            else retry();
            return;
        }
        invoke('GameServer/Geodata/PathfindingWorkerPool').request({
            startX: npc.fetchLocX(), startY: npc.fetchLocY(), startZ: npc.fetchLocZ(),
            endX: home.locX, endY: home.locY, endZ: home.locZ,
            maxNodes: 8000
        }, { key: `npc:${npc.fetchId()}`, timeoutMs: 10000 }).then((path) => {
            if (!current()) return;
            const last = path?.at(-1);
            if (!last || Math.hypot(last.locX - home.locX, last.locY - home.locY) > HOME_TOLERANCE
                || Math.abs(last.locZ - home.locZ) > 64) { retry(); return; }
            // A one-point path is the direct route when geodata is absent.
            state.path = path.length > 1 ? path.slice(1) : path;
            state.warned = false;
            schedule(0);
        }).catch(error => {
            if (current()) retry(error);
        });
    };
    // Returning is a combat reset, not another encounter. Until arrival the
    // NPC cannot reacquire a fleeing target or be farmed as a passive victim.
    npc.setStateRun(true);
    session.dataSendToMeAndOthers(invoke('GameServer/Network/Response').walkAndRun(
        npc.fetchId(), npc.fetchStateRun()), npc);
    step();
    return true;
}

module.exports = { LEASH_RADIUS, outsideLeash, start, cancel };
