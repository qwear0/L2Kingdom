const Geo = invoke('GameServer/Geodata/GeodataEngine');
const Surface = require('./SpawnSurface');
const DiskCache = require('./SpawnPlacementCache');

const POOL_SIZE = 128;
const SAMPLE_ATTEMPTS = 512;
const PATH_SEARCHES = 12;
const PATH_NODES = 20000;
const ANCHOR_RADIUS = 32768;
const pools = new Map();
const cursors = new WeakMap();
let trusted = [];
let trustedKeys = new Set();
let revision = -1;
let territories = [];
let warned = new Set();

function keyFor(bounds, anchors) {
    return JSON.stringify([bounds, anchors || []]);
}

function distanceSquared(a, b) {
    return (a.locX - b.locX) ** 2 + (a.locY - b.locY) ** 2 + (a.locZ - b.locZ) ** 2;
}

function nearest(points, target, limit) {
    return points.map(point => ({ point, distance: distanceSquared(point, target) }))
        .sort((a, b) => a.distance - b.distance).slice(0, limit).map(entry => entry.point);
}

function addTrusted(point) {
    const valid = Surface.supported(point);
    if (!valid) return;
    const key = `${valid.locX >> 4}:${valid.locY >> 4}:${valid.locZ}`;
    if (trustedKeys.has(key)) return;
    trustedKeys.add(key);
    trusted.push(valid);
}

function reset() {
    revision = Number(Geo.navigationRevision || 0);
    pools.clear();
    trusted = [];
    trustedKeys = new Set();
    warned = new Set();
    const gatekeepers = invoke('GameServer/World/C4GatekeeperTeleports');
    for (const [npcId, routes] of Object.entries(gatekeepers.lists)) {
        for (const [id] of routes) addTrusted(gatekeepers.destination(npcId, id));
    }
    for (const point of invoke('GameServer/World/C4CrumaTowerTeleports').DESTINATIONS.values()) addTrusted(point);
    for (const dungeon of invoke('GameServer/World/C4SevenSignsDungeonTeleports').DUNGEONS) {
        for (const side of ['inside', 'outside']) {
            const [locX, locY, locZ] = dungeon[side].destination;
            addTrusted({ locX, locY, locZ });
        }
    }
    for (const template of invoke('GameServer/DataCache').newbieSpawns) {
        for (const point of template.spawns) addTrusted(point);
    }
    // Explicit anchors are an authored access contract, not automatically
    // inferred from monster positions, polygon centres or the largest roof.
    for (const territory of territories) {
        for (const point of territory.spawnAnchors || []) addTrusted(point);
    }
}

function ensureRevision() {
    if (revision !== Number(Geo.navigationRevision || 0)) reset();
}

function inside(x, y, bounds) {
    let result = false;
    for (let i = 0, j = bounds.length - 1; i < bounds.length; j = i++) {
        const a = bounds[i], b = bounds[j];
        if ((a.locY > y) !== (b.locY > y)
            && x < (b.locX - a.locX) * (y - a.locY) / (b.locY - a.locY) + a.locX) result = !result;
    }
    return result;
}

function candidates(bounds) {
    if (!Array.isArray(bounds) || bounds.length < 3 || bounds.some(point =>
        ![point.locX, point.locY, point.minZ, point.maxZ].every(Number.isFinite))) return [];
    const minX = Math.min(...bounds.map(point => point.locX));
    const maxX = Math.max(...bounds.map(point => point.locX));
    const minY = Math.min(...bounds.map(point => point.locY));
    const maxY = Math.max(...bounds.map(point => point.locY));
    const minZ = Math.min(...bounds.map(point => point.minZ));
    const maxZ = Math.max(...bounds.map(point => point.maxZ));
    const points = [];
    const seen = new Set();
    // Bound rejection sampling too: a malformed or very thin polygon must
    // not trap startup in the old random-point helper's unbounded loop.
    for (let i = 0; i < SAMPLE_ATTEMPTS * 8 && seen.size < SAMPLE_ATTEMPTS; i++) {
        const locX = (((minX + Math.random() * (maxX - minX)) >> 4) << 4) + 8;
        const locY = (((minY + Math.random() * (maxY - minY)) >> 4) << 4) + 8;
        const key = `${locX}:${locY}`;
        if (seen.has(key) || !inside(locX, locY, bounds)) continue;
        seen.add(key);
        for (const layer of Surface.layers(locX, locY)) {
            if (!layer.nswe || layer.z < minZ || layer.z > maxZ) continue;
            points.push({ locX, locY, locZ: layer.z });
        }
    }
    return points;
}

function build(territory) {
    const points = candidates(territory.bounds);
    const accepted = [];
    let searches = 0;
    if (points.length) {
        const centre = {
            locX: territory.bounds.reduce((sum, p) => sum + p.locX, 0) / territory.bounds.length,
            locY: territory.bounds.reduce((sum, p) => sum + p.locY, 0) / territory.bounds.length,
            locZ: territory.bounds[0].minZ
        };
        const anchors = nearest(trusted.filter(point =>
            Math.hypot(point.locX - centre.locX, point.locY - centre.locY) <= ANCHOR_RADIUS), centre, 8);
        // Prove one entry into the territory first. Later points can reuse that
        // proof; no search starts from an unverified surface, even on retry.
        for (const anchor of anchors) {
            for (const point of nearest(points, anchor, 2)) {
                let connected = Surface.walk(anchor, point);
                if (!connected && searches < PATH_SEARCHES / 2) {
                    searches++;
                    connected = Surface.reachable(anchor, point, PATH_NODES);
                }
                if (connected) {
                    accepted.push(point);
                    break;
                }
            }
            if (accepted.length) break;
        }
        if (accepted.length) {
            const seen = new Set(accepted);
            // Two passes allow points behind an obstacle to connect through a
            // point admitted later. Keep all work here, never on an AI tick.
            for (let pass = 0; pass < 2 && accepted.length < POOL_SIZE; pass++) {
                for (const point of points) {
                    if (seen.has(point)) continue;
                    const neighbours = nearest(accepted, point, 4);
                    let valid = neighbours.some(anchor => Surface.walk(anchor, point));
                    if (!valid && searches < PATH_SEARCHES) {
                        searches++;
                        valid = Surface.reachable(neighbours[0], point, PATH_NODES);
                    }
                    if (!valid) continue;
                    accepted.push(point);
                    seen.add(point);
                    if (accepted.length >= POOL_SIZE) break;
                }
            }
            // Share only a few proven entries, not every point in every pool.
            // This lets adjacent territories connect without a new town route.
            for (let i = 0; i < accepted.length; i += 32) addTrusted(accepted[i]);
        }
    }
    const packed = new Int32Array(accepted.length * 3);
    accepted.forEach((point, index) => packed.set([point.locX, point.locY, point.locZ], index * 3));
    return packed;
}

function prepare(territory) {
    ensureRevision();
    const key = keyFor(territory.bounds, territory.spawnAnchors);
    if (!pools.has(key)) pools.set(key, build(territory));
    return pools.get(key);
}

function auditFixed(definitions) {
    const monsters = new Set(invoke('GameServer/DataCache').npcs
        .filter(npc => npc.template?.kind === 'Monster').map(npc => Number(npc.selfId)));
    const seen = new Set();
    const examples = [];
    let invalid = 0;
    for (const territory of definitions) {
        for (const spawn of territory.spawns) {
            if (!monsters.has(Number(spawn.selfId)) || spawn.total <= 0) continue;
            for (const point of spawn.coords) {
                const key = `${point.locX}:${point.locY}:${point.locZ}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const supported = Surface.supported(point);
                const exit = supported && [[16, 0], [-16, 0], [0, 16], [0, -16]].some(([dx, dy]) =>
                    Surface.walk(supported, { locX: supported.locX + dx, locY: supported.locY + dy }));
                if (exit) continue;
                invalid++;
                if (examples.length < 10) examples.push(`${territory.selfId}/${spawn.selfId}@${key}`);
            }
        }
    }
    if (invalid) utils.infoWarn('SpawnPlacement',
        '%d authored monster positions lack a supported surface or local exit; kept unchanged for content correction. Examples: %s',
        invalid, examples.join(', '));
}

function init(definitions, cacheOptions) {
    const startedAt = Date.now();
    territories = definitions.filter(item => item.spawns.some(spawn => !spawn.coords.length && spawn.total > 0));
    reset();
    const disk = DiskCache.open(territories.map(item => keyFor(item.bounds, item.spawnAnchors)), trusted, POOL_SIZE, cacheOptions);
    if (disk.cached) {
        for (const [key, points] of disk.cached.pools) pools.set(key, points);
        trusted = disk.cached.trusted;
        trustedKeys = new Set(trusted.map(point => `${point.locX >> 4}:${point.locY >> 4}:${point.locZ}`));
        utils.infoSuccess('SpawnPlacement', 'loaded disk cache for %d random territories', territories.length);
    } else {
        utils.infoSuccess('SpawnPlacement', 'preparing accessible points for %d random territories', territories.length);
        for (const [index, territory] of territories.entries()) {
            prepare(territory);
            if ((index + 1) % 128 === 0) utils.infoSuccess('SpawnPlacement', 'prepared %d/%d territories in %d seconds',
                index + 1, territories.length, Math.round((Date.now() - startedAt) / 1000));
        }
        utils.infoSuccess('SpawnPlacement', 'retrying territories without accessible points');
        // A later zone may supply an entry for an earlier one. Cache unresolved
        // zones too: repeated respawns must not repeat thousands of failed paths.
        for (const territory of territories) {
            const key = keyFor(territory.bounds, territory.spawnAnchors);
            if (!pools.get(key).length) pools.set(key, build(territory));
        }
        disk.save(pools, trusted);
    }
    const unavailable = territories.filter(territory => !prepare(territory).length);
    utils.infoSuccess('SpawnPlacement', '%d random territories prepared; %d awaiting accessible points; preparation took %d seconds',
        territories.length - unavailable.length, unavailable.length, Math.round((Date.now() - startedAt) / 1000));
    for (const territory of unavailable) warn(territory);
    auditFixed(definitions);
    return { cacheHit: !!disk.cached, territories: territories.length, unavailable: unavailable.length,
        points: [...pools.values()].reduce((total, points) => total + points.length / 3, 0), elapsedMs: Date.now() - startedAt };
}

function warn(territory) {
    const key = keyFor(territory.bounds, territory.spawnAnchors);
    if (warned.has(key)) return;
    warned.add(key);
    utils.infoWarn('SpawnPlacement', 'Territory %s has no proven accessible spawn points; spawns deferred. Check geodata/bounds or author spawnAnchors on a reachable floor.',
        territory.selfId || 'dynamic');
}

function randomCoords(definition) {
    const territory = {
        selfId: definition.territoryId,
        bounds: definition.bounds,
        spawnAnchors: definition.spawnAnchors
    };
    const points = prepare(territory);
    if (!points.length) {
        warn(territory);
        return null;
    }
    // Draw without replacement within a pool cycle, so initial population
    // does not unnecessarily stack several monsters on the same sampled cell.
    const cursor = cursors.get(points) || 0;
    const count = points.length / 3;
    const index = (cursor + Math.floor(Math.random() * (count - cursor))) * 3;
    const offset = cursor * 3;
    for (let axis = 0; axis < 3; axis++) {
        const value = points[offset + axis];
        points[offset + axis] = points[index + axis];
        points[index + axis] = value;
    }
    cursors.set(points, (cursor + 1) % count);
    return { locX: points[offset], locY: points[offset + 1], locZ: points[offset + 2] };
}

function nearLeader(leader) {
    const location = { locX: Number(leader.fetchLocX()), locY: Number(leader.fetchLocY()), locZ: Number(leader.fetchLocZ()) };
    if (![location.locX, location.locY, location.locZ].every(Number.isFinite)) return null;
    // Fixed spawns keep their authored Z, which may differ from geodata by
    // more than a movement step. Resolve the nearest layer before walking;
    // do not skip a blocked nearest layer to pick another dungeon floor.
    let surface = null;
    for (const layer of Surface.layers(location.locX, location.locY)) {
        if (!surface || Math.abs(layer.z - location.locZ) < Math.abs(surface.z - location.locZ)) surface = layer;
    }
    if (!surface?.nswe) return null;
    const origin = { ...location, locZ: surface.z };
    for (let i = 0; i < 16; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = i < 12 ? 80 + Math.random() * 220 : 16 * (i - 11);
        const point = Surface.walk(origin, {
            locX: Math.round(origin.locX + Math.cos(angle) * radius),
            locY: Math.round(origin.locY + Math.sin(angle) * radius)
        });
        if (point) return point;
    }
    // A tight room may have no offset with room to stand. The verified leader
    // surface is preferable to putting a group member through a wall or in air.
    return origin;
}

module.exports = { init, randomCoords, nearLeader };
