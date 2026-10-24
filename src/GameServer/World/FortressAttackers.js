const Layout = require('./FortressDefenseData');
const World = invoke('GameServer/World/World');
const DataCache = invoke('GameServer/DataCache');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const Paths = invoke('GameServer/Geodata/PathfindingWorkerPool');
const Spawn = invoke('GameServer/World/Generics/SpawnNpcs');
const Response = invoke('GameServer/Network/Response');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const NpcAggro = invoke('GameServer/Npc/NpcAggro');
const Doors = require('../ClanHall/Doors');

let state = 'unused';
let stopped = false;
let releaseTimer = null;
let marchTimer = null;
let releasedGroups = 0;
let releasedMobs = 0;
let failedGroup = null;
let starting = null;
let transport = null;
const actors = new Map();
const pathKeys = new Set();

const loc = actor => ({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
const distance = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);
function visiblePath(a, b) {
    return Geo.hasLineOfSight(a.locX, a.locY, a.locZ, b.locX, b.locY, b.locZ);
}
function ground(point) {
    const locZ = Geo.getHeight(point.locX, point.locY, point.locZ);
    if (!Geo.hasGeo(point.locX, point.locY)) throw new Error('Fortress geodata is missing. Attack was not started.');
    if (Math.abs(locZ - point.locZ) > 1024) throw new Error('Fortress route is on an unexpected terrain layer.');
    return { ...point, locZ };
}
async function path(from, to, key) {
    pathKeys.add(key);
    try {
        const result = await Paths.request({ startX: from.locX, startY: from.locY, startZ: from.locZ,
            endX: to.locX, endY: to.locY, endZ: to.locZ, maxNodes: 40000 }, { key, timeoutMs: 5000, priority: 1 });
        if (stopped) throw new Error('Server is shutting down');
        if (!result?.length || distance(result[result.length - 1], to) > 32
            || Math.abs(result[result.length - 1].locZ - to.locZ) > 64) throw new Error('A fortress route cannot reach its destination.');
        let previous = from;
        for (const point of result) {
            if (!Geo.hasGeo(point.locX, point.locY) || !visiblePath(previous, point)) throw new Error('A fortress route is blocked by terrain or a door.');
            previous = point;
        }
        return result;
    } finally {
        pathKeys.delete(key);
    }
}

async function preflight() {
    const templates = new Map([547, 63, 207].map(id => [id, DataCache.npcs.find(npc => Number(npc.selfId) === id)]));
    if ([...templates.values()].some(npc => !npc || npc.template.kind !== 'Monster')) throw new Error('Fortress attacker template is missing.');
    const plans = [];
    const ingress = new Map();
    for (let group = 0; group < Layout.GROUPS; group++) {
        const members = [];
        for (let member = 0; member < Layout.GROUP_SIZE; member++) {
            const spec = Layout.attacker(group, member);
            const spawn = ground(spec.spawn);
            const approach = ground(spec.points[0]);
            const finish = ground(spec.points[1]);
            const key = `${spec.route}:${member}`;
            if (!ingress.has(key)) ingress.set(key, await path(spawn, approach, `fortress:preflight:${key}`));
            const tail = await path(approach, finish, `fortress:preflight:${group}:${member}:tail`);
            members.push({ ...spec, spawn, template: templates.get(spec.selfId), path: [...ingress.get(key), ...tail] });
        }
        plans.push(members);
    }
    return plans;
}

function stopMove(record) {
    record.generation++;
    if (!record.moving) return;
    record.npc.automation.abortMovement(record.npc);
    if (!record.npc.isDead()) World.addNpcToGrid(record.npc);
    record.moving = false;
    transport.dataSendToMeAndOthers(Response.stopMove(record.npc.fetchId(), { ...loc(record.npc), head: record.npc.fetchHead() }), record.npc);
}

function rejoin(record, now) {
    if (record.pending || now < record.retryAt) return;
    const npc = record.npc;
    const destination = record.path[Math.min(record.cursor, record.path.length - 1)];
    const generation = record.generation;
    record.pending = true;
    record.retryAt = now + 5000;
    path(loc(npc), destination, `fortress:resume:${npc.fetchId()}`).then(points => {
        if (stopped || record.generation !== generation || npc.state.fetchCombats() || npc.isDead()) return;
        record.path = [...points, ...record.path.slice(record.cursor + 1)];
        record.cursor = 0;
        record.rejoin = false;
        record.failures = 0;
    }).catch(error => {
        if (stopped || record.generation !== generation) return;
        record.failures++;
        record.retryAt = Date.now() + Math.min(30000, record.failures * 5000);
        if (record.failures === 1 || record.failures === 3) utils.infoWarn('Fortress', 'attacker %d route blocked: %s', npc.fetchId(), error.message);
    }).finally(() => { record.pending = false; });
}

function advance(record) {
    if (stopped || record.moving || record.pending || record.rejoin) return;
    const npc = record.npc;
    if (npc.isDead() || npc.state.fetchCombats() || !Restrictions.canMove(npc)) return;
    while (record.cursor < record.path.length && distance(loc(npc), record.path[record.cursor]) < 24
        && Math.abs(npc.fetchLocZ() - record.path[record.cursor].locZ) <= 64) record.cursor++;
    if (record.cursor >= record.path.length) return;
    const next = record.path[record.cursor];
    if (!visiblePath(loc(npc), next)) { record.rejoin = true; return; }
    // Native combat cleanup switches to walking; advertise running before
    // coordinate movement resumes at the server's running speed.
    if (!npc.fetchStateRun()) {
        npc.setStateRun(true);
        transport.dataSendToMeAndOthers(Response.walkAndRun(npc.fetchId(), true), npc);
    }
    const generation = record.generation;
    record.moving = true;
    record.sample = { ...loc(npc), at: Date.now() };
    if (!npc.automation.scheduleMoveToCoords(transport, npc, next, () => {
        if (stopped || record.generation !== generation) return;
        record.moving = false;
        World.addNpcToGrid(npc);
        record.cursor++;
        advance(record);
    })) {
        record.moving = false;
        record.rejoin = true;
    }
}

function tick() {
    const now = Date.now();
    const defenders = (World.user.sessions || []).filter(session => session.actor?.fetchIsOnline?.()
        && !session.actor.state?.fetchDead?.() && session.actor.fetchHp() > 0);
    for (const [id, record] of actors) {
        const npc = record.npc;
        if (npc.isDead()) {
            stopMove(record);
            Paths.cancel(`fortress:resume:${id}`);
            actors.delete(id);
            continue;
        }
        World.addNpcToGrid(npc);
        const fighting = npc.state.fetchCombats();
        if (fighting) {
            if (!record.wasCombat) {
                // Native combat has already retired the march; do not abort
                // the chase it may have started since the last scenario tick.
                record.generation++;
                record.moving = false;
                record.wasCombat = true;
            }
            continue;
        }
        if (record.wasCombat) {
            record.wasCombat = false;
            record.rejoin = true;
            record.retryAt = 0;
        }
        if (Number(npc.aggroEligibleAt || 0) <= now) {
            const current = loc(npc);
            const defender = defenders.filter(session => distance(current, loc(session.actor)) <= 1200
                && Math.abs(current.locZ - session.actor.fetchLocZ()) <= 400
                && npc.isValidAggroTarget(session.actor)
                && !NpcAggro.isSilentMoving(session.actor)
                && visiblePath(current, loc(session.actor)))
                .sort((a, b) => distance(current, loc(a.actor)) - distance(current, loc(b.actor)))[0];
            if (defender) {
                stopMove(record);
                if (npc.enterCombatState(defender, defender.actor)) { record.wasCombat = true; continue; }
            }
        }
        if (!Restrictions.canMove(npc)) { stopMove(record); continue; }
        if (record.moving && now - record.sample.at >= 5000) {
            if (distance(loc(npc), record.sample) < 8) {
                stopMove(record);
                record.rejoin = true;
                utils.infoWarn('Fortress', 'attacker %d stopped making route progress', id);
            }
            record.sample = { ...loc(npc), at: now };
        }
        if (record.rejoin) rejoin(record, now);
        else advance(record);
    }
    if (actors.size === 0 && ['released', 'failed'].includes(state)) {
        clearInterval(marchTimer);
        marchTimer = null;
    }
}

function release(plans) {
    if (stopped) return;
    const group = releasedGroups;
    try {
        for (const member of plans[group]) {
            let npc;
            try {
                npc = Spawn.spawnChildNpc(World, member.template, { ...member.spawn, head: 0 },
                    { fortressDefense: true, fortressGroup: group, fortressMember: member.member });
            } finally {
                // Notification can throw after native publication. Retain that
                // exact instance too; never retry it and create a sixth mob.
                npc ||= World.npc.spawns.find(candidate => candidate.fortressDefense
                    && candidate.fortressGroup === group && candidate.fortressMember === member.member);
                if (npc) {
                    actors.set(npc.fetchId(), { npc, path: member.path, cursor: 0, generation: 0,
                        moving: false, pending: false, wasCombat: false, rejoin: false, retryAt: 0, failures: 0 });
                    releasedMobs++;
                }
            }
            if (!npc) throw new Error('Native attacker publication failed');
            npc.setStateRun(true);
            transport.dataSendToMeAndOthers(Response.walkAndRun(npc.fetchId(), true), npc);
        }
        releasedGroups++;
        if (releasedGroups < Layout.GROUPS) releaseTimer = setTimeout(() => release(plans), Layout.INTERVAL_MS);
        else { releaseTimer = null; state = 'released'; }
    } catch (error) {
        state = 'failed';
        failedGroup = group + 1;
        clearTimeout(releaseTimer);
        releaseTimer = null;
        utils.infoWarn('Fortress', 'release failed at group %d after %d attackers: %s', failedGroup, releasedMobs, error.message);
    }
}

module.exports = {
    status: () => ({ state, releasedGroups, releasedMobs, failedGroup }),
    start() {
        if (state !== 'unused' || stopped) return Promise.resolve('The shared attack start has already been used or is unavailable.');
        state = 'preflight';
        const releaseAt = Date.now() + Layout.START_DELAY_MS;
        starting = (async () => {
            let plans;
            try {
                Doors.change(Layout.HALL_ID, true);
                plans = await preflight();
            } catch (error) { if (!stopped) state = 'unused'; throw error; }
            if (stopped) throw new Error('Server is shutting down');
            transport = new (invoke('GameServer/Bot/BotSession'))('fortress_march');
            state = 'countdown';
            // Path validation may outlast the exit delay, but must never let
            // the first group spawn before thirty seconds from the start click.
            const remaining = Math.max(0, releaseAt - Date.now());
            releaseTimer = setTimeout(() => {
                releaseTimer = null;
                if (stopped) return;
                state = 'releasing';
                marchTimer = setInterval(() => {
                    try { tick(); }
                    catch (error) { utils.infoWarn('Fortress', 'march update failed: %s', error.message); }
                }, 1000);
                marchTimer.unref?.();
                release(plans);
            }, remaining);
            return `The gates are open. First group in ${Math.ceil(remaining / 1000)} seconds. Fifteen groups arrive thirty seconds apart.`;
        })();
        return starting;
    },
    async stop() {
        stopped = true;
        clearTimeout(releaseTimer);
        clearInterval(marchTimer);
        releaseTimer = marchTimer = null;
        for (const key of pathKeys) Paths.cancel(key);
        if (starting) await starting.catch(error => utils.infoWarn('Fortress', 'attack shutdown: %s', error.message));
        const errors = [];
        for (const record of actors.values()) {
            try { stopMove(record); } catch (error) { errors.push(error); }
            try { record.npc.destructor(transport); } catch (error) { errors.push(error); }
        }
        actors.clear();
        if (errors.length) throw new AggregateError(errors, 'Attacker shutdown was incomplete');
    }
};
