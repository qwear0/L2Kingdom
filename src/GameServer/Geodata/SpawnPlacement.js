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

// layers() deliberately conflates absent, malformed and obstacle-masked data.
// Do not turn that absence, or a failed bounded search, into an unreachable claim.
function supportFailure(point) {
    if (!point || ![point.locX, point.locY, point.locZ].every(Number.isFinite)) return 'invalid_coordinate';
    const layers = Surface.layers(point.locX, point.locY);
    if (!layers.length) return 'surface_unavailable';
    const closest = layers.reduce((a, b) => Math.abs(a.z - point.locZ) <= Math.abs(b.z - point.locZ) ? a : b);
    return !closest.nswe ? 'surface_blocked' : 'height_mismatch';
}

function addTrusted(point, source, roots) {
    const valid = Surface.supported(point);
    if (roots) roots.push({ source, authored: point, normalized: valid,
        included: true, reason: valid ? null : supportFailure(point) });
    if (!valid) return;
    const key = `${valid.locX >> 4}:${valid.locY >> 4}:${valid.locZ}`;
    if (trustedKeys.has(key)) return;
    trustedKeys.add(key);
    trusted.push(valid);
}

function reset(roots) {
    revision = Number(Geo.navigationRevision || 0);
    pools.clear();
    trusted = [];
    trustedKeys = new Set();
    warned = new Set();
    const gatekeepers = invoke('GameServer/World/C4GatekeeperTeleports');
    for (const [npcId, routes] of Object.entries(gatekeepers.lists)) {
        for (const [id] of routes) addTrusted(gatekeepers.destination(npcId, id), `gatekeeper:${npcId}:${id}`, roots);
    }
    for (const [id, point] of invoke('GameServer/World/C4CrumaTowerTeleports').DESTINATIONS) addTrusted(point, `cruma:${id}`, roots);
    for (const [index, dungeon] of invoke('GameServer/World/C4SevenSignsDungeonTeleports').DUNGEONS.entries()) {
        for (const side of ['inside', 'outside']) {
            const [locX, locY, locZ] = dungeon[side].destination;
            addTrusted({ locX, locY, locZ }, `seven-signs:${index}:${side}`, roots);
        }
    }
    for (const [index, template] of invoke('GameServer/DataCache').newbieSpawns.entries()) {
        for (const [i, point] of template.spawns.entries()) addTrusted(point, `player-start:${index}:${i}`, roots);
    }
    // Explicit anchors are an authored access contract, not automatically
    // inferred from monster positions, polygon centres or the largest roof.
    for (const [index, territory] of territories.entries()) {
        for (const [i, point] of (territory.spawnAnchors || []).entries()) addTrusted(point, `territory:${index}:${territory.selfId}:${i}`, roots);
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

function candidates(bounds, work) {
    if (!Array.isArray(bounds) || bounds.length < 3 || bounds.some(point =>
        ![point.locX, point.locY, point.minZ, point.maxZ].every(Number.isFinite))) {
        if (work) work.reason = 'invalid_bounds';
        return [];
    }
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
        if (work) work.xyDraws++;
        const locX = (((minX + Math.random() * (maxX - minX)) >> 4) << 4) + 8;
        const locY = (((minY + Math.random() * (maxY - minY)) >> 4) << 4) + 8;
        const key = `${locX}:${locY}`;
        if (seen.has(key) || !inside(locX, locY, bounds)) continue;
        seen.add(key);
        const layers = Surface.layers(locX, locY);
        if (work) {
            work.sampledCells++;
            work.decodedLayers += layers.length;
            if (!layers.length) work.surfaceUnavailableCells++;
        }
        for (const layer of layers) {
            if (work && !layer.nswe) work.blockedLayers++;
            if (work && (layer.z < minZ || layer.z > maxZ)) work.outOfRangeLayers++;
            if (!layer.nswe || layer.z < minZ || layer.z > maxZ) continue;
            if (work) work.candidateLayers++;
            points.push({ locX, locY, locZ: layer.z });
        }
    }
    return points;
}

function build(territory, attempts) {
    const work = attempts && { xyDraws: 0, sampledCells: 0, decodedLayers: 0,
        surfaceUnavailableCells: 0, blockedLayers: 0, outOfRangeLayers: 0,
        candidateLayers: 0, nearbyRoots: 0, directWalkCalls: 0, pathSearchRequests: 0, reason: null };
    const walk = (from, to) => {
        if (work) work.directWalkCalls++;
        return Surface.walk(from, to);
    };
    const points = candidates(territory.bounds, work);
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
        if (work) work.nearbyRoots = anchors.length;
        // Prove one entry into the territory first. Later points can reuse that
        // proof; no search starts from an unverified surface, even on retry.
        for (const anchor of anchors) {
            for (const point of nearest(points, anchor, 2)) {
                let connected = walk(anchor, point);
                if (!connected && searches < PATH_SEARCHES / 2) {
                    searches++;
                    if (work) work.pathSearchRequests++;
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
                    let valid = neighbours.some(anchor => walk(anchor, point));
                    if (!valid && searches < PATH_SEARCHES) {
                        searches++;
                        if (work) work.pathSearchRequests++;
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
    if (work) {
        work.reason ||= accepted.length ? null : !points.length ? 'sampling_miss_or_absence'
            : !work.nearbyRoots ? 'root_unavailable' : 'connectivity_unknown';
        work.pathNodeAllowance = work.pathSearchRequests * (PATH_NODES + 1);
        work.searchLimitReached = searches >= (accepted.length ? PATH_SEARCHES : PATH_SEARCHES / 2);
        attempts.push(work);
    }
    const packed = new Int32Array(accepted.length * 3);
    accepted.forEach((point, index) => packed.set([point.locX, point.locY, point.locZ], index * 3));
    return packed;
}

function prepare(territory, work) {
    ensureRevision();
    const key = keyFor(territory.bounds, territory.spawnAnchors);
    if (!pools.has(key)) {
        if (work && !work.has(key)) work.set(key, []);
        pools.set(key, build(territory, work?.get(key)));
    }
    return pools.get(key);
}

function auditFixed(definitions, detailed) {
    const monsters = new Set(invoke('GameServer/DataCache').npcs
        .filter(npc => npc.template?.kind === 'Monster').map(npc => Number(npc.selfId)));
    const seen = new Set();
    const examples = [];
    const records = detailed ? new Map() : null;
    const failures = {};
    const heightBuckets = { '65-128': 0, '129-256': 0, '257-512': 0, 'above-512': 0 };
    let invalid = 0, rows = 0, coordinateReferences = 0, declaredSlots = 0;
    for (const [definitionId, territory] of definitions.entries()) {
        for (const [row, spawn] of territory.spawns.entries()) {
            if (!monsters.has(Number(spawn.selfId)) || spawn.total <= 0 || !spawn.coords.length) continue;
            rows++;
            coordinateReferences += spawn.coords.length;
            declaredSlots += spawn.total * spawn.coords.length;
            for (const [coordinate, point] of spawn.coords.entries()) {
                const key = `${point.locX}:${point.locY}:${point.locZ}`;
                const reference = detailed && { definitionId, row, coordinate, npcId: spawn.selfId, slots: spawn.total };
                if (seen.has(key)) {
                    records?.get(key).references.push(reference);
                    continue;
                }
                seen.add(key);
                const supported = Surface.supported(point);
                const exit = supported && [[16, 0], [-16, 0], [0, 16], [0, -16]].some(([dx, dy]) =>
                    Surface.walk(supported, { locX: supported.locX + dx, locY: supported.locY + dy }));
                const reason = !detailed || exit ? null : supported ? 'local_exit_missing' : supportFailure(point);
                if (records) records.set(key, { authored: point, normalized: supported, local: reason || 'supported',
                    global: 'not_prepared', references: [reference] });
                if (exit) continue;
                if (detailed) failures[reason] = (failures[reason] || 0) + 1;
                if (reason === 'height_mismatch') {
                    const delta = Math.min(...Surface.layers(point.locX, point.locY).map(layer => Math.abs(layer.z - point.locZ)));
                    heightBuckets[delta <= 128 ? '65-128' : delta <= 256 ? '129-256' : delta <= 512 ? '257-512' : 'above-512']++;
                }
                invalid++;
                if (examples.length < 10) examples.push(`${territory.selfId}/${spawn.selfId}@${key}`);
            }
        }
    }
    if (invalid) utils.infoWarn('SpawnPlacement',
        '%d authored monster positions lack a supported surface or local exit; kept unchanged for content correction. Examples: %s',
        invalid, examples.join(', '));
    return { rows, coordinateReferences, declaredSlots, unique: seen.size, invalid, failures, heightBuckets, global: 'not_prepared',
        ...(records && { records: [...records.values()] }) };
}

// Detailed accounting is opt-in and never supplies new roots or relaxes admission.
// In particular, a nonempty pool is not an adequacy or global fixed-access proof.
function describe(definitions, roots, work, fixed) {
    const poolRecords = [...pools].map(([key, values], poolId) => {
        const cells = new Set(), floors = new Set();
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < values.length; i += 3) {
            const [x, y, z] = values.subarray(i, i + 3);
            cells.add(`${x >> 4}:${y >> 4}`);
            floors.add(z);
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        return { poolId, key, definitionIds: [], declaredSlots: 0, points: values.length / 3,
            uniqueCells: cells.size, floorZ: [...floors].sort((a, b) => a - b),
            extent: values.length ? { minX, maxX, minY, maxY } : null,
            attempts: work.get(key) || null };
    });
    const byKey = new Map(poolRecords.map(record => [record.key, record]));
    const randomIndices = new Map(territories.map((territory, index) => [territory, index]));
    const definitionRecords = definitions.map((territory, definitionId) => {
        const randomIndex = randomIndices.get(territory);
        const pool = randomIndex === undefined ? null : byKey.get(keyFor(territory.bounds, territory.spawnAnchors));
        const rows = territory.spawns.flatMap((spawn, row) => spawn.total > 0 ? [{ row, npcId: spawn.selfId,
            mode: spawn.coords.length ? 'fixed' : 'random', declaredSlots: spawn.total * (spawn.coords.length || 1) }] : []);
        if (pool) {
            pool.definitionIds.push(definitionId);
            pool.declaredSlots += rows.filter(row => row.mode === 'random').reduce((sum, row) => sum + row.declaredSlots, 0);
        } else {
            for (const [index, point] of (territory.spawnAnchors || []).entries()) {
                const normalized = Surface.supported(point);
                roots.push({ source: `fixed-only:${definitionId}:${territory.selfId}:${index}`, authored: point,
                    normalized, included: false, reason: 'fixed_only_root_excluded',
                    supportReason: normalized ? null : supportFailure(point) });
            }
        }
        return { definitionId, territoryId: territory.selfId, randomIndex: randomIndex ?? null, poolId: pool?.poolId ?? null, rows };
    });
    for (const pool of poolRecords) {
        const last = pool.attempts?.at(-1);
        pool.reason = pool.points ? null : last?.reason || 'cached_unresolved';
        pool.adequacy = { status: 'unreviewed', flags: [], intendedArea: null };
        if (!pool.points) pool.adequacy.flags.push('empty_pool');
        if (pool.uniqueCells === 1 && pool.declaredSlots > 1) pool.adequacy.flags.push('one_cell_multiple_slots');
        if (pool.points > 0 && pool.points < POOL_SIZE) pool.adequacy.flags.push('underfilled_pool');
        if (pool.adequacy.flags.length) pool.adequacy.status = 'review_required';
    }
    const counters = { xyDraws: 0, sampledCells: 0, decodedLayers: 0, candidateLayers: 0,
        directWalkCalls: 0, pathSearchRequests: 0, pathNodeAllowance: 0 };
    for (const attempts of work.values()) for (const attempt of attempts) {
        for (const key of Object.keys(counters)) counters[key] += attempt[key];
    }
    return { version: 1, definitions: definitionRecords, pools: poolRecords, roots, fixed,
        nonRandomDefinitions: definitionRecords.filter(record => record.randomIndex === null).length,
        fixedOnlyDefinitions: definitionRecords.filter(record => record.randomIndex === null && record.rows.some(row => row.mode === 'fixed')).length,
        fixedOnlyAnchorsExcluded: roots.filter(root => !root.included).length,
        work: { ...counters, scope: 'random_preparation_only',
            directWalkScope: 'build_calls_only_excludes_reachable_internal_walks',
            pathNodeAllowanceKind: 'upper_bound_not_measured_expansions',
            fixedConnectivitySearches: 0, fixedGlobalStatus: 'not_prepared' },
        enforcedLimits: { poolPoints: POOL_SIZE, sampledCellsPerAttempt: SAMPLE_ATTEMPTS,
            xyDrawsPerAttempt: SAMPLE_ATTEMPTS * 8, pathSearchesPerAttempt: PATH_SEARCHES,
            pathNodeParameter: PATH_NODES, pathExpansionUpperBoundPerCall: PATH_NODES + 1,
            globalWorkBudget: null, deterministicFallback: false, fixedProofCache: false } };
}

function init(definitions, cacheOptions = {}) {
    const startedAt = Date.now();
    const roots = cacheOptions.diagnostics ? [] : null;
    const work = cacheOptions.diagnostics ? new Map() : null;
    territories = definitions.filter(item => item.spawns.some(spawn => !spawn.coords.length && spawn.total > 0));
    reset(roots);
    const disk = DiskCache.open(territories.map(item => keyFor(item.bounds, item.spawnAnchors)), trusted, POOL_SIZE, cacheOptions);
    if (disk.cached) {
        for (const [key, points] of disk.cached.pools) pools.set(key, points);
        trusted = disk.cached.trusted;
        trustedKeys = new Set(trusted.map(point => `${point.locX >> 4}:${point.locY >> 4}:${point.locZ}`));
        utils.infoSuccess('SpawnPlacement', 'loaded disk cache for %d random territories', territories.length);
    } else {
        utils.infoSuccess('SpawnPlacement', 'preparing accessible points for %d random territories', territories.length);
        for (const [index, territory] of territories.entries()) {
            prepare(territory, work);
            if ((index + 1) % 128 === 0) utils.infoSuccess('SpawnPlacement', 'prepared %d/%d territories in %d seconds',
                index + 1, territories.length, Math.round((Date.now() - startedAt) / 1000));
        }
        utils.infoSuccess('SpawnPlacement', 'retrying territories without accessible points');
        // A later zone may supply an entry for an earlier one. Cache unresolved
        // zones too: repeated respawns must not repeat thousands of failed paths.
        for (const territory of territories) {
            const key = keyFor(territory.bounds, territory.spawnAnchors);
            if (!pools.get(key).length) pools.set(key, build(territory, work?.get(key)));
        }
        disk.save(pools, trusted);
    }
    const unavailable = territories.filter(territory => !prepare(territory).length);
    utils.infoSuccess('SpawnPlacement', '%d random territories prepared; %d awaiting accessible points; preparation took %d seconds',
        territories.length - unavailable.length, unavailable.length, Math.round((Date.now() - startedAt) / 1000));
    for (const territory of unavailable) warn(territory);
    const fixed = auditFixed(definitions, !!work);
    const diagnostics = work && describe(definitions, roots, work, fixed);
    return { cacheHit: !!disk.cached, territories: territories.length, unavailable: unavailable.length,
        points: [...pools.values()].reduce((total, points) => total + points.length / 3, 0), elapsedMs: Date.now() - startedAt,
        ...(diagnostics && { diagnostics }) };
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
