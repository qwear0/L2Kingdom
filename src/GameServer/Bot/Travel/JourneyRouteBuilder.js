require('../../Geodata/JourneyGeometryIdentity.js').define(module, require, function (module, exports, require, __filename, __dirname) {
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const Format = require('./JourneyRouteFormat');
const Inputs = require('./JourneyRouteInputs');
const Components = require('./JourneyRouteComponents');

const CELL = 16;
const SEARCH_LIMIT = 120000;
const MAX_NATIVE_STEP = 128;

class BuildStop extends Error {
    constructor(reason, global = false) {
        super(reason);
        this.code = 'JOURNEY_BUILD_LIMIT';
        this.reason = reason;
        this.global = global;
    }
}
class BuildBudget {
    constructor() {
        this.startedAt = performance.now();
        this.absoluteRssBytes = 0;
        this.work = { examinedPolygonCells: 0, decodedLayerVisits: 0, nativeTransitions: 0,
            transitionCandidates: 0, searchCalls: 0, reservedSearchExpansions: 0,
            actualSearchExpansions: 0, localSearchExpansions: 0, refinementVisits: 0,
            polygons: 0, certificates: 0, totalGeoBytes: 0 };
        this.currentPolygon = null;
        this.currentPolygonStarted = 0;
        this.currentOperationStarted = 0;
        this.currentOperationReserved = 0;
        this.stopped = null;
    }
    poll() {
        const now = performance.now();
        if (this.stopped) throw new BuildStop(this.stopped, true);
        if (now - this.startedAt >= Format.LIMITS.maxBuildMs) this.stop('offline_wall_limit', true);
        const rss = process.memoryUsage.rss();
        this.absoluteRssBytes = Math.max(this.absoluteRssBytes, rss);
        if (rss >= Format.LIMITS.maxBuildRss) this.stop('offline_rss_limit', true);
        if (this.currentPolygon && now - this.currentPolygonStarted >= Format.LIMITS.maxPolygonMs) {
            throw new BuildStop('polygon_time_limit');
        }
        if (this.currentOperationStarted && now - this.currentOperationStarted >= Format.LIMITS.maxSearchMsPerCall) {
            throw new BuildStop('path_pair_time_limit');
        }
    }
    stop(reason, global) {
        if (global) this.stopped ||= reason;
        throw new BuildStop(reason, global);
    }
    scan(count = 1) {
        this.work.examinedPolygonCells += count;
        if (this.work.examinedPolygonCells > 16000000) this.stop('polygon_cell_state_limit', true);
        if ((this.work.examinedPolygonCells & 127) === 0) this.poll();
    }
    beforeLayers() {
        this.work.decodedLayerVisits += 255;
        if (this.work.decodedLayerVisits > 256000000) this.stop('decoded_layer_visit_limit', true);
        if ((this.work.decodedLayerVisits & 127) === 0) this.poll();
    }
    decodedLayers(count) {
        // beforeLayers reserves at most 255 visits; replace its worst-case
        // reservation with actual decoded visits without renewing the ceiling.
        this.work.decodedLayerVisits -= 255 - count;
        if (this.work.decodedLayerVisits > 256000000) this.stop('decoded_layer_visit_limit', true);
    }
    decoded(count) { this.decodedLayers(count); }
    transition(count = 1) {
        this.work.transitionCandidates += count;
        if (this.work.transitionCandidates > 128000000) this.stop('transition_limit', true);
        if ((this.work.transitionCandidates & 127) === 0) this.poll();
    }
    nativeTransitions(count = 128) {
        this.work.nativeTransitions += count;
        if (this.work.nativeTransitions > 128000000) this.stop('native_transition_limit', true);
        this.poll();
    }
    refine() {
        this.work.refinementVisits++;
        if ((this.work.refinementVisits & 127) === 0) this.poll();
    }
    localExpand() {
        this.work.localSearchExpansions++;
        this.work.reservedSearchExpansions++;
        if (this.work.reservedSearchExpansions > Format.LIMITS.maxSearchExpansions) this.stop('search_expansion_limit', true);
        if ((this.work.localSearchExpansions & 127) === 0) this.poll();
    }
    beginPolygon(id) {
        this.poll();
        this.currentPolygon = id;
        this.currentPolygonStarted = performance.now();
    }
    endPolygon() {
        this.currentPolygon = null;
        this.currentPolygonStarted = 0;
        this.work.polygons++;
        this.poll();
    }
    beginSearch() {
        this.poll();
        if (this.work.searchCalls >= Format.LIMITS.maxSearches
            || this.work.reservedSearchExpansions + SEARCH_LIMIT + 1 > Format.LIMITS.maxSearchExpansions) {
            this.stop('native_search_work_limit', true);
        }
        this.work.searchCalls++;
        this.currentOperationStarted = performance.now();
        this.currentOperationReserved = SEARCH_LIMIT + 1;
        this.work.reservedSearchExpansions += this.currentOperationReserved;
    }
    searchCheckpoint() {
        this.work.actualSearchExpansions += 128;
        this.poll();
    }
    endSearch(evidence) {
        if (Number.isInteger(evidence?.nodesExpanded)) {
            this.work.actualSearchExpansions += evidence.nodesExpanded % 128;
        }
        this.currentOperationStarted = 0;
        this.currentOperationReserved = 0;
        this.poll();
    }
    assertHealthy() { this.poll(); }
    summary() {
        return { ...this.work, maxRssBytes: this.absoluteRssBytes,
            elapsedMs: Math.round(performance.now() - this.startedAt), workerProcesses: 1 };
    }
}

function insideRegion(point, region) {
    if (point.locZ < region.minZ || point.locZ > region.maxZ) return false;
    return Components.pointInPolygon(point.locX, point.locY, region.polygon);
}
function validBounds(bounds) {
    return Array.isArray(bounds) && bounds.length >= 3 && bounds.every(point =>
        Number.isFinite(point.locX) && Number.isFinite(point.locY)
        && Number.isFinite(point.minZ) && Number.isFinite(point.maxZ) && point.minZ <= point.maxZ);
}
function regionsForBounds(bounds) {
    const minX = Math.min(...bounds.map(point => point.locX)), maxX = Math.max(...bounds.map(point => point.locX));
    const minY = Math.min(...bounds.map(point => point.locY)), maxY = Math.max(...bounds.map(point => point.locY));
    const x0 = (minX >> 15) + 20, x1 = (maxX >> 15) + 20;
    const y0 = (minY >> 15) + 18, y1 = (maxY >> 15) + 18;
    const regions = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) regions.push(`${x}_${y}`);
    return regions;
}
function raidExclusions(registered, RaidBossBalance) {
    const templatesById = new Map();
    for (const row of registered.templates) {
        const id = Number(row?.selfId);
        if (!Number.isInteger(id)) continue;
        if (!templatesById.has(id)) templatesById.set(id, []);
        templatesById.get(id).push(row);
    }
    const exclusions = [], unknown = [];
    for (const zone of registered.spawnDefinitions) for (const spawn of zone.spawns || []) {
        const npcId = Number(spawn.selfId), rows = templatesById.get(npcId) || [];
        if (!rows.length || !rows.some(row => RaidBossBalance.isRaidEntityTemplate(row))) continue;
        if (rows.length !== 1) {
            unknown.push({ zoneId: zone.selfId, npcId, reason: 'ambiguous_raid_template' });
            continue;
        }
        const coordinates = Array.isArray(spawn.coords) ? spawn.coords : [];
        if (coordinates.length) {
            for (const [index, point] of coordinates.entries()) {
                if (![point?.locX, point?.locY, point?.locZ].every(Number.isFinite)) {
                    unknown.push({ zoneId: zone.selfId, npcId, reason: `invalid_fixed_placement:${index}` });
                    continue;
                }
                exclusions.push({ kind: 'fixed', zoneId: zone.selfId, npcId,
                    minX: point.locX - 2000, maxX: point.locX + 2000,
                    minY: point.locY - 2000, maxY: point.locY + 2000,
                    minZ: point.locZ - 256, maxZ: point.locZ + 256 });
            }
        } else if (Number(spawn.total) > 0 && validBounds(zone.bounds)) {
            const minZ = Math.min(...zone.bounds.map(point => point.minZ));
            const maxZ = Math.max(...zone.bounds.map(point => point.maxZ));
            exclusions.push({ kind: 'random', zoneId: zone.selfId, npcId,
                minX: Math.min(...zone.bounds.map(point => point.locX)) - 2000,
                maxX: Math.max(...zone.bounds.map(point => point.locX)) + 2000,
                minY: Math.min(...zone.bounds.map(point => point.locY)) - 2000,
                maxY: Math.max(...zone.bounds.map(point => point.locY)) + 2000,
                minZ: minZ - 256, maxZ: maxZ + 256 });
        } else if (Number(spawn.total) > 0) {
            unknown.push({ zoneId: zone.selfId, npcId, reason: 'raid_placement_unknown' });
        }
    }
    return { exclusions, unknown };
}
function buildSafety(world, registered) {
    const raids = raidExclusions(registered, world.RaidBossBalance);
    const unknown = raids.unknown;
    return {
        unknown,
        point(point) {
            if (!point || ![point.locX, point.locY, point.locZ].every(Number.isFinite)) return 'unresolved';
            if (world.WorldAreaCatalog.resolve(point)) return 'dungeon';
            for (const box of raids.exclusions) if (point.locZ >= box.minZ && point.locZ <= box.maxZ
                && point.locX >= box.minX && point.locX <= box.maxX
                && point.locY >= box.minY && point.locY <= box.maxY) return 'raid';
            return null;
        }
    };
}
function regionSets(input) {
    const byId = new Map();
    for (const region of [...input.acceptedTransitRegions, ...input.rejectedTransitRegions]) byId.set(region.id, region);
    return byId;
}
function makePermission(input, activeIds, context = {}) {
    const all = regionSets(input);
    const accepted = activeIds.map(id => all.get(id)).filter(Boolean);
    const rejected = [...input.rejectedTransitRegions,
        ...input.acceptedTransitRegions.filter(region => region.role === 'deny')];
    if (!accepted.length || accepted.some(region => !input.acceptedTransitRegions.includes(region)
        || region.role === 'deny')) return () => false;
    const scoped = region => (region.role !== 'farm_access'
        || region.areaId === context.areaId && region.spawnId === context.spawnId)
        && (!region.townKey || !context.townKey || region.townKey === context.townKey);
    const bounded = region => ({ region,
        minX: Math.min(...region.polygon.map(p => p.locX)), maxX: Math.max(...region.polygon.map(p => p.locX)),
        minY: Math.min(...region.polygon.map(p => p.locY)), maxY: Math.max(...region.polygon.map(p => p.locY)) });
    const allowed = accepted.filter(scoped).map(bounded), denied = rejected.map(bounded);
    const contains = (point, box) => point.locX >= box.minX && point.locX <= box.maxX
        && point.locY >= box.minY && point.locY <= box.maxY && insideRegion(point, box.region);
    return point => !denied.some(box => contains(point, box)) && allowed.some(box => contains(point, box));
}
function pointKey(point) {
    return `${point.locX}:${point.locY}:${point.locZ}`;
}
function distance2d(a, b) {
    return Math.hypot(a.locX - b.locX, a.locY - b.locY);
}
function normalizePoint(point, Geo, Surface, budget) {
    if (!point || !['locX', 'locY', 'locZ'].every(key => Number.isFinite(point[key]))) return null;
    return Surface.supported(point, budget);
}
function withPointSafety(Geo, Surface, budget, permitted, safety) {
    const exactLayerCache = new Map(), centreAdmissionCache = new Map();
    const realLayer = point => {
        const key = `${point.locX >> 4}:${point.locY >> 4}:${point.locZ}`;
        if (exactLayerCache.has(key)) return exactLayerCache.get(key);
        const valid = Surface.layers(point.locX, point.locY, budget).some(layer => layer.nswe && layer.z === point.locZ);
        exactLayerCache.set(key, valid);
        return valid;
    };
    const admit = point => {
        // Permission is constant for this proof, but polygon boundaries need
        // exact XY: only cell centres may share a cell/layer permission result.
        const centre = (point.locX - 8) % 16 === 0 && (point.locY - 8) % 16 === 0;
        const key = centre ? pointKey(point) : null;
        if (centre && centreAdmissionCache.has(key)) return centreAdmissionCache.get(key);
        const valid = permitted(point) && !safety.point(point) && realLayer(point);
        if (centre) centreAdmissionCache.set(key, valid);
        return valid;
    };
    return { admitNode: admit, admitSegment: admit,
        checkBudget: () => budget.searchCheckpoint(),
        checkTransitionBudget: () => budget.transition(128),
        checkSegmentBudget: () => budget.nativeTransitions(128) };
}
function densifyPath(points, Geo, Surface, budget, admit) {
    const dense = [];
    const push = point => {
        const previous = dense[dense.length - 1];
        if (!previous || previous[0] !== point.locX || previous[1] !== point.locY || previous[2] !== point.locZ) {
            dense.push([point.locX, point.locY, point.locZ]);
        }
    };
    if (points.length < 2) return { points: [], length: 0, length2d: 0 };
    push(points[0]);
    let length = 0, length2d = 0;
    const nativeOptions = { admitPoint: admit, checkBudget: () => budget.nativeTransitions(128) };
    for (let index = 1; index < points.length; index++) {
        const from = { locX: dense[dense.length - 1][0], locY: dense[dense.length - 1][1], locZ: dense[dense.length - 1][2] };
        const to = points[index];
        // Rounding both endpoints can add at most sqrt(2) XY units. Reserve
        // two units before rounding; the issued native segment must stay <=128.
        const xy = distance2d(from, to), steps = Math.max(1, Math.ceil(xy / (MAX_NATIVE_STEP - 2)));
        for (let step = 1; step <= steps; step++) {
            const ratio = step / steps;
            const candidate = { locX: Math.round(from.locX + (to.locX - from.locX) * ratio),
                locY: Math.round(from.locY + (to.locY - from.locY) * ratio),
                locZ: Math.round(from.locZ + (to.locZ - from.locZ) * ratio) };
            const previous = dense[dense.length - 1];
            // Intermediate Z follows the native source floor, not linear height
            // interpolation across a hill. Recheck the exact authored endpoint.
            const resolved = Geo.walkSegment({ locX: previous[0], locY: previous[1], locZ: previous[2] },
                candidate, false, nativeOptions);
            if (!resolved || step === steps && resolved.locZ !== to.locZ) return null;
            length += Math.hypot(resolved.locX - previous[0], resolved.locY - previous[1], resolved.locZ - previous[2]);
            length2d += Math.hypot(resolved.locX - previous[0], resolved.locY - previous[1]);
            push(resolved);
        }
    }
    if (dense.length > Format.LIMITS.trunkVertices) return null;
    if (dense.length > 1) {
        for (let index = 1; index < dense.length; index++) {
            const delta = Math.hypot(dense[index][0] - dense[index - 1][0], dense[index][1] - dense[index - 1][1]);
            if (delta > MAX_NATIVE_STEP) return null;
        }
    }
    return { points: dense, length, length2d };
}
function provePath({ from, to, regionIds, context = {}, world, budget, safety, constraints = {} }) {
    const { Geo, Surface } = world;
    const started = performance.now();
    if (!regionIds.length || safety.unknown.length) return { status: 'unresolved', reason: 'unsafe_transit' };
    const permitted = makePermission(world.input, regionIds, context);
    let start = normalizePoint(from, Geo, Surface, budget), end = normalizePoint(to, Geo, Surface, budget);
    if (!start || !end) {
        const missing = !Geo.hasGeo(from.locX, from.locY) || !Geo.hasGeo(to.locX, to.locY);
        return { status: 'unresolved', reason: missing ? 'missing_geodata' : 'no_admitted_surface' };
    }
    const domain = withPointSafety(Geo, Surface, budget, permitted, safety);
    if (!domain.admitNode(start) || !domain.admitNode(end)) return { status: 'unresolved', reason: 'unsafe_transit' };
    const evidence = {};
    budget.beginSearch();
    let route;
    try {
        route = Geo.findPath(start.locX, start.locY, start.locZ, end.locX, end.locY, end.locZ,
            SEARCH_LIMIT, { debug: false, requireComplete: true, fastSmoothing: true, evidence,
                admitNode: domain.admitNode, admitSegment: domain.admitSegment,
                checkBudget: domain.checkBudget, checkTransitionBudget: domain.checkTransitionBudget,
                checkSegmentBudget: domain.checkSegmentBudget });
    } catch (error) {
        budget.endSearch(evidence);
        if (error.code === 'PATH_NODE_LIMIT' || error instanceof BuildStop && !error.global) {
            return { status: 'unresolved', reason: 'limit_reached', evidence, diagnostic: error.reason || error.code };
        }
        throw error;
    }
    budget.endSearch(evidence);
    if (!route?.length) {
        if (evidence.missingGeodata) return { status: 'unresolved', reason: 'missing_geodata', evidence };
        if (evidence.stopReason === 'OPEN_SET_EXHAUSTED' && evidence.searchComplete) {
            return { status: 'unsupported', reason: 'no_path_in_declared_domain', evidence };
        }
        return { status: 'unresolved', reason: 'limit_reached', evidence };
    }
    const middle = route.length > 1 ? route.slice(0, -1) : [];
    const points = [start, ...middle, end].filter((point, index, rows) => index === 0 || pointKey(point) !== pointKey(rows[index - 1]));
    const geometry = densifyPath(points, Geo, Surface, budget, domain.admitSegment);
    if (!geometry) return { status: 'unresolved', reason: 'unsafe_transit', evidence };
    const maxXY = Math.max(0, ...geometry.points.map(point => Math.hypot(point[0] - start.locX, point[1] - start.locY)));
    if (constraints.maxDistance !== undefined && geometry.length > constraints.maxDistance
        || constraints.maxRadius !== undefined && maxXY > constraints.maxRadius) {
        return { status: 'unresolved', reason: 'limit_reached', evidence, length: geometry.length, maxXY };
    }
    if (geometry.length2d > Format.LIMITS.trunkLength) return { status: 'unresolved', reason: 'limit_reached', evidence };
    if (performance.now() - started > Format.LIMITS.maxSearchMsPerCall) return { status: 'unresolved', reason: 'limit_reached', evidence };
    return { status: 'supported', reason: null, from: start, to: end, points: geometry.points,
        length: geometry.length, length2d: geometry.length2d, maxXY,
        nodeCount: evidence.nodesExpanded || 1, evidence };
}
function stableServiceId(row, townKey) {
    return `${townKey}:${row.npcSelfId}:${row.locX}:${row.locY}:${row.locZ}`;
}
function serviceWaypointMatches(waypoint, row, serviceId) {
    const claimed = Number(waypoint.serviceNpcId ?? waypoint.npcSelfId ?? waypoint.service?.npcSelfId);
    if (Number.isInteger(claimed)) return claimed === Number(row.npcSelfId);
    if (waypoint.serviceId) return waypoint.serviceId === serviceId;
    const provenance = String(waypoint.provenance || '');
    return provenance === `TownServiceCatalog:${serviceId}` || provenance === `service:${serviceId}`;
}
function requirementsSnapshot(input) {
    return structuredClone(input);
}
function addWaypoint(map, candidate) {
    const previous = map.get(candidate.id);
    if (previous) {
        if (previous.kind !== candidate.kind || pointKey(previous.point) !== pointKey(candidate.point)) {
            throw new Error(`waypoint_candidate_conflict:${candidate.id}`);
        }
        return previous;
    }
    map.set(candidate.id, candidate);
    return candidate;
}
function selectedTownGateWaypoints(input, scope, townKeys, GateCatalog, TownRespawn, authoredWaypoints) {
    const result = new Map();
    for (const townKey of townKeys) {
        const town = input.requiredTowns.find(row => row.townKey === townKey);
        if (!town) continue;
        addWaypoint(result, authoredWaypoints.get(`${townKey}:seed`) || {
            id: `${townKey}:seed`, kind: 'town_seed', point: town.seedPoint, townKey,
            provenance: `TownRespawn.towns:${townKey}`
        });
        for (const gateSeed of input.waypointSeeds.filter(seed => seed.townKey === townKey)) {
            const gate = GateCatalog.gatesFor(town.name).find(row => row.id === gateSeed.gateId);
            if (!gate) throw new Error(`town_gate_source_missing:${gateSeed.id}`);
            for (const side of gateSeed.sides) {
                const id = `${gateSeed.id}:${side}`;
                const kind = side === 'inside' ? 'town_gate_inside'
                    : side === 'passage' ? 'town_gate_passage' : 'town_gate_outside';
                addWaypoint(result, authoredWaypoints.get(id) || {
                    id, kind, point: gate[side], townKey,
                    provenance: `TownGateCatalog:${gateSeed.id}:${side}`
                });
            }
        }
    }
    return result;
}
function createTownServiceRows(world, selectedTownKeys, roles) {
    const townNameToKey = new Map(Object.entries(world.TownRespawn.towns).map(([key, town]) => [town.name, key]));
    return world.serviceRows.filter(row => selectedTownKeys.includes(townNameToKey.get(row.town))
        && row.roles.some(role => roles.includes(role))).map(row => {
        const townKey = townNameToKey.get(row.town);
        return { id: stableServiceId(row, townKey), townKey, npcSelfId: Number(row.npcSelfId),
            roles: [...row.roles].sort(), name: row.name, title: row.title,
            point: { locX: row.locX, locY: row.locY, locZ: row.locZ } };
    }).sort((a, b) => a.id.localeCompare(b.id));
}
function makeCoverageEntry(kind, requirementId, status, reason, certificateIds = []) {
    return { kind, requirementId, status, reason: reason || null, certificateIds: [...new Set(certificateIds)].sort() };
}
function selectSupportedRegions(input, regionIds) {
    const all = regionSets(input);
    const accepted = regionIds.map(id => all.get(id));
    if (accepted.some(region => !region)) return { valid: false, reason: 'unsafe_transit' };
    if (accepted.some(region => !input.acceptedTransitRegions.includes(region) || region.role === 'deny')) {
        return { valid: false, reason: 'unsafe_transit' };
    }
    return { valid: accepted.length > 0, reason: accepted.length ? null : 'unsafe_transit' };
}
function buildTownProofs({ input, scope, world, budget, safety, waypointMap, accessCertificates, coverage }) {
    const selectedTowns = scope.requirementIds.filter(id => input.requiredTowns.some(row => row.townKey === id));
    const selectedGateIds = new Set(input.waypointSeeds.filter(row => selectedTowns.includes(row.townKey)).map(row => row.id));
    const gateCoverage = [];
    for (const seed of input.waypointSeeds) {
        if (!selectedGateIds.has(seed.id)) {
            gateCoverage.push(makeCoverageEntry('gate', seed.id, 'unresolved', 'outside_slice'));
            continue;
        }
        const sides = seed.sides.map(side => waypointMap.get(`${seed.id}:${side}`));
        const regions = input.acceptedTransitRegions.filter(region => ['town_approach', 'land_road'].includes(region.role)
            && (!region.townKey || region.townKey === seed.townKey)).map(region => region.id);
        const regionCheck = selectSupportedRegions(input, regions);
        const certs = [];
        let failed = !regionCheck.valid, failureReason = regionCheck.reason;
        const pairs = [[0, 1], [1, 2]];
        for (const [a, b] of pairs) for (const [fromIndex, toIndex, direction] of [
            [a, b, 'forward'], [b, a, 'reverse']]) {
            const from = sides[fromIndex], to = sides[toIndex];
            if (!from || !to) { failed = true; failureReason ||= 'source_missing'; continue; }
            const result = provePath({ from: from.point, to: to.point, regionIds: regions, context: { townKey: seed.townKey },
                world, budget, safety });
            const id = `gate:${seed.id}:${direction}:${fromIndex}-${toIndex}`;
            if (result.status === 'supported') {
                accessCertificates.push({ id, kind: 'town_gate', requirementId: seed.id, direction,
                    fromAnchorId: from.id, toAnchorId: to.id,
                    length: result.length, nodeCount: result.nodeCount, regionIds: regions, geometry: result.points });
                certs.push(id);
            } else { failed = true; failureReason ||= result.reason; }
        }
        const status = failed ? 'unresolved' : 'supported';
        const reason = failed ? failureReason || 'trunk_unproved' : null;
        gateCoverage.push(makeCoverageEntry('gate', seed.id, status, reason, certs));
    }
    for (const town of input.requiredTowns) {
        if (!selectedTowns.includes(town.townKey)) {
            coverage.towns.push(makeCoverageEntry('town', town.townKey, 'unresolved', 'outside_slice'));
            continue;
        }
        const gates = gateCoverage.filter(row => input.waypointSeeds.find(seed => seed.id === row.requirementId)?.townKey === town.townKey);
        const townSeed = waypointMap.get(`${town.townKey}:seed`);
        const firstInside = gates.find(row => row.status === 'supported')
            && waypointMap.get(`${gates.find(row => row.status === 'supported').requirementId}:inside`);
        const townRegions = input.acceptedTransitRegions.filter(region => region.role === 'town_approach'
            && (!region.townKey || region.townKey === town.townKey)).map(region => region.id);
        const townCerts = [];
        let seedConnected = false, seedFailure = 'town_access_pending';
        if (townSeed && firstInside && townRegions.length) {
            for (const [from, to, direction] of [[townSeed, firstInside, 'to_gate'], [firstInside, townSeed, 'from_gate']]) {
                const result = provePath({ from: from.point, to: to.point, regionIds: townRegions,
                    context: { townKey: town.townKey }, world, budget, safety });
                if (result.status !== 'supported') { seedFailure = result.reason || seedFailure; continue; }
                const id = `town:${town.townKey}:seed:${direction}`;
                accessCertificates.push({ id, kind: 'town_seed_access', requirementId: town.townKey,
                    direction, fromAnchorId: from.id, toAnchorId: to.id, length: result.length,
                    nodeCount: result.nodeCount, regionIds: townRegions, geometry: result.points });
                townCerts.push(id);
            }
            seedConnected = townCerts.length === 2;
        } else if (!townRegions.length) seedFailure = 'unsafe_transit';
        const supportedGate = gates.length > 0 && gates.every(row => row.status === 'supported');
        const supported = supportedGate && seedConnected;
        coverage.towns.push(makeCoverageEntry('town', town.townKey, supported ? 'supported' : 'unresolved',
            supported ? null : gates.find(row => row.reason)?.reason || seedFailure,
            [...gates.flatMap(row => row.certificateIds), ...townCerts]));
    }
    coverage.gates = gateCoverage;
}
function nativeWaypoints(input, scope, world, TownGateCatalog) {
    const selectedTownKeys = scope.requirementIds.filter(id => input.requiredTowns.some(row => row.townKey === id));
    const authored = new Map(input.waypoints.map(row => [row.id, { ...row, status: 'unresolved', reason: 'candidate_unproved' }]));
    const townSeeds = selectedTownGateWaypoints(input, scope, selectedTownKeys, TownGateCatalog, world.TownRespawn, authored);
    for (const [id, waypoint] of townSeeds) addWaypoint(authored, waypoint);
    const rows = [...authored.values()].filter(waypoint => scope.waypointIds.includes(waypoint.id)
        || selectedTownKeys.includes(waypoint.townKey)
        || input.trunks.some(trunk => scope.connectionIds.includes(trunk.id)
            && (trunk.from === waypoint.id || trunk.to === waypoint.id)));
    if (rows.length > Format.LIMITS.waypoints) throw new Error('selected_waypoint_limit_exceeded');
    return { rows, map: new Map(rows.map(row => [row.id, row])), selectedTownKeys };
}
function templateIndex(registered) {
    const byId = new Map();
    for (const row of registered.templates) {
        const id = Number(row?.selfId);
        if (!Number.isInteger(id)) continue;
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push(row);
    }
    return byId;
}
function makePolygonCoverage(input, scope, polygonResults) {
    const selected = new Map(polygonResults.map(result => [result.spawnId, result]));
    return input.requiredPolygons.map(requirement => {
        const result = selected.get(requirement.spawnId);
        if (!scope.requirementIds.includes(requirement.spawnId)) {
            return makeCoverageEntry('polygon', requirement.spawnId, 'unresolved', 'outside_slice');
        }
        if (!result) return makeCoverageEntry('polygon', requirement.spawnId, 'unresolved', 'component_scan_pending');
        return makeCoverageEntry('polygon', requirement.spawnId, result.status, result.reason,
            result.certificateIds || result.componentIds || []);
    });
}
function makeSelectedRegionIds(input, connection) {
    const checked = selectSupportedRegions(input, connection.transitRegionIds);
    return checked.valid ? connection.transitRegionIds : null;
}
function certifyTrunk({ connection, waypoints, input, world, budget, safety, certificates }) {
    const from = waypoints.get(connection.from), to = waypoints.get(connection.to);
    if (!from || !to) return { status: 'unresolved', reason: 'invalid_input' };
    const regionIds = makeSelectedRegionIds(input, connection);
    if (!regionIds) return { status: 'unresolved', reason: 'unsafe_transit' };
    const context = { areaId: to.areaId || from.areaId, spawnId: to.spawnId || from.spawnId };
    const result = provePath({ from: from.point, to: to.point, regionIds, context, world, budget, safety });
    if (result.status !== 'supported') return result;
    if (result.length2d > 6000 || result.points.length > Format.LIMITS.trunkVertices) {
        return { status: 'unresolved', reason: 'limit_reached', evidence: result.evidence };
    }
    const certId = `trunk:${connection.id}`;
    certificates.push({ id: certId, kind: 'trunk', requirementId: connection.id, direction: 'forward',
        fromAnchorId: connection.from, toAnchorId: connection.to, length: result.length,
        nodeCount: result.nodeCount, regionIds, geometry: result.points });
    return { status: 'supported', reason: null, id: connection.id, from: connection.from, to: connection.to,
        points: result.points, length: result.length2d, transitRegionIds: regionIds,
        regionIds, certificateId: certId, componentIds: [] };
}
function accountAdmissionRoots(areaResult, registered, world, budget) {
    const sources = require('../../Geodata/SpawnPlacement').journeyAdmissionSources(registered.spawnDefinitions);
    const rows = new Map();
    for (const span of areaResult.spans) {
        if (!rows.has(span.rowY)) rows.set(span.rowY, []);
        rows.get(span.rowY).push(span);
    }
    const rootsByComponent = new Map(), fixedByComponent = new Map();
    const classify = (entry, memberships) => {
        budget.poll();
        const point = entry.authored;
        if (!point || !['locX', 'locY', 'locZ'].every(axis => Number.isInteger(point[axis]))) {
            return { ...entry, status: 'invalid_coordinate' };
        }
        const spans = (rows.get(point.locY >> 4) || []).filter(span => span.xStart <= (point.locX >> 4)
            && span.xEnd >= (point.locX >> 4));
        if (!spans.length) return { ...entry, status: 'outside_component_cells' };
        const normalized = world.Surface.supported(point, budget);
        const componentIds = [...new Set(spans.filter(span => span.layerZ === normalized?.locZ).map(span => span.componentId))];
        for (const id of componentIds) {
            if (!memberships.has(id)) memberships.set(id, []);
            memberships.get(id).push(entry.source);
        }
        return { ...entry, normalized, componentIds, status: componentIds.length ? 'component_cell_root' : 'no_matching_component_layer' };
    };
    const roots = sources.roots.map(entry => classify(entry, rootsByComponent));
    const fixed = sources.fixed.map(entry => classify(entry, fixedByComponent));
    for (const component of areaResult.components) {
        const initialRoots = rootsByComponent.get(component.id) || [], fixedCoordinates = fixedByComponent.get(component.id) || [];
        component.nativeBoundary.initialRootSources = initialRoots;
        component.nativeBoundary.fixedCoordinateSources = fixedCoordinates;
        // Fixed monster coordinates are not initial trusted roots: auditFixed
        // shares them only after a proof from the existing trusted closure.
        // Keep coverage unresolved until the root/transition contract is settled.
        component.nativeBoundary.rootAdmission = initialRoots.length ? 'initial_root_present'
            : component.nativeBoundary.status === 'closed' && !fixedCoordinates.length
                ? 'no_initial_root_in_closed_native_component' : 'not_proven';
    }
    return { scope: 'complete_native_collect_and_positive_fixed_monster_inventory',
        randomAdmission: 'root_or_previously_proven_witness_then_Surface.walk_or_Surface.reachable',
        fixedAdmission: 'authored_fixed_coordinates_are_not_random_roots; global_proof_is_diagnostic',
        roots, fixed, initialRootCount: roots.length, fixedCoordinateCount: fixed.length };
}
function certifyNativeAdmission(areaResult, world, budget, certificates) {
    const inventory = areaResult.rootAdmission;
    if (!inventory) return;
    const sourcesByCell = new Map(), pointsByComponent = new Map();
    for (const entry of [...inventory.roots, ...inventory.fixed]) {
        const point = entry.authored;
        if (!point || !Number.isInteger(point.locX) || !Number.isInteger(point.locY)) continue;
        const key = `${point.locX >> 4}:${point.locY >> 4}`;
        if (!sourcesByCell.has(key)) sourcesByCell.set(key, []);
        sourcesByCell.get(key).push(entry);
    }
    for (const span of areaResult.spans) {
        if (!pointsByComponent.has(span.componentId)) pointsByComponent.set(span.componentId, []);
        for (let x = span.xStart; x <= span.xEnd; x++) pointsByComponent.get(span.componentId).push({
            locX: (x << 4) + 8, locY: (span.rowY << 4) + 8, locZ: span.layerZ });
    }
    const obstacles = require('../../Geodata/VirtualObstacles');
    const nativeNodes = new Map(areaResult.nodes.map(node => [`${node.cx}:${node.cy}:${node.z}`, node]));
    for (const component of areaResult.components) {
        if (component.status === 'supported') continue;
        const points = pointsByComponent.get(component.id) || [];
        if (points.length !== component.nodeCount || !points.length || points.some(point => {
            const native = nativeNodes.get(`${point.locX >> 4}:${point.locY >> 4}:${point.locZ}`);
            return !native || native.x !== point.locX || native.y !== point.locY;
        })) continue;
        // Non-centred admission and sub-cell virtual obstacles require their
        // own connector proof; a centre-only cut must not exclude them.
        if (points.some(point => {
            const region = `${(point.locX >> 15) + 20}_${(point.locY >> 15) + 18}`;
            return obstacles.obstaclesByRegion[region]?.length;
        })) continue;
        const boundary = component.nativeBoundary;
        const closure = boundary?.status === 'closed'
            ? { status: 'closed', states: points.map(p => [p.locX, p.locY, p.locZ]),
                expanded: 0, checkedPairs: boundary.checkedPairs }
            : Components.nativeAdmissionClosure(points, world.Geo, world.Surface, budget);
        component.nativeAdmission = { status: 'unresolved', closure };
        if (closure.status !== 'closed') continue;
        const stateKeys = new Set(closure.states.map(p => `${p[0] >> 4}:${p[1] >> 4}:${p[2]}`));
        const checkedCells = new Set(), presentSources = [];
        let connectorChecks = 0, unknown = false;
        for (const [x, y] of closure.states) {
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const region = `${((x + dx * CELL) >> 15) + 20}_${((y + dy * CELL) >> 15) + 18}`;
                if (obstacles.obstaclesByRegion[region]?.length) unknown = true;
            }
            if (unknown) break;
            const cell = `${x >> 4}:${y >> 4}`;
            if (checkedCells.has(cell)) continue;
            checkedCells.add(cell);
            for (const source of sourcesByCell.get(cell) || []) {
                const normalized = world.Surface.supported(source.authored, budget);
                connectorChecks++;
                if (!normalized) { unknown = true; continue; }
                if (!stateKeys.has(`${x >> 4}:${y >> 4}:${normalized.locZ}`)) continue;
                const centre = { locX: x, locY: y, locZ: normalized.locZ };
                budget.transition(2);
                const spawn = world.Surface.walk(normalized, centre);
                const actor = world.Geo.walkSegment(normalized, centre, true);
                if (spawn || actor?.locZ === centre.locZ) presentSources.push(source.source);
                else unknown = true;
            }
        }
        if (unknown || presentSources.length) {
            component.nativeAdmission.presentSources = presentSources;
            continue;
        }
        // The native producer starts empty, adds roots, and only adds random or
        // fixed witnesses after Surface.walk/reachable ancestry. Its sole cache
        // writer saves cold results; same-fingerprint/checksum warm restoration
        // preserves that ancestry. This is local producer provenance, not trust
        // in arbitrary imported/re-authored cache payloads.
        const id = `native-exclusion:${component.id}`;
        certificates.push({ id, kind: 'native_admission_exclusion', requirementId: component.spawnId,
            componentId: component.id, direction: 'both', provenanceRule: 'native-root-closure-v1',
            cacheContract: 'locally_produced_same_fingerprint_and_checksum',
            initialRootCount: inventory.initialRootCount, fixedCoordinateCount: inventory.fixedCoordinateCount,
            connectorChecks, presentSources: [], domain: { kind: 'closed_native_layer_cells',
                states: closure.states, includesDiagonals: true, includesSameCellLayers: true,
                movementAndSpawn: true, complete: true }, checkedPairs: closure.checkedPairs });
        component.nativeAdmission = { status: 'excluded', certificateId: id };
        component.certificateIds = [...(component.certificateIds || []), id];
        component.status = 'unsupported'; component.reason = 'no_path_in_declared_domain';
        delete component.diagnostic;
    }
    const excluded = areaResult.components.filter(c => c.nativeAdmission?.status === 'excluded');
    Object.assign(areaResult.stats, { nativeExcludedComponents: excluded.length,
        nativeExcludedLayers: excluded.reduce((sum, c) => sum + c.nodeCount, 0),
        nativeAdmittedComponents: areaResult.components.length - excluded.length,
        nativeAdmittedLayers: areaResult.nodes.length - excluded.reduce((sum, c) => sum + c.nodeCount, 0) });
}

function attachComponentEntries(polygon, areaResult, entryWaypoints, input, world, budget, safety, certificates, attachments) {
    const memberSpan = point => areaResult.spans.find(row => row.layerZ === point.locZ && row.rowY === (point.locY >> 4)
        && row.xStart <= (point.locX >> 4) && row.xEnd >= (point.locX >> 4));
    const entrySpans = new Map();
    for (const waypoint of entryWaypoints) {
        const point = world.Surface.supported(waypoint.point, budget);
        if (!point) continue;
        const span = memberSpan(point);
        if (span) entrySpans.set(waypoint.id, span);
    }
    for (const component of areaResult.components) {
        const patches = areaResult.patches.filter(patch => patch.componentId === component.id);
        if (!patches.length || component.status !== 'supported') {
            component.status = 'unresolved';
            component.reason ||= 'no_local_coverage';
            continue;
        }
        const localAnchor = patches[0].anchor;
        const candidates = entryWaypoints.filter(row => row.areaId === polygon.areaId && row.spawnId === polygon.spawnId)
            .sort((a, b) => distance2d(a.point, localAnchor) - distance2d(b.point, localAnchor) || a.id.localeCompare(b.id));
        if (component.nativeBoundary?.status === 'closed'
            && !candidates.some(row => entrySpans.get(row.id)?.componentId === component.id)) {
            // A closed transition boundary does not settle native root/fixed
            // admission inside it. Retain the layer and unresolved coverage.
            component.status = 'unresolved'; component.reason = 'trunk_unproved';
            component.diagnostic = 'closed_boundary_root_admission_not_proven';
            continue;
        }
        const boundedCandidates = candidates.slice(0, Format.LIMITS.maxEntryAnchors);
        if (!candidates.length) {
            component.status = 'unresolved'; component.reason = 'entry_anchor_missing'; continue;
        }
        const farmRegions = input.acceptedTransitRegions.filter(region => region.role === 'farm_access'
            && region.areaId === polygon.areaId && region.spawnId === polygon.spawnId).map(region => region.id);
        const sharedRegions = input.acceptedTransitRegions.filter(region => ['land_road', 'town_approach'].includes(region.role))
            .map(region => region.id);
        const regionIds = [...new Set([...sharedRegions, ...farmRegions])].sort();
        let attached = false, attachedPatch = null;
        for (const waypoint of boundedCandidates) {
            const span = entrySpans.get(waypoint.id);
            const entryPatch = span?.componentId === component.id
                ? patches.find(patch => span.patchIds.includes(patch.id))
                : [...patches].sort((a, b) => distance2d(a.anchor, waypoint.point) - distance2d(b.anchor, waypoint.point)
                    || a.id.localeCompare(b.id))[0];
            if (!entryPatch) continue;
            const localAnchor = entryPatch.anchor;
            const outward = provePath({ from: waypoint.point, to: localAnchor, regionIds,
                context: { areaId: polygon.areaId, spawnId: polygon.spawnId }, world, budget, safety,
                constraints: { maxDistance: Format.LIMITS.localDistance, maxRadius: Format.LIMITS.localRadius } });
            if (outward.status !== 'supported') {
                (component.entryFailures ||= []).push({ anchorId: waypoint.id, direction: 'to_component',
                    reason: outward.reason, diagnostic: outward.diagnostic || null,
                    length: outward.length ?? null, maxXY: outward.maxXY ?? null, evidence: outward.evidence || null });
                continue;
            }
            const returning = provePath({ from: localAnchor, to: waypoint.point, regionIds,
                context: { areaId: polygon.areaId, spawnId: polygon.spawnId }, world, budget, safety,
                constraints: { maxDistance: Format.LIMITS.localDistance, maxRadius: Format.LIMITS.localRadius } });
            if (returning.status !== 'supported') {
                (component.entryFailures ||= []).push({ anchorId: waypoint.id, direction: 'from_component',
                    reason: returning.reason, diagnostic: returning.diagnostic || null,
                    length: returning.length ?? null, maxXY: returning.maxXY ?? null, evidence: returning.evidence || null });
                continue;
            }
            const certIds = [];
            for (const [direction, proof, fromId, toId] of [
                ['to_component', outward, waypoint.id, entryPatch.id],
                ['from_component', returning, entryPatch.id, waypoint.id]]) {
                const id = `entry:${component.id}:${waypoint.id}:${direction}`;
                certificates.push({ id, kind: 'entry_access', requirementId: polygon.spawnId,
                    areaId: polygon.areaId, spawnId: polygon.spawnId,
                    componentId: component.id, direction, anchorId: waypoint.id, patchId: entryPatch.id,
                    fromAnchorId: fromId, toAnchorId: toId, provedNodeCount: proof.nodeCount,
                    pathDistance: proof.length, maxPathDistance: proof.length, coveredLayerCellCount: entryPatch.nodeCount,
                    membershipSpanIndices: [], regionIds, geometry: proof.points });
                certIds.push(id);
            }
            component.entryAnchorIds.push(waypoint.id);
            component.certificateIds = [...(component.certificateIds || []), ...certIds];
            attachments.push({ anchorId: waypoint.id, componentId: component.id, patchId: entryPatch.id,
                direction: 'both', point: waypoint.point });
            attached = true; attachedPatch = entryPatch;
            break;
        }
        if (attached) {
            const internal = input.waypoints.filter(row => row.kind === 'farm_internal'
                && row.areaId === polygon.areaId && row.spawnId === polygon.spawnId)
                .map(row => ({ ...row, point: world.Surface.supported(row.point, budget) }))
                .filter(row => row.point && memberSpan(row.point)?.componentId === component.id);
            const anchors = [...patches.map(patch => ({ id: patch.id, point: patch.anchor, patch })),
                ...internal.map(row => ({ ...row, patch: patches.find(patch => memberSpan(row.point).patchIds.includes(patch.id)) }))];
            const reached = new Set([attachedPatch.id]);
            const attempted = new Set();
            // Entry proves only its own patch. Every other patch needs its own
            // bounded native connectors; authored internal anchors can bridge
            // them without enlarging a patch or inventing straight-line links.
            while (patches.some(patch => !reached.has(patch.id))) {
                const pairs = [];
                for (const from of anchors) if (reached.has(from.id)) for (const to of anchors) {
                    const key = `${from.id}\0${to.id}`, distance = distance2d(from.point, to.point);
                    if (!reached.has(to.id) && !attempted.has(key) && distance <= Format.LIMITS.localRadius) {
                        pairs.push({ from, to, key, distance });
                    }
                }
                pairs.sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key));
                if (!pairs.length) { attached = false; break; }
                const { from, to, key } = pairs[0]; attempted.add(key);
                const proofs = [];
                for (const [source, target] of [[from, to], [to, from]]) {
                    const proof = provePath({ from: source.point, to: target.point, regionIds,
                        context: { areaId: polygon.areaId, spawnId: polygon.spawnId }, world, budget, safety,
                        constraints: { maxDistance: Format.LIMITS.localDistance, maxRadius: Format.LIMITS.localRadius } });
                    if (proof.status !== 'supported') {
                        (component.entryFailures ||= []).push({ anchorId: source.id, toAnchorId: target.id,
                            direction: 'patch_connector', reason: proof.reason, diagnostic: proof.diagnostic || null,
                            length: proof.length ?? null, maxXY: proof.maxXY ?? null, evidence: proof.evidence || null });
                        break;
                    }
                    proofs.push({ source, target, proof });
                }
                if (proofs.length !== 2) continue;
                for (const { source, target, proof } of proofs) {
                    const id = `patch-link:${component.id}:${source.id}:${target.id}`;
                    certificates.push({ id, kind: 'patch_access', requirementId: polygon.spawnId,
                        areaId: polygon.areaId, spawnId: polygon.spawnId, componentId: component.id,
                        direction: 'forward', anchorId: source.id, patchId: target.patch.id,
                        fromAnchorId: source.id, toAnchorId: target.id, provedNodeCount: proof.nodeCount,
                        pathDistance: proof.length, maxPathDistance: proof.length, maxXYRadius: proof.maxXY,
                        coveredLayerCellCount: target.patch.nodeCount, membershipSpanIndices: [], regionIds, geometry: proof.points });
                    component.certificateIds.push(id);
                }
                reached.add(to.id);
            }
        }
        if (!attached) {
            component.status = 'unresolved';
            component.reason = candidates.length > Format.LIMITS.maxEntryAnchors ? 'anchor_limit'
                : regionIds.length ? 'trunk_unproved' : 'unsafe_transit';
        }
        if (component.status === 'supported') for (const patch of patches) attachments.push({
            anchorId: patch.id, componentId: component.id, patchId: patch.id, direction: 'both', point: patch.anchor });
    }
}
function makeTownGateWaypoints(input, selectedTownKeys, TownGateCatalog, initialMap) {
    for (const town of input.requiredTowns) {
        if (!selectedTownKeys.includes(town.townKey)) continue;
        for (const seed of input.waypointSeeds.filter(row => row.townKey === town.townKey)) {
            const gate = TownGateCatalog.gatesFor(town.name).find(row => row.id === seed.gateId);
            if (!gate) throw new Error(`town_gate_source_missing:${seed.id}`);
            for (const side of seed.sides) {
                const id = `${seed.id}:${side}`;
                addWaypoint(initialMap, { id, kind: side === 'inside' ? 'town_gate_inside'
                    : side === 'passage' ? 'town_gate_passage' : 'town_gate_outside', point: gate[side],
                    townKey: town.townKey, provenance: `TownGateCatalog:${seed.id}:${side}`, status: 'unresolved' });
            }
        }
    }
}
function makeServiceCoverage({ input, scope, world, waypoints, budget, safety, certificates, coverage }) {
    const selectedTownKeys = scope.requirementIds.filter(id => input.requiredTowns.some(row => row.townKey === id));
    const serviceRows = createTownServiceRows(world, selectedTownKeys, input.serviceSeedSelection.roles);
    const allTownKeys = Object.keys(world.TownRespawn.towns);
    const allServiceRows = createTownServiceRows(world, allTownKeys, input.serviceSeedSelection.roles);
    const servicesById = new Map(allServiceRows.map(row => [row.id, row]));
    const inventory = [...servicesById.values()];
    const selectedRows = new Set(serviceRows.map(row => row.id));
    for (const service of inventory) {
        if (!selectedRows.has(service.id)) {
            coverage.services.push(makeCoverageEntry('service', service.id, 'unresolved', 'outside_slice'));
            continue;
        }
        const anchors = waypoints.filter(waypoint => ['town_service_approach', 'castellan_approach'].includes(waypoint.kind)
            && (serviceWaypointMatches(waypoint, service, service.id))
            && (!waypoint.townKey || waypoint.townKey === service.townKey));
        if (anchors.length !== 1) {
            coverage.services.push(makeCoverageEntry('service', service.id, 'unresolved', 'service_anchor_missing'));
            continue;
        }
        const anchor = anchors[0], horizontal = distance2d(anchor.point, service.point);
        const vertical = Math.abs(anchor.point.locZ - service.point.locZ);
        const normalized = normalizePoint(anchor.point, world.Geo, world.Surface, budget);
        const serviceLayer = world.Surface.layers(service.point.locX, service.point.locY, budget);
        const serviceFloor = serviceLayer.some(layer => layer.nswe && Math.abs(layer.z - service.point.locZ) <= 128);
        const lineOfSight = serviceFloor && world.Geo.hasGeo(anchor.point.locX, anchor.point.locY)
            && world.Geo.hasGeo(service.point.locX, service.point.locY)
            && world.Geo.hasLineOfSight(anchor.point.locX, anchor.point.locY, anchor.point.locZ,
                service.point.locX, service.point.locY, service.point.locZ);
        const permitted = input.acceptedTransitRegions.filter(region => region.role === 'town_approach'
            && (!region.townKey || region.townKey === service.townKey)).map(region => region.id);
        if (!normalized || horizontal > 96 || vertical > 128 || !lineOfSight || !makePermission(input, permitted)(normalized)) {
            coverage.services.push(makeCoverageEntry('service', service.id, 'unresolved', 'service_approach_unproved'));
            continue;
        }
        const id = `service:${service.id}`;
        certificates.push({ id, kind: 'service_contact', requirementId: service.id, direction: 'contact',
            anchorId: anchor.id, npcSelfId: service.npcSelfId, roles: service.roles,
            xyDistance: horizontal, zDistance: vertical, lineOfSight: true, regionIds: permitted,
            provedNodeCount: 1, pathDistance: horizontal, maxPathDistance: horizontal,
            coveredLayerCellCount: 1, membershipSpanIndices: [] });
        coverage.services.push(makeCoverageEntry('service', service.id, 'supported', null, [id]));
    }
    return inventory;
}

async function build({ sourceFile = Inputs.DEFAULT_SOURCE, geodataDir, outputFile = Inputs.DEFAULT_FILE,
    scope: requestedScope, requirementIds = [], waypointIds = [], connectionIds = [],
    input = null, registered = null, world, artifactRoot = null, budget = new BuildBudget() }) {
    if (!world?.Geo || !world?.Surface || !world?.GatherAreas || !world?.WorldAreaCatalog
        || !world?.RaidBossBalance || !world?.TownRespawn || !world?.TownGateCatalog || !Array.isArray(world.serviceRows)) {
        throw new Error('journey_offline_native_inputs_required');
    }
    for (const [name, file] of Object.entries({ Geo: '../../Geodata/GeodataEngine',
        Surface: '../../Geodata/SpawnSurface', GatherAreas: '../../Lord/GatherAreas',
        WorldAreaCatalog: '../../World/WorldAreaCatalog', RaidBossBalance: '../../RaidBoss/RaidBossBalance' })) {
        if (world[name] !== require(file)) throw new Error(`journey_native_module_identity_mismatch:${name}`);
    }
    budget.poll();
    const authored = input ? { file: path.resolve(sourceFile), input } : await Inputs.readAuthored(sourceFile);
    input = authored.input;
    const scope = Inputs.selectScope(input, { kind: requestedScope,
        requirementIds, waypointIds, connectionIds });
    registered ||= await Inputs.loadRegisteredSources();
    const geometry = Inputs.selectedGeometry(input, scope, registered);
    const initialIdentity = await Inputs.inputIdentity({ sourceFile: authored.file, geodataDir, scope,
        relevantRegions: geometry.regions, loadedGeo: world.Geo, throwOnError: true });
    budget.work.totalGeoBytes = initialIdentity.resourceBytes;
    if (budget.work.totalGeoBytes > Format.LIMITS.maxGeodataBuffers) throw new BuildStop('geodata_buffer_limit', true);
    if (initialIdentity.relevantRegions.length > Format.LIMITS.regionCount) throw new BuildStop('relevant_region_limit', true);
    const safety = buildSafety(world, registered);
    const inputForProof = input;
    world = { ...world, input: inputForProof };
    const selected = nativeWaypoints(input, scope, world, world.TownGateCatalog);
    const waypointMap = new Map(selected.rows.map(row => [row.id, row]));
    const waypoints = [];
    const accessCertificates = [];
    const attachments = [];
    const coverage = { polygons: [], components: [], towns: [], services: [], gates: [], connections: [] };
    const components = [], patches = [], membershipSpans = [], polygonGeometry = [], polygonResults = [];
    const selectedPolygonIds = scope.requirementIds.filter(id => input.requiredPolygons.some(row => row.spawnId === id));
    const areaBySpawn = new Map();
    for (const area of world.GatherAreas.list()) for (const zone of area.zones) areaBySpawn.set(zone.selfId, { area, zone });

    for (const spawnId of selectedPolygonIds) {
        const required = input.requiredPolygons.find(row => row.spawnId === spawnId);
        const located = areaBySpawn.get(spawnId);
        if (!located || located.area.id !== required.areaId) {
            polygonResults.push({ spawnId, status: 'unresolved', reason: 'source_missing', componentIds: [] });
            continue;
        }
        const { area, zone } = located;
        const sourceZone = registered.spawnDefinitions.filter(row => row.selfId === spawnId);
        if (sourceZone.length !== 1) {
            polygonResults.push({ spawnId, status: 'unresolved', reason: 'source_missing', componentIds: [] });
            continue;
        }
        polygonGeometry.push({ areaId: area.id, spawnId, bounds: structuredClone(zone.bounds) });
        const definition = sourceZone[0];
        const polygonRegions = new Set(regionsForBounds(zone.bounds));
        for (const point of [...(definition.spawnAnchors || []), ...(definition.spawns || []).flatMap(spawn => spawn.coords || [])]) {
            polygonRegions.add(`${(point.locX >> 15) + 20}_${(point.locY >> 15) + 18}`);
        }
        if ([...polygonRegions].some(region => !world.Geo.regions?.[region])) {
            polygonResults.push({ spawnId, status: 'unsupported', reason: 'missing_geodata', componentIds: [],
                stats: { bboxCells: 0, examinedCells: 0, admittedLayers: 0 } });
            continue;
        }
        if (safety.unknown.length) {
            polygonResults.push({ spawnId, status: 'unresolved', reason: 'unsafe_transit', componentIds: [],
                stats: { bboxCells: 0, examinedCells: 0, admittedLayers: 0 } });
            continue;
        }
        const admission = require('../../Geodata/SpawnPlacement').journeyAdmission(definition);
        budget.beginPolygon(spawnId);
        let decomposed;
        try {
            decomposed = Components.decomposePolygon({ areaId: area.id, spawnId, bounds: zone.bounds,
                admission, fingerprint: initialIdentity.fingerprint,
                Geo: world.Geo, Surface: world.Surface, budget,
                areaContains: point => world.GatherAreas.containsZone(zone, point),
                excludePoint: safety.point });
        } catch (error) {
            if (!(error instanceof BuildStop) || error.global) throw error;
            decomposed = { status: 'unresolved', reason: 'limit_reached', nodes: [], components: [], patches: [], spans: [],
                stats: { components: 0, localPatches: 0 }, excluded: {}, diagnostic: String(error.message || error).slice(0, 200) };
        } finally { budget.endPolygon(); }
        const spanOffset = membershipSpans.length;
        const componentRows = decomposed.components || [];
        if (componentRows.length) decomposed.rootAdmission = accountAdmissionRoots(decomposed, registered, world, budget);
        const polygonEntryCandidates = selected.rows.filter(row => row.kind === 'farm_entry'
            && row.areaId === area.id && row.spawnId === spawnId);
        try {
            attachComponentEntries({ areaId: area.id, spawnId }, decomposed, polygonEntryCandidates,
                input, world, budget, safety, accessCertificates, attachments);
        } catch (error) {
            if (!(error instanceof BuildStop) || error.global) throw error;
            for (const component of componentRows) {
                component.status = 'unresolved'; component.reason = 'limit_reached';
                component.diagnostic = error.reason;
            }
        }
        certifyNativeAdmission(decomposed, world, budget, accessCertificates);
        const spansForPolygon = decomposed.spans || [];
        const spanIndex = new Map();
        membershipSpans.push(...spansForPolygon);
        for (let i = 0; i < spansForPolygon.length; i++) spanIndex.set(i, spanOffset + i);
        const patchRows = decomposed.patches || [];
        for (const patch of patchRows) {
            const outputPatch = { ...patch, membershipSpanIndices: (patch.membershipSpanIndices || []).map(index => spanIndex.get(index))
                .filter(Number.isInteger) };
            delete outputPatch.members;
            delete outputPatch.anchorNode;
            patches.push(outputPatch);
            const id = `local:${patch.id}`;
            const localCert = { id, kind: 'local_patch', requirementId: spawnId,
                areaId: area.id, spawnId, componentId: patch.componentId,
                direction: 'both', anchorId: patch.id, patchId: patch.id,
                provedNodeCount: patch.nodeCount, pathDistance: patch.maxPathDistance,
                maxPathDistance: patch.maxPathDistance, coveredLayerCellCount: patch.nodeCount,
                membershipSpanIndices: outputPatch.membershipSpanIndices };
            accessCertificates.push(localCert);
        }
        for (const component of componentRows) {
            component.certificateIds = [...(component.certificateIds || []), ...patchRows.filter(row => row.componentId === component.id)
                .map(row => `local:${row.id}`)].sort();
            components.push(component);
            coverage.components.push(makeCoverageEntry('component', component.id, component.status, component.reason,
                component.certificateIds));
        }
        const allComponentsSupported = componentRows.length > 0 && componentRows.every(row => row.status === 'supported'
            || row.status === 'unsupported' && row.nativeAdmission?.status === 'excluded');
        let polygonStatus = decomposed.status, polygonReason = decomposed.reason;
        if (!allComponentsSupported) {
            polygonStatus = 'unresolved'; polygonReason = componentRows.find(row => row.status !== 'supported')?.reason
                || polygonReason || 'no_local_coverage';
        }
        const componentIds = componentRows.map(row => row.id);
        const componentCertificates = componentRows.flatMap(row => row.certificateIds || []);
        polygonResults.push({ spawnId, status: polygonStatus, reason: polygonReason, componentIds,
            certificateIds: componentCertificates,
            stats: decomposed.stats, excluded: decomposed.excluded, rootAdmission: decomposed.rootAdmission || null });
        const unresolvedReason = polygonStatus === 'unresolved' && decomposed.stats?.unresolvedBoundaryFragments
            ? 'boundary_fragment_unresolved' : polygonReason;
        if (polygonResults.at(-1).reason !== unresolvedReason) polygonResults.at(-1).reason = unresolvedReason;
        for (const certificate of accessCertificates) if (certificate.areaId === area.id && certificate.spawnId === spawnId) {
            certificate.membershipSpanIndices ||= [];
        }
        if (membershipSpans.length > Format.LIMITS.rowSpans) throw new BuildStop('membership_span_limit', true);
        budget.assertHealthy();
    }
    coverage.polygons = makePolygonCoverage(input, scope, polygonResults);

    const gatewayData = selectedTownGateWaypoints(input, scope,
        new Set(selected.selectedTownKeys), world.TownGateCatalog, world.TownRespawn,
        new Map(input.waypoints.map(row => [row.id, row])));
    for (const row of gatewayData.values()) {
        if (!waypointMap.has(row.id)) waypointMap.set(row.id, row);
    }
    buildTownProofs({ input, scope, world, budget, safety, waypointMap, accessCertificates, coverage });
    const generatedTrunks = [];
    for (const connection of input.trunks) {
        if (!scope.connectionIds.includes(connection.id)) {
            coverage.connections.push(makeCoverageEntry('connection', connection.id, 'unresolved', 'outside_slice'));
            continue;
        }
        const result = certifyTrunk({ connection, waypoints: waypointMap, input, world, budget, safety,
            certificates: accessCertificates });
        if (result.status === 'supported') {
            const { certificateId, componentIds, regionIds, ...trunk } = result;
            trunk.componentIds = componentIds;
            trunk.chunkOffsets = [];
            let cumulative = 0;
            for (let i = 0; i < trunk.points.length; i++) {
                if (i === 0 || cumulative >= 4096) { trunk.chunkOffsets.push(i); cumulative = 0; }
                if (i > 0) cumulative += Math.hypot(trunk.points[i][0] - trunk.points[i - 1][0],
                    trunk.points[i][1] - trunk.points[i - 1][1]);
            }
            trunk.certificateIds = [certificateId];
            trunk.transitRegionIds = regionIds;
            trunk.id = connection.id;
            // The catalogue stores tuples to keep the immutable route geometry compact.
            trunk.points = trunk.points.map(point => point.map(value => Math.round(value)));
            trunk.coverageStatus = 'supported';
            coverage.connections.push(makeCoverageEntry('connection', connection.id, 'supported', null, [certificateId]));
            generatedTrunks.push(trunk);
        } else coverage.connections.push({ ...makeCoverageEntry('connection', connection.id, result.status, result.reason),
            diagnostic: result.diagnostic || null, evidence: result.evidence || null });
    }
    const services = makeServiceCoverage({ input, scope, world, waypoints: [...waypointMap.values()], budget, safety,
        certificates: accessCertificates, coverage });
    const requirements = requirementsSnapshot(input);
    requirements.serviceInventory = services;
    waypoints.push(...[...waypointMap.values()].map(row => {
        const surface = normalizePoint(row.point, world.Geo, world.Surface, budget);
        return { ...row, point: surface || row.point, status: surface ? 'supported' : 'unresolved',
            reason: surface ? null : 'no_admitted_surface' };
    }));

    const sortedSpans = membershipSpans.sort((a, b) => a.areaId.localeCompare(b.areaId)
        || a.spawnId.localeCompare(b.spawnId) || a.layerZ - b.layerZ || a.rowY - b.rowY
        || a.xStart - b.xStart || a.xEnd - b.xEnd || a.componentId.localeCompare(b.componentId));
    if (sortedSpans.length > Format.LIMITS.rowSpans) throw new BuildStop('membership_span_limit', true);
    const spansByPatch = new Map();
    for (let index = 0; index < sortedSpans.length; index++) for (const patchId of sortedSpans[index].patchIds) {
        if (!spansByPatch.has(patchId)) spansByPatch.set(patchId, []);
        spansByPatch.get(patchId).push(index);
    }
    for (const patch of patches) patch.membershipSpanIndices = spansByPatch.get(patch.id) || [];
    const componentPatchIds = new Map(components.map(component => [component.id, component.patchIds]));
    for (const certificate of accessCertificates) {
        if (certificate.patchId) certificate.membershipSpanIndices = spansByPatch.get(certificate.patchId) || [];
        else if (certificate.componentId) {
            certificate.membershipSpanIndices = [...new Set((componentPatchIds.get(certificate.componentId) || [])
                .flatMap(id => spansByPatch.get(id) || []))].sort((a, b) => a - b);
        }
    }

    const unresolved = [];
    for (const entry of [...coverage.polygons, ...coverage.components, ...coverage.towns,
        ...coverage.gates, ...coverage.services, ...coverage.connections]) if (entry.status !== 'supported') unresolved.push(entry);
    const record = {
        schemaVersion: Format.SCHEMA_VERSION,
        algorithmVersion: Format.ALGORITHM_VERSION,
        scope,
        inputFingerprint: initialIdentity.fingerprint,
        checksum: '',
        inputs: initialIdentity.inputs,
        requirements,
        coverage,
        polygons: polygonGeometry,
        waypoints: waypoints.sort((a, b) => a.id.localeCompare(b.id)),
        components: components.sort((a, b) => a.id.localeCompare(b.id)),
        patches: patches.sort((a, b) => a.id.localeCompare(b.id)),
        membershipSpans: sortedSpans,
        trunks: (generatedTrunks || []).sort((a, b) => a.id.localeCompare(b.id)),
        attachments: attachments.sort((a, b) => a.anchorId.localeCompare(b.anchorId)
            || a.componentId.localeCompare(b.componentId) || a.direction.localeCompare(b.direction)),
        certificates: accessCertificates.sort((a, b) => a.id.localeCompare(b.id)),
        unresolved: unresolved.sort((a, b) => a.kind.localeCompare(b.kind) || a.requirementId.localeCompare(b.requirementId)),
        buildStats: budget.summary()
    };
    record.checksum = Format.checksumOf(record);
    budget.assertHealthy();
    const finalIdentity = await Inputs.inputIdentity({ sourceFile: authored.file, geodataDir, scope,
        relevantRegions: initialIdentity.relevantRegions, loadedGeo: world.Geo, throwOnError: true });
    if (finalIdentity.fingerprint !== initialIdentity.fingerprint) throw new Error('journey_inputs_changed_before_publication');
    record.buildStats.elapsedMs = Math.round(performance.now() - budget.startedAt);
    record.buildStats.maxRssBytes = Math.max(record.buildStats.maxRssBytes, process.memoryUsage.rss());
    record.checksum = Format.checksumOf(record);
    if (artifactRoot) {
        await fs.mkdir(artifactRoot, { recursive: true });
        await fs.writeFile(path.join(artifactRoot, 'journey-routes-proof-summary.json'), JSON.stringify({
            inputFingerprint: record.inputFingerprint, polygonResults, components, patches,
            coverage, safetyUnknown: safety.unknown, buildStats: record.buildStats
        }, null, 2));
    }
    await Format.validateRecord(record, initialIdentity);
    budget.assertHealthy();
    const requiredFailures = [
        ...coverage.polygons.filter(row => scope.requirementIds.includes(row.requirementId) && row.status !== 'supported'),
        ...coverage.connections.filter(row => scope.connectionIds.includes(row.requirementId) && row.status !== 'supported')
    ];
    const complete = requiredFailures.length === 0;
    let emittedFile = null;
    if (complete) emittedFile = path.resolve(outputFile);
    else if (artifactRoot) emittedFile = path.resolve(artifactRoot, 'journey-routes-incomplete.json');
    if (emittedFile) await publishAtomically(emittedFile, record);
    return { record, summary: { status: complete ? 'ready' : 'incomplete',
        reason: complete ? null : 'required_slice_proofs_incomplete',
        outputFile: complete ? emittedFile : null, diagnosticFile: complete ? null : emittedFile,
        requiredFailures, checksum: record.checksum,
        inputFingerprint: record.inputFingerprint, scope, coverage: {
            supported: unresolved.length === 0,
            supportedPolygons: coverage.polygons.filter(row => row.status === 'supported').length,
            unresolvedPolygons: coverage.polygons.filter(row => row.status === 'unresolved').length,
            unsupportedPolygons: coverage.polygons.filter(row => row.status === 'unsupported').length,
            components: components.length, patches: patches.length, trunks: record.trunks.length,
            nativeExcludedComponents: components.filter(c => c.nativeAdmission?.status === 'excluded').length,
            nativeExcludedLayers: components.filter(c => c.nativeAdmission?.status === 'excluded').reduce((sum, c) => sum + c.nodeCount, 0),
            unresolvedRequirements: unresolved.filter(row => row.status === 'unresolved').length,
            unsupportedRequirements: unresolved.filter(row => row.status === 'unsupported').length
        }, buildStats: record.buildStats } };
}

async function publishAtomically(outputFile, record) {
    const target = path.resolve(outputFile);
    const directory = path.dirname(target);
    const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    let created = false;
    try {
        await fs.mkdir(directory, { recursive: true });
        const text = `${Format.canonicalStringify(record)}\n`;
        if (Buffer.byteLength(text) > Format.LIMITS.generatedBytes) throw new Error('generated_size_limit_exceeded');
        const handle = await fs.open(temporary, 'wx', 0o600);
        created = true;
        try { await handle.writeFile(text); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, target);
        created = false;
    } finally {
        if (created) {
            try { await fs.unlink(temporary); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
}

module.exports = { BuildBudget, build, publishAtomically, provePath, raidExclusions };
});
