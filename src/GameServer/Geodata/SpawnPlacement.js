require('./JourneyGeometryIdentity.js').define(module, require, function (module, exports, require, __filename, __dirname) {
const { performance } = require('node:perf_hooks');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const Surface = require('./SpawnSurface');
const DiskCache = require('./SpawnPlacementCache');

const POOL_SIZE = 128;
const SAMPLE_ATTEMPTS = 512;
const DISCOVERY_TILES = 16;
const PATH_NODES = 20000;
const ANCHOR_RADIUS = 32768;
const BUCKET_SIZE = 8192;
const LIMITS = Object.freeze({ wallMs: 900000, targetMs: 90000, rssBytes: 3072 * 1024 * 1024,
    searches: 4096, nodeAllowance: 16000000, walks: 250000, transitions: 64000000,
    decodedLayers: 16000000, deterministicCells: 2000000, targetSearches: 24,
    targetNodeAllowance: 300000, targetWalks: 4096, targetTransitions: 1000000,
    targetLayers: 1000000, targetCells: 262144, callTransitions: 8192,
    fixedNodeAllowance: 16000000, batchCells: 4096, batchLayers: 65536, candidateWindow: 4096, fastSearches: 12 });
const CAPACITY = DiskCache.CAPACITY;
const pools = new Map();
const poolStates = new Map();
const cursors = new WeakMap();
const EMPTY = new Int32Array();
let revision = -1;
let preparationIdentity = null;
let warned = new Set();

const keyFor = (bounds, anchors) => JSON.stringify([bounds, anchors || []]);
const xyz = p => [p.locX, p.locY, p.locZ];
const pointKey = p => xyz(p).join(':');
const cellKey = p => `${p.locX >> 4}:${p.locY >> 4}:${p.locZ}`;
const distanceSquared = (a, b) => (a.locX - b.locX) ** 2 + (a.locY - b.locY) ** 2 + (a.locZ - b.locZ) ** 2;
const counters = () => ({ xyDraws: 0, sampledCells: 0, decodedLayers: 0, candidateLayers: 0,
    surfaceUnavailableCells: 0, blockedLayers: 0, outOfRangeLayers: 0,
    deterministicCells: 0, directWalkCalls: 0, strictWalkCalls: 0, localAuditWalkCalls: 0,
    walkTransitions: 0, pathSearchRequests: 0, pathNodeAllowance: 0, fixedPathNodeAllowance: 0,
    skippedPathSearchRequests: 0, directProofsAfterSearchLimit: 0, retentionSkippedCandidates: 0 });

class BudgetStop extends Error {
    constructor(limit, global = false) {
        super(`spawn preparation budget exhausted: ${limit}`);
        this.code = 'SPAWN_BUDGET';
        this.limit = limit;
        this.global = global;
    }
}

// Work quotas bound renewable startup windows, not the number of territories
// allowed to receive a first attempt. Renewal keeps every proof/cursor and
// per-target counter; wall time, RSS and required capacities remain hard stops.
// Optional fixed-pair history yields to random work before the shared pair cap.
// Counts include failed work; native expansions are reserved allowances.
class Budget {
    constructor() {
        this.started = performance.now();
        this.work = counters();
        this.window = counters();
        this.windows = 1;
        this.target = null;
        this.stopped = null;
        this.lastRss = -Infinity;
        this.maxRssBytes = 0;
        this.local = false;
        this.batchCells = 0; this.batchLayers = 0; this.batches = 0;
        this.maxBatchCells = 0; this.maxBatchLayers = 0;
    }
    checkpoint() {
        // Preparation is synchronous. A checkpoint retains the active scanner,
        // walk or route-validation cursor on the stack; it is not a failed proof.
        this.poll(true);
        this.maxBatchCells = Math.max(this.maxBatchCells, this.batchCells);
        this.maxBatchLayers = Math.max(this.maxBatchLayers, this.batchLayers);
        this.batchCells = 0; this.batchLayers = 0; this.batches++;
    }
    tested() {
        if (this.batchCells >= LIMITS.batchCells) this.checkpoint();
        this.batchCells++;
    }
    stop(limit, global = false) {
        if (global) this.stopped ||= limit;
        throw new BudgetStop(limit, global);
    }
    poll(force = false) {
        if (this.stopped) this.stop(this.stopped, true);
        const now = performance.now();
        if (now - this.started >= LIMITS.wallMs) this.stop('wallMs', true);
        if (this.target && this.target.activeMs + now - this.entered >= LIMITS.targetMs) this.stop('targetMs');
        if (force || now - this.lastRss >= 10) {
            this.lastRss = now;
            const rss = process.memoryUsage.rss();
            this.maxRssBytes = Math.max(this.maxRssBytes, rss);
            if (rss >= LIMITS.rssBytes) this.stop('rssBytes', true);
        }
    }
    enter(target, fn) {
        this.target = target;
        this.entered = performance.now();
        try { this.poll(true); return fn(); }
        finally { target.activeMs += performance.now() - this.entered; this.target = null; }
    }
    reserve(name, amount, windowLimit, targetLimit) {
        if (this.target && targetLimit && this.target.work[name] + amount > targetLimit) this.stop(`target:${name}`);
        if (amount > windowLimit) this.stop(name, true);
        if (this.work[name] - this.window[name] + amount > windowLimit) {
            this.checkpoint();
            this.window = { ...this.work };
            this.windows++;
            utils.infoSuccess('SpawnPlacement', 'continuing preparation in work window %d (%s quota)', this.windows, name);
        }
    }
    add(name, amount = 1) {
        this.work[name] += amount;
        if (this.target) this.target.work[name] += amount;
    }
    beforeLayers() {
        if (this.batchLayers + 255 > LIMITS.batchLayers) this.checkpoint();
        this.reserve('decodedLayers', 255, LIMITS.decodedLayers, LIMITS.targetLayers);
        if ((this.work.strictWalkCalls & 127) === 0) this.poll();
    }
    decoded(count) { this.add('decodedLayers', count); this.batchLayers += count; }
    walk() {
        this.reserve('strictWalkCalls', 1, LIMITS.walks, LIMITS.targetWalks);
        this.add('strictWalkCalls');
        if (this.local) this.add('localAuditWalkCalls');
        if ((this.work.strictWalkCalls & 127) === 0) this.poll();
    }
    transition(callCount) {
        if (callCount > LIMITS.callTransitions) this.stop('callTransitions');
        this.reserve('walkTransitions', 1, LIMITS.transitions, LIMITS.targetTransitions);
        this.add('walkTransitions');
        if ((this.work.walkTransitions & 127) === 0) this.poll();
    }
    search(nodes) {
        const target = this.target, fixed = target?.kind === 'fixed';
        const limit = target?.searchLimit
            || (fixed && this.work.fixedPathNodeAllowance + nodes > LIMITS.fixedNodeAllowance ? 'fixed:pathNodeAllowance'
                : target && target.work.pathSearchRequests >= LIMITS.targetSearches ? 'target:pathSearchRequests'
                    : target && target.work.pathNodeAllowance + nodes > LIMITS.targetNodeAllowance ? 'target:pathNodeAllowance' : null);
        // A* exhaustion disables that operation, not the target. Later strict
        // direct witnesses may still prove it within the unchanged walk/time limits.
        if (limit) {
            if (target) target.searchLimit = limit;
            this.add('skippedPathSearchRequests');
            return false;
        }
        this.poll(true);
        this.reserve('pathSearchRequests', 1, LIMITS.searches, LIMITS.targetSearches);
        this.reserve('pathNodeAllowance', nodes, LIMITS.nodeAllowance, LIMITS.targetNodeAllowance);
        this.add('pathSearchRequests');
        this.add('pathNodeAllowance', nodes);
        if (fixed) this.add('fixedPathNodeAllowance', nodes);
        return true;
    }
    scan() {
        this.tested();
        this.reserve('deterministicCells', 1, LIMITS.deterministicCells, LIMITS.targetCells);
        this.add('deterministicCells');
    }
    capacity(name, size) {
        if (size > CAPACITY[name]) this.stop(`capacity:${name}`, true);
        if ((size & 127) === 0) this.poll();
    }
}

function nearest(points, target, limit) {
    // Bounded insertion avoids sorting the global trusted set per target.
    const best = [];
    for (const point of points) {
        const distance = distanceSquared(point.point || point, target);
        let i = 0;
        while (i < best.length && best[i].distance <= distance) i++;
        if (i >= limit) continue;
        best.splice(i, 0, { point, distance });
        if (best.length > limit) best.pop();
    }
    return best.map(entry => entry.point);
}

function supportInfo(point, budget) {
    if (!point || !xyz(point).every(value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)) {
        return { normalized: null, reason: 'invalid_coordinate' };
    }
    const layers = Surface.layers(point.locX, point.locY, budget);
    if (!layers.length) return { normalized: null, reason: 'surface_unavailable' };
    let closest = layers[0];
    for (const layer of layers) if (Math.abs(layer.z - point.locZ) < Math.abs(closest.z - point.locZ)) closest = layer;
    const delta = Math.abs(closest.z - point.locZ);
    const reason = !closest.nswe ? 'surface_blocked' : delta > 64 ? 'height_mismatch' : null;
    return { normalized: reason ? null : { locX: point.locX, locY: point.locY, locZ: closest.z }, reason, delta };
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

function domain(bounds) {
    if (!Array.isArray(bounds) || bounds.length < 3 || bounds.some(point =>
        ![point.locX, point.locY, point.minZ, point.maxZ].every(Number.isFinite))) return null;
    const d = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const p of bounds) {
        d.minX = Math.min(d.minX, p.locX); d.maxX = Math.max(d.maxX, p.locX);
        d.minY = Math.min(d.minY, p.locY); d.maxY = Math.max(d.maxY, p.locY);
        d.minZ = Math.min(d.minZ, p.minZ); d.maxZ = Math.max(d.maxZ, p.maxZ);
    }
    d.x0 = Math.ceil((d.minX - 8) / 16); d.x1 = Math.floor((d.maxX - 8) / 16);
    d.y0 = Math.ceil((d.minY - 8) / 16); d.y1 = Math.floor((d.maxY - 8) / 16);
    return d;
}

function inventory(definitions, budget) {
    budget.capacity('definitions', definitions.length);
    const monsters = new Set(invoke('GameServer/DataCache').npcs.filter(npc => npc.template?.kind === 'Monster').map(npc => Number(npc.selfId)));
    const byKey = new Map(), fixedByKey = new Map(), fixed = [], references = [], definitionRecords = [];
    let randomIndex = 0, rows = 0, slots = 0;
    for (const [definitionId, territory] of definitions.entries()) {
        budget.poll();
        const positive = [];
        let randomSlots = 0;
        for (const [row, spawn] of territory.spawns.entries()) {
            if (spawn.total <= 0) continue;
            positive.push({ row, npcId: spawn.selfId, mode: spawn.coords.length ? 'fixed' : 'random',
                declaredSlots: spawn.total * (spawn.coords.length || 1) });
            if (!spawn.coords.length) randomSlots += spawn.total;
            if (!spawn.coords.length || !monsters.has(Number(spawn.selfId))) continue;
            rows++; slots += spawn.total * spawn.coords.length;
            for (const [coordinate, p] of spawn.coords.entries()) {
                budget.capacity('references', references.length + 1);
                const key = pointKey(p);
                let record = fixedByKey.get(key);
                if (!record) {
                    budget.capacity('fixed', fixed.length + 1);
                    record = { id: fixed.length, authored: { locX: p.locX, locY: p.locY, locZ: p.locZ }, references: [],
                        local: 'budget_exhausted', normalized: null, global: 'unknown', witness: null, reason: 'budget_exhausted' };
                    fixedByKey.set(key, record); fixed.push(record);
                }
                record.references.push({ definitionId, row, coordinate, npcId: spawn.selfId, slots: spawn.total });
                references.push([record.id, definitionId, row, coordinate, spawn.total]);
            }
        }
        let target = null;
        if (randomSlots) {
            const key = keyFor(territory.bounds, territory.spawnAnchors);
            target = byKey.get(key);
            if (!target) {
                budget.capacity('pools', byKey.size + 1);
                target = { id: byKey.size, kind: 'random', key, territory, domain: domain(territory.bounds), slots: 0, definitionIds: [],
                    points: [], acceptedKeys: new Set(), admissions: 0, work: counters(), activeMs: 0, attempts: [],
                    reason: null, complete: false, scanned: 0, eligible: 0, unavailableCells: 0, cursor: 0,
                    discoveryVersion: 0, proofVersion: 0, scanVersion: 0, retryScan: false, stopped: false };
                byKey.set(key, target);
            }
            target.slots += randomSlots; target.definitionIds.push(definitionId);
        }
        definitionRecords.push({ definitionId, territoryId: territory.selfId, randomIndex: target ? randomIndex++ : null,
            poolId: target?.id ?? null, rows: positive });
    }
    return { targets: [...byKey.values()], fixed, references, definitionRecords, rows, slots,
        expected: { keys: [...byKey.keys()], fixed: fixed.map(record => xyz(record.authored)), references,
            definitions: definitions.map((t, i) => [i, t.selfId]),
            signature: [definitions, [...monsters].sort((a, b) => a - b)] } };
}

class Proofs {
    constructor(budget) {
        this.budget = budget;
        this.trusted = [];
        this.trustedKeys = new Map();
        this.shared = new Set();
        this.sources = new Map();
        this.targets = new Map();
        this.memberships = 0;
        this.queue = [];
        this.pairs = { random: new Map(), fixed: new Map() };
        this.pairCounts = { random: 0, fixed: 0 };
        this.pairAdmissions = { random: 0, fixed: 0 };
        this.peakPairs = 0;
        this.fixedPairsLimited = false;
        this.roots = [];
    }
    buckets(d, radius, visit) {
        for (let x = Math.floor((d.minX - radius) / BUCKET_SIZE); x <= Math.floor((d.maxX + radius) / BUCKET_SIZE); x++) {
            for (let y = Math.floor((d.minY - radius) / BUCKET_SIZE); y <= Math.floor((d.maxY + radius) / BUCKET_SIZE); y++) visit(`${x}:${y}`);
        }
    }
    membership(index, key, value) {
        this.budget.capacity('memberships', this.memberships + 1);
        let entries = index.get(key);
        if (!entries) index.set(key, entries = []);
        entries.push(value); this.memberships++;
    }
    register(target) {
        if (!target.domain) return;
        this.buckets(target.domain, 0, key => this.membership(this.targets, key, target));
    }
    relevant(point, d) {
        const dx = Math.max(d.minX - point.locX, 0, point.locX - d.maxX);
        const dy = Math.max(d.minY - point.locY, 0, point.locY - d.maxY);
        return dx * dx + dy * dy <= ANCHOR_RADIUS ** 2;
    }
    settled(target) {
        return target.stopped || (target.kind === 'fixed' ? target.proven
            : adequate(target).accepted || (target.complete && !target.eligible));
    }
    enqueue(target) {
        if (target.pending || this.settled(target)) return;
        target.pending = true;
        this.queue.push(target);
    }
    release(target) {
        // Only terminal targets can forget failures: an unresolved target may
        // wake on a new witness and must not retry unchanged source/point pairs.
        if (!this.settled(target)) return;
        const pairs = this.pairs[target.kind].get(target);
        if (!pairs) return;
        this.pairCounts[target.kind] -= pairs.size;
        this.pairs[target.kind].delete(target);
    }
    limitFixedPairs() {
        // Fixed global proofs are diagnostic. Once their memo budget is spent
        // or random work needs the space, stop that work before dropping history.
        // Clearing an active retry history without this fence would repeat failures.
        this.fixedPairsLimited = true;
        this.pairs.fixed.clear();
        this.pairCounts.fixed = 0;
    }
    rememberPair(target, key) {
        const kind = target.kind;
        let pairs = this.pairs[kind].get(target);
        if (pairs?.has(key)) return false;
        if (kind === 'fixed' && (this.fixedPairsLimited || this.pairAdmissions.fixed >= CAPACITY.pairs)) {
            this.limitFixedPairs();
            this.budget.stop('fixed:capacity:pairs');
        }
        if (this.pairCounts.random + this.pairCounts.fixed >= CAPACITY.pairs) {
            if (kind === 'fixed') {
                this.limitFixedPairs();
                this.budget.stop('fixed:capacity:pairs');
            }
            if (this.pairCounts.fixed) this.limitFixedPairs();
        }
        this.budget.capacity('pairs', this.pairCounts.random + this.pairCounts.fixed + 1);
        if (!pairs) this.pairs[kind].set(target, pairs = new Set());
        pairs.add(key);
        this.pairCounts[kind]++;
        this.pairAdmissions[kind]++;
        this.peakPairs = Math.max(this.peakPairs, this.pairCounts.random + this.pairCounts.fixed);
        return true;
    }
    add(point) {
        const key = cellKey(point);
        if (this.trustedKeys.has(key)) return this.trustedKeys.get(key);
        this.budget.capacity('trusted', this.trusted.length + 1);
        const index = this.trusted.length;
        const bucket = `${Math.floor(point.locX / BUCKET_SIZE)}:${Math.floor(point.locY / BUCKET_SIZE)}`;
        this.membership(this.sources, bucket, index);
        this.trusted.push(point); this.trustedKeys.set(key, index);
        const seen = new Set();
        this.buckets({ minX: point.locX, maxX: point.locX, minY: point.locY, maxY: point.locY }, ANCHOR_RADIUS, bucketKey => {
            for (const target of this.targets.get(bucketKey) || []) {
                if (seen.has(target.id) || !this.relevant(point, target.domain)) continue;
                seen.add(target.id);
                if (this.settled(target)) continue;
                target.proofVersion++;
                if (target.complete) target.retryScan = true;
                this.enqueue(target);
            }
        });
        return index;
    }
    share(point) {
        // Bands select supplemental witnesses only; every retained witness keeps
        // its exact Z and every connection still needs a strict layer-aware proof.
        const key = `${Math.floor(point.locX / BUCKET_SIZE)}:${Math.floor(point.locY / BUCKET_SIZE)}:${Math.floor(point.locZ / 64)}`;
        if (this.shared.has(key)) return;
        this.add(point);
        this.shared.add(key);
    }
    nearby(target, point, limit = 8, candidates) {
        const found = [], pairs = this.pairs[target.kind].get(target);
        this.buckets(target.domain, ANCHOR_RADIUS, key => {
            for (const index of this.sources.get(key) || []) {
                const source = this.trusted[index];
                if (!this.relevant(source, target.domain)) continue;
                const choices = candidates ? nearest(candidates, source, 2) : [target.point];
                if (!choices.some(p => !pairs?.has(`${index}/${cellKey(p)}`))) continue;
                found.push({ index, point: source });
            }
        });
        return nearest(found, point, limit);
    }
    pair(target, source, point) {
        return this.rememberPair(target, `${source}/${cellKey(point)}`);
    }
    failed(target, source, point, kind, remember = false) {
        const key = `${kind}/${cellKey(source)}/${cellKey(point)}`;
        if (this.pairs[target.kind].get(target)?.has(key)) return true;
        if (remember) this.rememberPair(target, key);
        return false;
    }
    root(point, source) {
        const info = supportInfo(point, this.budget);
        this.roots.push({ source, authored: point, normalized: info.normalized, included: true, reason: info.reason });
        if (info.normalized) this.add(info.normalized);
    }
    collect(definitions) {
        const gatekeepers = invoke('GameServer/World/C4GatekeeperTeleports');
        for (const [npcId, routes] of Object.entries(gatekeepers.lists)) {
            for (const [id] of routes) this.root(gatekeepers.destination(npcId, id), `gatekeeper:${npcId}:${id}`);
        }
        for (const [id, point] of invoke('GameServer/World/C4CrumaTowerTeleports').DESTINATIONS) this.root(point, `cruma:${id}`);
        for (const [index, dungeon] of invoke('GameServer/World/C4SevenSignsDungeonTeleports').DUNGEONS.entries()) {
            for (const side of ['inside', 'outside']) {
                const [locX, locY, locZ] = dungeon[side].destination;
                this.root({ locX, locY, locZ }, `seven-signs:${index}:${side}`);
            }
        }
        for (const [index, template] of invoke('GameServer/DataCache').newbieSpawns.entries()) {
            for (const [i, point] of template.spawns.entries()) this.root(point, `player-start:${index}:${i}`);
        }
        // Collect from the complete inventory, including fixed-only/inactive
        // definitions. Monster positions themselves never establish an entrance.
        for (const [definitionId, territory] of definitions.entries()) {
            for (const [i, point] of (territory.spawnAnchors || []).entries()) this.root(point, `territory:${definitionId}:${territory.selfId}:${i}`);
        }
    }
}

function extent(points) {
    const cells = new Set(), z = new Set();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
        cells.add(`${p.locX >> 4}:${p.locY >> 4}`); z.add(p.locZ);
        minX = Math.min(minX, p.locX); maxX = Math.max(maxX, p.locX);
        minY = Math.min(minY, p.locY); maxY = Math.max(maxY, p.locY);
    }
    return { uniqueCells: cells.size, floorZ: [...z].sort((a, b) => a - b),
        extent: points.length ? { minX, maxX, minY, maxY } : null };
}

function adequate(target) {
    const blocked = target.reason === 'budget_exhausted';
    const cached = target.adequacyCache;
    if (cached && cached.points === target.points && cached.version === target.admissions && cached.blocked === blocked) return cached.value;
    const summary = extent(target.points);
    const demand = Math.min(POOL_SIZE, target.slots);
    const spans = !summary.extent || !target.domain ? [false, false] : [
        target.domain.maxX - target.domain.minX < 256 || summary.extent.maxX - summary.extent.minX >= (target.domain.maxX - target.domain.minX) * 0.25,
        target.domain.maxY - target.domain.minY < 256 || summary.extent.maxY - summary.extent.minY >= (target.domain.maxY - target.domain.minY) * 0.25];
    const flags = [];
    if (blocked) flags.push('budget_exhausted');
    if (!target.points.length) flags.push('empty_pool');
    if (summary.uniqueCells < demand) flags.push('insufficient_unique_cells');
    if (target.slots > 1 && summary.uniqueCells === 1) flags.push('one_cell_multiple_slots');
    if (!spans.every(Boolean)) flags.push('insufficient_extent');
    const value = { ...summary, demand, accepted: flags.length === 0, status: flags.length ? 'review_required' : 'accepted', flags, intendedArea: null };
    target.adequacyCache = { points: target.points, version: target.admissions, blocked, value };
    return value;
}

function discoverCell(target, locX, locY, budget, points, seen) {
    if (!inside(locX, locY, target.territory.bounds)) return;
    const layers = Surface.layers(locX, locY, budget);
    budget.add('sampledCells');
    if (!layers.length) { budget.add('surfaceUnavailableCells'); target.unavailableCells++; }
    for (const layer of layers) {
        if (!layer.nswe) budget.add('blockedLayers');
        if (layer.z < target.domain.minZ || layer.z > target.domain.maxZ) budget.add('outOfRangeLayers');
        if (!layer.nswe || layer.z < target.domain.minZ || layer.z > target.domain.maxZ) continue;
        budget.add('candidateLayers'); target.eligible++;
        const p = { locX, locY, locZ: layer.z }, key = cellKey(p);
        if (seen.has(key) || target.acceptedKeys.has(key)) continue;
        seen.add(key); points.push(p);
    }
}

function fastCandidates(target, budget) {
    const points = [], seen = new Set(), cells = new Set(), d = target.domain;
    for (let i = 0; i < SAMPLE_ATTEMPTS * 8 && cells.size < SAMPLE_ATTEMPTS; i++) {
        budget.add('xyDraws');
        const x = (((d.minX + Math.random() * (d.maxX - d.minX)) >> 4) << 4) + 8;
        const y = (((d.minY + Math.random() * (d.maxY - d.minY)) >> 4) << 4) + 8;
        const key = `${x}:${y}`;
        if (cells.has(key) || !inside(x, y, target.territory.bounds)) continue;
        cells.add(key); budget.tested(); discoverCell(target, x, y, budget, points, seen);
        if (points.length >= LIMITS.candidateWindow - 255) break;
    }
    return points;
}

function fallbackCandidates(target, budget, proofs) {
    const points = [], seen = new Set(), d = target.domain;
    const width = Math.max(0, d.x1 - d.x0 + 1), height = Math.max(0, d.y1 - d.y0 + 1);
    if (!width || !height) { target.complete = true; return points; }
    const columns = Math.min(DISCOVERY_TILES, width), rows = Math.min(DISCOVERY_TILES, height);
    const tileWidth = Math.ceil(width / columns), tileHeight = Math.ceil(height / rows);
    const tiles = columns * rows, total = tileWidth * tileHeight * tiles;
    if (!Number.isSafeInteger(total)) budget.stop('target:boundingBox');
    const startedLayers = budget.work.decodedLayers;
    if (!target.cursor) target.scanVersion = target.proofVersion;
    let batch = 0;
    // Interleave tiles across both axes before advancing inside each tile. Every
    // real bounding-box cell occurs once per pass; ragged padding is not decoded.
    while (target.cursor < total && batch < LIMITS.batchCells && points.length <= LIMITS.candidateWindow - 255
        && budget.work.decodedLayers - startedLayers <= LIMITS.batchLayers - 255) {
        const index = target.cursor++, tile = index % tiles, local = Math.floor(index / tiles);
        const tileX = tile % columns, tileY = (Math.floor(tile / columns) + tileX) % rows;
        const x = d.x0 + tileX * tileWidth + Math.floor(local / tileHeight);
        const y = d.y0 + tileY * tileHeight + local % tileHeight;
        batch++;
        if (x > d.x1 || y > d.y1) continue;
        budget.scan(); target.scanned++;
        discoverCell(target, x * 16 + 8, y * 16 + 8, budget, points, seen);
    }
    budget.poll(true);
    if (target.cursor >= total) {
        target.complete = true;
        // Only a newly admitted relevant proof may cause a targeted revisit.
        // The source/candidate pair set still forbids repeating old failures.
        if (target.scanVersion < target.proofVersion) target.retryScan = true;
    } else proofs.enqueue(target);
    target.discoveryVersion++;
    return points;
}

function directConnection(from, to, target, budget) {
    budget.add('directWalkCalls');
    const connected = Surface.walk(from, to, budget);
    if (connected && target.searchLimit) budget.add('directProofsAfterSearchLimit');
    return connected;
}

function connect(from, to, target, budget, initial) {
    const maxSearches = initial ? LIMITS.fastSearches : LIMITS.targetSearches;
    if (target.work.pathSearchRequests >= maxSearches) return false;
    return Surface.reachable(from, to, PATH_NODES, budget, true);
}

// Prune before connectivity work only when a full-pool candidate cannot improve
// XY demand or a deficient span. Replacements must preserve every existing extreme;
// each admission invalidates this transient retention summary.
function retentionIndex(target, point) {
    if (target.acceptedKeys.has(cellKey(point))) return -1;
    if (target.points.length < POOL_SIZE) return target.points.length;
    const summary = adequate(target), box = summary.extent, cache = target.adequacyCache;
    if (!cache.retention) {
        const cells = new Map(), extremes = [0, 0, 0, 0];
        for (const p of target.points) {
            const xy = `${p.locX >> 4}:${p.locY >> 4}`;
            cells.set(xy, (cells.get(xy) || 0) + 1);
            if (p.locX === box.minX) extremes[0]++;
            if (p.locX === box.maxX) extremes[1]++;
            if (p.locY === box.minY) extremes[2]++;
            if (p.locY === box.maxY) extremes[3]++;
        }
        let index = summary.uniqueCells < summary.demand
            ? target.points.findIndex(p => cells.get(`${p.locX >> 4}:${p.locY >> 4}`) > 1) : -1;
        const needsCells = index >= 0;
        if (index < 0) index = target.points.findIndex(p => (p.locX !== box.minX || extremes[0] > 1)
            && (p.locX !== box.maxX || extremes[1] > 1) && (p.locY !== box.minY || extremes[2] > 1)
            && (p.locY !== box.maxY || extremes[3] > 1));
        cache.retention = { cells, index, needsCells };
    }
    const { cells, index, needsCells } = cache.retention;
    if (cells.has(`${point.locX >> 4}:${point.locY >> 4}`)) return -1;
    const width = target.domain.maxX - target.domain.minX, height = target.domain.maxY - target.domain.minY;
    const extendsX = width >= 256 && box.maxX - box.minX < width * 0.25 && (point.locX < box.minX || point.locX > box.maxX);
    const extendsY = height >= 256 && box.maxY - box.minY < height * 0.25 && (point.locY < box.minY || point.locY > box.maxY);
    return needsCells || extendsX || extendsY ? index : -1;
}

function accept(target, point, proofs) {
    const index = retentionIndex(target, point);
    if (index < 0) return;
    if (index < target.points.length) target.acceptedKeys.delete(cellKey(target.points[index]));
    target.points[index] = point;
    target.acceptedKeys.add(cellKey(point)); target.admissions++;
    proofs.share(point);
}

function fillPool(target, points, budget, proofs, initial) {
    if (!points.length) return;
    if (!target.points.length || (!initial && !adequate(target).accepted)) {
        const centre = { locX: (target.domain.minX + target.domain.maxX) / 2,
            locY: (target.domain.minY + target.domain.maxY) / 2, locZ: target.domain.minZ };
        const sources = proofs.nearby(target, centre, 8, points);
        target.nearbyRoots = Math.max(target.nearbyRoots || 0, sources.length);
        const pending = [];
        let entered = false;
        for (const source of sources) {
            for (const point of nearest(points, source.point, 2)) {
                if (retentionIndex(target, point) < 0 || !proofs.pair(target, source.index, point)) continue;
                if (directConnection(source.point, point, target, budget)) {
                    accept(target, point, proofs); entered = true; break;
                }
                pending.push({ source, point });
            }
            if (entered) break;
        }
        // Try the selected direct witnesses before spending entry A* allowance.
        for (const { source, point } of pending) {
            if (entered || (initial && target.work.pathSearchRequests >= LIMITS.fastSearches / 2)) break;
            if (connect(source.point, point, target, budget, initial)) {
                accept(target, point, proofs); entered = true;
            }
        }
    }
    if (!target.points.length) return;
    const lastProof = new Map();
    for (let pass = 0; pass < 2 && (target.points.length < POOL_SIZE || !adequate(target).accepted); pass++) {
        for (const point of points) {
            const key = cellKey(point);
            if (target.acceptedKeys.has(key) || lastProof.get(key) === target.admissions) continue;
            if (retentionIndex(target, point) < 0) { budget.add('retentionSkippedCandidates'); continue; }
            const neighbours = nearest(target.points, point, 4);
            let connected = false;
            for (const source of neighbours) {
                if (proofs.failed(target, source, point, 'walk')) continue;
                if (directConnection(source, point, target, budget)) { connected = true; break; }
                proofs.failed(target, source, point, 'walk', true);
            }
            const source = neighbours[0];
            if (!connected && !proofs.failed(target, source, point, 'path')) {
                const before = target.work.pathSearchRequests;
                connected = connect(source, point, target, budget, initial);
                if (!connected && target.work.pathSearchRequests > before) proofs.failed(target, source, point, 'path', true);
            }
            if (connected) accept(target, point, proofs);
            else lastProof.set(key, target.admissions);
            if (target.points.length >= POOL_SIZE && adequate(target).accepted) break;
        }
    }
}

function poolAttempt(target, initial, budget, proofs) {
    const before = { ...target.work };
    try {
        budget.enter(target, () => {
            if (!target.domain) { target.reason = 'invalid_bounds'; target.stopped = true; return; }
            if (!initial && target.complete) {
                if (!target.retryScan) return;
                target.retryScan = false; target.complete = false; target.cursor = 0;
            }
            const points = initial ? fastCandidates(target, budget) : fallbackCandidates(target, budget, proofs);
            fillPool(target, points, budget, proofs, initial);
            const adequacy = adequate(target);
            target.reason = adequacy.accepted ? null : target.points.length ? 'inadequate_pool'
                : target.complete && !target.eligible ? (target.unavailableCells ? 'surface_unavailable' : 'no_layer_in_z_interval')
                    : !target.eligible ? 'sampling_miss_or_absence'
                        : !target.nearbyRoots ? 'root_unavailable' : 'connectivity_unknown';
            if (!initial && target.retryScan) proofs.enqueue(target);
        });
    } catch (error) {
        if (error.code !== 'SPAWN_BUDGET') throw error;
        // Optional extra discovery/sharing cannot revoke already sufficient
        // strict points. A hard global stop still blocks publication/startup.
        target.reason = adequate(target).accepted ? null : 'budget_exhausted';
        target.limit = error.limit; target.stopped = true;
    }
    target.attempts.push({ phase: initial ? 'fast' : 'deterministic', ...Object.fromEntries(Object.keys(before)
        .map(key => [key, target.work[key] - before[key]])), reason: target.reason, limit: target.limit || null });
}

function auditFixed(inv, budget) {
    const groups = new Map();
    for (const record of inv.fixed) {
        try {
            budget.poll();
            const info = supportInfo(record.authored, budget);
            record.normalized = info.normalized; record.delta = info.delta;
            let exit = false;
            if (info.normalized) {
                budget.local = true;
                try {
                    exit = [[16, 0], [-16, 0], [0, 16], [0, -16]].some(([dx, dy]) => Surface.walk(info.normalized,
                        { locX: info.normalized.locX + dx, locY: info.normalized.locY + dy }, budget));
                } finally { budget.local = false; }
            }
            record.local = info.reason || (exit ? 'supported' : 'local_exit_missing');
            record.global = record.local === 'supported' ? 'unknown' : 'invalid';
            record.reason = record.local === 'supported' ? 'connectivity_unknown' : record.local;
            record.witness = null;
            if (record.local !== 'supported') continue;
            const key = cellKey(record.normalized);
            let target = groups.get(key);
            if (!target) {
                const p = record.normalized;
                target = { id: inv.targets.length + groups.size, kind: 'fixed', point: p, records: [], work: counters(), activeMs: 0,
                    domain: { minX: p.locX, maxX: p.locX, minY: p.locY, maxY: p.locY }, proofVersion: 0, stopped: false };
                groups.set(key, target);
            }
            target.records.push(record);
        } catch (error) {
            if (error.code !== 'SPAWN_BUDGET') throw error;
            record.local = 'budget_exhausted'; record.global = 'unknown'; record.reason = 'budget_exhausted';
            record.witness = null; record.normalized ||= null; record.limit = error.limit;
        }
    }
    return [...groups.values()];
}

function proveFixed(target, budget, proofs) {
    try {
        budget.enter(target, () => {
            if (proofs.fixedPairsLimited) budget.stop('fixed:capacity:pairs');
            const sources = proofs.nearby(target, target.point);
            target.nearbyRoots = Math.max(target.nearbyRoots || 0, sources.length);
            const pending = [];
            let witness = null;
            for (const source of sources) {
                if (!proofs.pair(target, source.index, target.point)) continue;
                if (directConnection(source.point, target.point, target, budget)) { witness = source; break; }
                pending.push(source);
            }
            if (!witness) witness = pending.find(source => connect(source.point, target.point, target, budget, false));
            if (witness) {
                target.proven = true;
                for (const record of target.records) {
                    record.global = 'proven'; record.reason = null; record.witness = witness.index; record.limit = null;
                }
                proofs.share(target.point);
                return;
            }
            for (const record of target.records) {
                record.reason = target.searchLimit ? 'budget_exhausted' : target.nearbyRoots ? 'connectivity_unknown' : 'root_unavailable';
                if (target.searchLimit) record.limit = target.searchLimit;
            }
        });
    } catch (error) {
        if (error.code !== 'SPAWN_BUDGET') throw error;
        target.stopped = true;
        for (const record of target.records) {
            // A completed proof survives a subsequent capacity stop while
            // sharing it; only unfinished proof work is unknown.
            if (record.global === 'proven') continue;
            record.reason = 'budget_exhausted'; record.limit = error.limit;
        }
    }
}

function fixedSummary(inv, detailed) {
    const failures = {}, reasons = {}, heightBuckets = { '65-128': 0, '129-256': 0, '257-512': 0, 'above-512': 0 };
    let invalid = 0, proven = 0, unknown = 0, localUnknown = 0;
    for (const record of inv.fixed) {
        if (record.local === 'budget_exhausted') localUnknown++;
        else if (record.local !== 'supported') { invalid++; failures[record.local] = (failures[record.local] || 0) + 1; }
        if (record.global === 'proven') proven++;
        else if (record.global === 'unknown') unknown++;
        if (record.reason) reasons[record.reason] = (reasons[record.reason] || 0) + 1;
        if (record.local === 'height_mismatch') {
            const delta = record.delta;
            heightBuckets[delta <= 128 ? '65-128' : delta <= 256 ? '129-256' : delta <= 512 ? '257-512' : 'above-512']++;
        }
    }
    return { rows: inv.rows, coordinateReferences: inv.references.length, declaredSlots: inv.slots, unique: inv.fixed.length,
        invalid, proven, unknown, localUnknown, failures, reasons, heightBuckets, global: proven === inv.fixed.length ? 'proven' : 'incomplete',
        ...(detailed && { records: inv.fixed }) };
}

function describe(inv, proofs, budget, fixed, cacheHit) {
    return { version: 2, inventoryComplete: true, definitions: inv.definitionRecords, roots: proofs.roots, fixed,
        pools: inv.targets.map(target => ({ poolId: target.id, key: target.key,
            definitionIds: target.definitionIds,
            declaredSlots: target.slots, points: target.points.length, ...extent(target.points),
            reason: target.reason, limit: target.limit || null, adequacy: adequate(target),
            discovery: { complete: target.complete, scanned: target.scanned, candidateLayerObservations: target.eligible, unavailableCellObservations: target.unavailableCells }, attempts: cacheHit ? [] : target.attempts })),
        nonRandomDefinitions: inv.definitionRecords.filter(d => d.randomIndex === null).length,
        fixedOnlyDefinitions: inv.definitionRecords.filter(d => d.randomIndex === null && d.rows.some(row => row.mode === 'fixed')).length,
        fixedOnlyAnchorsExcluded: 0,
        work: { ...budget.work, scope: 'random_and_fixed_preparation', fixedConnectivitySearches: budget.fixedSearches || 0,
            directWalkScope: 'strictWalkCalls_includes_local_audits_and_reachable_internal_walks',
            pathNodeAllowanceKind: 'upper_bound_not_measured_expansions', fixedGlobalStatus: fixed.global,
            maxRssBytes: budget.maxRssBytes, memberships: proofs.memberships,
            rememberedPairs: proofs.pairCounts.random + proofs.pairCounts.fixed,
            rememberedPairsByKind: { ...proofs.pairCounts }, peakRememberedPairs: proofs.peakPairs,
            pairAdmissions: { ...proofs.pairAdmissions }, fixedPairLimitReached: proofs.fixedPairsLimited,
            windows: budget.windows, batches: budget.batches + 1, maxBatchCells: Math.max(budget.maxBatchCells, budget.batchCells),
            maxBatchLayers: Math.max(budget.maxBatchLayers, budget.batchLayers) },
        blocker: budget.stopped,
        enforcedLimits: { ...LIMITS, capacities: CAPACITY, fixedPairAllowance: CAPACITY.pairs,
            globalWorkBudget: false, renewableWorkWindows: true,
            deterministicFallback: true, fixedProofCache: true } };
}

function init(definitions, cacheOptions = {}) {
    preparationIdentity = null;
    const budget = new Budget();
    pools.clear(); poolStates.clear(); warned = new Set();
    revision = Number(Geo.navigationRevision || 0);
    let inv, proofs, disk = null, saved = false;
    try {
        budget.poll(true);
        inv = inventory(definitions, budget);
        proofs = new Proofs(budget);
        proofs.collect(definitions);
        inv.expected.initialTrusted = proofs.trusted.map(xyz);
        const byKey = new Map(inv.targets.map(target => [target.key, target]));
        inv.expected.validatePool = (key, values, state) => {
            const target = byKey.get(key);
            const points = [];
            for (let i = 0; i < values.length; i += 3) {
                const p = { locX: values[i], locY: values[i + 1], locZ: values[i + 2] };
                if (!target.domain || p.locZ < target.domain.minZ || p.locZ > target.domain.maxZ
                    || !inside(p.locX, p.locY, target.territory.bounds)) return false;
                points.push(p);
            }
            return adequate({ ...target, points, reason: state.reason }).accepted === state.adequate;
        };
        disk = DiskCache.open(inv.expected, proofs.roots, POOL_SIZE, { ...cacheOptions, poll: () => budget.poll(true) });
        if (disk.cached) {
            for (const target of inv.targets) {
                const packed = disk.cached.pools.get(target.key), state = disk.cached.states.get(target.key);
                for (let i = 0; i < packed.length; i += 3) target.points.push({ locX: packed[i], locY: packed[i + 1], locZ: packed[i + 2] });
                Object.assign(target, { reason: state.reason, complete: state.complete, scanned: state.scanned, limit: state.limit, eligible: state.eligible, unavailableCells: state.unavailableCells });
                pools.set(target.key, packed); poolStates.set(target.key, state);
            }
            proofs.trusted = disk.cached.trusted;
            inv.fixed.forEach((record, i) => {
                const [local, normalized, global, witness, reason, delta, limit] = disk.cached.fixed[i];
                Object.assign(record, { local, normalized: normalized && { locX: normalized[0], locY: normalized[1], locZ: normalized[2] }, global, witness, reason, delta, limit });
            });
        } else {
            for (const target of inv.targets) proofs.register(target);
            const fixedTargets = auditFixed(inv, budget);
            for (const target of inv.targets) {
                if (budget.stopped) break;
                poolAttempt(target, true, budget, proofs);
                proofs.release(target);
                proofs.enqueue(target);
            }
            // Register fixed targets only after random entry attempts, so their
            // diagnostic witnesses cannot occupy the front of the retry queue.
            for (const target of fixedTargets) {
                proofs.register(target);
                proofs.enqueue(target);
            }
            // One pending entry per target. Delete processed queue storage in
            // batches, so repeated relevant wakes cannot retain queue history.
            let head = 0;
            while (head < proofs.queue.length && !budget.stopped) {
                const target = proofs.queue[head++]; target.pending = false;
                if (!proofs.settled(target)) {
                    if (target.kind === 'fixed') {
                        const before = budget.work.pathSearchRequests;
                        proveFixed(target, budget, proofs);
                        budget.fixedSearches = (budget.fixedSearches || 0) + budget.work.pathSearchRequests - before;
                    } else poolAttempt(target, false, budget, proofs);
                }
                proofs.release(target);
                if (head >= 1024) { proofs.queue.splice(0, head); head = 0; }
                if (!budget.stopped) budget.poll(true);
            }
        }
    } catch (error) {
        if (error.code !== 'SPAWN_BUDGET') throw error;
        budget.stopped ||= error.limit;
        // Inventory/identity/initial-root failures cannot publish partial cache
        // coverage or silently certify definitions that were never inspected.
        utils.infoWarn('SpawnPlacement', '%s', error.message);
    }
    if (inv) {
        for (const target of inv.targets) {
            if (target.searchLimit) {
                target.limit ||= target.searchLimit;
                if (!adequate(target).accepted && target.reason !== 'no_layer_in_z_interval' && target.reason !== 'invalid_bounds') {
                    target.reason = 'budget_exhausted';
                }
            }
            if (budget.stopped && !adequate(target).accepted) { target.reason = 'budget_exhausted'; target.limit ||= budget.stopped; }
            if (!disk?.cached || !pools.has(target.key)) pools.set(target.key, Int32Array.from(target.points.flatMap(xyz)));
            poolStates.set(target.key, { reason: target.reason, adequate: adequate(target).accepted,
                scanned: target.scanned, complete: target.complete, limit: target.limit || null, eligible: target.eligible, unavailableCells: target.unavailableCells });
        }
        for (const record of inv.fixed) if (budget.stopped && record.global === 'unknown') {
            record.reason = 'budget_exhausted'; record.limit ||= budget.stopped;
        }
        if (disk && !disk.cached && !budget.stopped) {
            try {
                saved = disk.save(pools, poolStates, inv.fixed.map(record =>
                    [record.local, record.normalized && xyz(record.normalized), record.global, record.witness,
                        record.reason, record.delta ?? null, record.limit || null]), proofs.trusted);
            } catch (error) {
                if (error.code !== 'SPAWN_BUDGET') throw error;
                budget.stopped ||= error.limit;
            }
        }
    }
    const fixed = inv && fixedSummary(inv, !!cacheOptions.diagnostics);
    if (fixed && (fixed.invalid || fixed.unknown)) {
        const examples = inv.fixed.filter(record => record.global !== 'proven').slice(0, 8)
            .map(record => ({ authored: record.authored, local: record.local, reason: record.reason }));
        utils.infoWarn('SpawnPlacement', 'fixed coverage incomplete: %d invalid, %d unknown; examples=%s',
            fixed.invalid, fixed.unknown, JSON.stringify(examples));
    }
    const unavailable = inv ? inv.targets.filter(target => !adequate(target).accepted)
        .reduce((sum, target) => sum + target.definitionIds.length, 0) : null;
    const result = { inventoryComplete: !!inv, cacheHit: !!disk?.cached, cacheSaved: saved, fingerprint: disk?.fingerprint || null,
        territories: inv ? inv.definitionRecords.filter(d => d.randomIndex !== null).length : null,
        unavailable, points: [...pools.values()].reduce((sum, values) => sum + values.length / 3, 0),
        fixed: fixed && { unique: fixed.unique, proven: fixed.proven, invalid: fixed.invalid, unknown: fixed.unknown },
        blocker: budget.stopped, workWindows: budget.windows, elapsedMs: Math.round(performance.now() - budget.started) };
    utils.infoSuccess('SpawnPlacement', 'preparation: %d unavailable definitions, %d fixed proofs; %d ms; cache hit=%s; blocker=%s',
        unavailable, fixed?.proven || 0, result.elapsedMs, result.cacheHit, result.blocker || 'none');
    utils.infoSuccess('SpawnPlacement', 'pair history: %d peak; %d random / %d fixed admissions; fixed limit=%s',
        proofs?.peakPairs || 0, proofs?.pairAdmissions.random || 0, proofs?.pairAdmissions.fixed || 0, proofs?.fixedPairsLimited || false);
    if (cacheOptions.diagnostics) result.diagnostics = inv && proofs ? describe(inv, proofs, budget, fixed, result.cacheHit) : {
        version: 2, inventoryComplete: false, definitions: [], pools: [], roots: proofs?.roots || [],
        fixed: { global: 'incomplete', unique: null, invalid: null, proven: null, unknown: null, records: [] },
        work: { ...budget.work, windows: budget.windows }, blocker: budget.stopped, fixedOnlyAnchorsExcluded: 0,
        enforcedLimits: { ...LIMITS, capacities: CAPACITY, fixedPairAllowance: CAPACITY.pairs,
            globalWorkBudget: false, renewableWorkWindows: true,
            deterministicFallback: true, fixedProofCache: true }
    };
    preparationIdentity = Object.freeze({ fingerprint: result.fingerprint, cacheHit: result.cacheHit,
        cacheSaved: result.cacheSaved, navigationRevision: revision, preparedAt: Date.now(),
        inventoryComplete: result.inventoryComplete, blocker: result.blocker,
        source: 'retained_preparation_result_not_current_disk' });
    return result;
}

function identity() {
    return preparationIdentity && { ...preparationIdentity, current: revision === Number(Geo.navigationRevision || 0) };
}

function randomCoords(definition) {
    const key = keyFor(definition.bounds, definition.spawnAnchors);
    // Navigation changes invalidate proofs, but never trigger a whole-world
    // rebuild or path search on a spawn/AI tick. Initialization owns preparation.
    const points = revision === Number(Geo.navigationRevision || 0) && poolStates.get(key)?.adequate ? pools.get(key) : EMPTY;
    if (!points?.length) {
        if (!warned.has(key)) {
            warned.add(key);
            utils.infoWarn('SpawnPlacement', 'Territory %s has no adequate proven pool; spawns deferred (%s)',
                definition.territoryId || 'dynamic', poolStates.get(key)?.reason || 'not_prepared');
        }
        return null;
    }
    const count = points.length / 3;
    const cursor = cursors.get(points) || 0;
    const index = (cursor + Math.floor(Math.random() * (count - cursor))) * 3;
    const offset = cursor * 3;
    for (let axis = 0; axis < 3; axis++) {
        const value = points[offset + axis]; points[offset + axis] = points[index + axis]; points[index + axis] = value;
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

// Offline travel enumerates the native candidate domain, not a retained pool.
// Random discovery only emits cell centres; authored fixed/root coordinates may
// be non-centred and still need their own nearest-floor connector certificate.
function journeyAdmission(definition) {
    const bounds = domain(definition.bounds);
    if (!bounds) throw new Error('journey_spawn_domain_invalid');
    const random = definition.spawns.some(spawn => Number(spawn.total) > 0 && !spawn.coords?.length);
    const points = [...(definition.spawnAnchors || []), ...definition.spawns
        .filter(spawn => Number(spawn.total) > 0).flatMap(spawn => spawn.coords || [])];
    return {
        rule: 'native_random_cell_centres_and_authored_points',
        randomCentre(x, y) {
            return random && (x - 8) % 16 === 0 && (y - 8) % 16 === 0 && inside(x, y, definition.bounds);
        },
        containsXY: (x, y) => inside(x, y, definition.bounds),
        layer: (z, nswe) => !!nswe && z >= bounds.minZ && z <= bounds.maxZ,
        authoredPoints: points
    };
}

// Collect the complete native initial-root inventory without running random
// preparation or reading/writing its cache. Retained samples are not a domain.
function journeyAdmissionSources(definitions) {
    const roots = [];
    Proofs.prototype.collect.call({ root: (point, source) => roots.push({ source, authored: point }) }, definitions);
    const monsters = new Set(invoke('GameServer/DataCache').npcs
        .filter(npc => npc.template?.kind === 'Monster').map(npc => Number(npc.selfId)));
    const fixed = [];
    for (const [definitionId, territory] of definitions.entries()) for (const [row, spawn] of territory.spawns.entries()) {
        if (spawn.total <= 0 || !monsters.has(Number(spawn.selfId))) continue;
        for (const [coordinate, point] of spawn.coords.entries()) fixed.push({
            source: `fixed:${definitionId}:${row}:${coordinate}`, territoryId: territory.selfId, authored: point });
    }
    return { roots, fixed };
}

module.exports = { init, randomCoords, nearLeader, identity, journeyAdmission, journeyAdmissionSources };
return [[require.resolve('./GeodataEngine'), Geo], [require.resolve('./SpawnSurface'), Surface],
    [require.resolve('./SpawnPlacementCache'), DiskCache]];
});
