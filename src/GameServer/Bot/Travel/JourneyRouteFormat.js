require('../../Geodata/JourneyGeometryIdentity.js').define(module, require, function (module, exports, require, __filename, __dirname) {
'use strict';

const { createHash } = require('node:crypto');

const SCHEMA_VERSION = 1;
const ALGORITHM_VERSION = 'journey-route-p2.1';
const LIMITS = Object.freeze({
    authoredBytes: 1024 * 1024,
    generatedBytes: 10 * 1024 * 1024,
    waypoints: 256,
    trunks: 4096,
    regionCount: 64,
    vertices: 50000,
    trunkVertices: 2048,
    trunkLength: 6000,
    rowSpans: 131072,
    components: 4096,
    overlapSpansPerPoint: 16,
    attachmentReferencesPerBucket: 16,
    attachmentBuckets: 27,
    attachmentCandidates: 3,
    localNodes: 30000,
    localDistance: 4096,
    localRadius: 2048,
    maxEntryAnchors: 8,
    maxPatches: 16,
    maxSearches: 4096,
    maxSearchExpansions: 50000000,
    maxSearchExpansionsPerCall: 120000,
    maxSearchMsPerCall: 2000,
    maxPolygonMs: 60000,
    maxBuildMs: 900000,
    maxBuildRss: 1536 * 1024 * 1024,
    maxGeodataBuffers: 512 * 1024 * 1024,
    maxLoaderMs: 10000,
    maxLoaderRss: 128 * 1024 * 1024,
    maxRetainedRss: 32 * 1024 * 1024,
    maxBatchRecords: 4096
});

const STATUSES = new Set(['supported', 'unsupported', 'unresolved']);
const REASONS = new Set([
    'component_scan_pending', 'town_access_pending', 'source_missing', 'input_identity_mismatch',
    'missing_geodata', 'missing_geodata_region', 'unsafe_transit', 'no_path_in_declared_domain',
    'anchor_limit', 'limit_reached', 'ambiguous_layer', 'no_admitted_surface', 'no_local_coverage',
    'service_anchor_missing', 'service_approach_unproved', 'trunk_unproved', 'excluded_dungeon',
    'excluded_raid', 'invalid_geometry', 'region_limit', 'work_limit', 'invalid_input',
    'outside_slice', 'boundary_fragment_unresolved', 'not_selected', 'entry_anchor_missing',
    'membership_overlap_limit', 'ambiguous_component_membership', 'polygon_geometry_missing',
    'non_integral_native_cell', 'no_admitted_layer', 'candidate_unproved'
]);

function canonicalStringify(value) {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonical_json_non_finite_number');
        if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
            throw new TypeError('canonical_json_unsupported_value');
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function checksumOf(record) {
    const { checksum, ...body } = record;
    return sha256(canonicalStringify(body));
}
async function canonicalDigest(value, omitRootChecksum = false, checkpoint = null) {
    const hash = createHash('sha256');
    let bytes = 0, count = 0;
    const batch = [];
    const emit = text => { batch.push(text); bytes += Buffer.byteLength(text); };
    const scalar = node => {
        if (typeof node === 'number' && !Number.isFinite(node)) throw new TypeError('canonical_json_non_finite_number');
        if (typeof node === 'undefined' || typeof node === 'function' || typeof node === 'symbol' || typeof node === 'bigint') {
            throw new TypeError('canonical_json_unsupported_value');
        }
        emit(JSON.stringify(node));
    };
    // Only ancestor containers need traversal frames. A promise/generator per
    // scalar token needlessly expands the heap while hashing the same bytes.
    const enter = (node, root = false) => {
        const array = Array.isArray(node);
        const keys = array ? null : Object.keys(node).filter(key => !(root && omitRootChecksum && key === 'checksum')).sort();
        emit(array ? '[' : '{');
        return { node, keys, index: 0, length: array ? node.length : keys.length };
    };
    const stack = [];
    if (value !== null && typeof value === 'object') stack.push(enter(value, true));
    else scalar(value);
    while (stack.length) {
        const frame = stack[stack.length - 1];
        if (frame.index === frame.length) {
            emit(frame.keys ? '}' : ']'); stack.pop();
        } else {
            if (frame.index) emit(',');
            const key = frame.keys ? frame.keys[frame.index] : frame.index;
            if (frame.keys) emit(`${JSON.stringify(key)}:`);
            frame.index++;
            const node = frame.node[key];
            if (node !== null && typeof node === 'object') stack.push(enter(node));
            else scalar(node);
        }
        if (++count === LIMITS.maxBatchRecords) {
            hash.update(batch.join('')); batch.length = 0; count = 0;
            if (checkpoint) await checkpoint(LIMITS.maxBatchRecords);
            else await new Promise(resolve => setImmediate(resolve));
        }
    }
    if (batch.length) hash.update(batch.join(''));
    return { sha256: hash.digest('hex'), bytes };
}
async function checksumOfAsync(record) {
    return (await canonicalDigest(record, true)).sha256;
}

// JSON.parse silently accepts duplicate object members. The small authored and
// generated formats are parsed strictly so a shadowed safety field cannot pass
// validation with a different meaning in another tool.
function parseStrictJson(text, label = 'json') {
    let index = 0;
    const fail = reason => { throw new Error(`${label}:${reason}@${index}`); };
    const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    const whitespace = () => {
        while (index < text.length) {
            const code = text.charCodeAt(index);
            if (code !== 9 && code !== 10 && code !== 13 && code !== 32) break;
            index++;
        }
    };
    const string = (decode = true) => {
        if (text[index] !== '"') fail('expected_string');
        const start = index++;
        while (index < text.length) {
            const char = text[index++];
            if (char === '"') {
                if (!decode) return;
                try { return JSON.parse(text.slice(start, index)); }
                catch (_) { fail('invalid_string'); }
            }
            if (char === '\\') {
                if (index >= text.length) fail('invalid_escape');
                index++;
            } else if (char.charCodeAt(0) < 0x20) fail('control_in_string');
        }
        fail('unterminated_string');
    };
    const value = depth => {
        if (depth > 128) fail('nesting_limit');
        whitespace();
        const char = text[index];
        if (char === '"') return string(false);
        if (char === '{') {
            index++;
            whitespace();
            const keys = new Set();
            if (text[index] === '}') { index++; return; }
            for (;;) {
                whitespace();
                const key = string();
                if (keys.has(key)) fail(`duplicate_member:${key}`);
                if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail(`forbidden_member:${key}`);
                keys.add(key);
                whitespace();
                if (text[index++] !== ':') fail('expected_colon');
                value(depth + 1);
                whitespace();
                const separator = text[index++];
                if (separator === '}') return;
                if (separator !== ',') fail('expected_object_separator');
            }
        }
        if (char === '[') {
            index++;
            whitespace();
            if (text[index] === ']') { index++; return; }
            for (;;) {
                value(depth + 1);
                whitespace();
                const separator = text[index++];
                if (separator === ']') return;
                if (separator !== ',') fail('expected_array_separator');
            }
        }
        if (char === 't' && text.slice(index, index + 4) === 'true') { index += 4; return true; }
        if (char === 'f' && text.slice(index, index + 5) === 'false') { index += 5; return false; }
        if (char === 'n' && text.slice(index, index + 4) === 'null') { index += 4; return null; }
        numberPattern.lastIndex = index;
        const match = numberPattern.exec(text);
        if (!match) fail('invalid_value');
        index += match[0].length;
        const number = Number(match[0]);
        if (!Number.isFinite(number)) fail('non_finite_number');
        return number;
    };
    value(0);
    whitespace();
    if (index !== text.length) fail('trailing_data');
    // The scanner retains only ancestor key sets. Native JSON.parse builds one
    // compact tree after duplicate/forbidden-key checks, not a parallel set of
    // dictionary objects and growable coordinate arrays.
    try { return JSON.parse(text); }
    catch (_) { fail('invalid_json'); }
}

function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function finitePoint(point) {
    return isRecord(point) && ['locX', 'locY', 'locZ'].every(key => Number.isFinite(point[key]));
}
function uniqueIds(rows, label, key = 'id') {
    if (!Array.isArray(rows)) throw new Error(`${label}:expected_array`);
    const seen = new Set();
    for (const row of rows) {
        if (!isRecord(row) || typeof row[key] !== 'string' || !row[key]) throw new Error(`${label}:invalid_${key}`);
        if (seen.has(row[key])) throw new Error(`${label}:duplicate_${row[key]}`);
        seen.add(row[key]);
    }
    return seen;
}
function ref(value, set, label) {
    if (typeof value !== 'string' || !set.has(value)) throw new Error(`${label}:unknown_reference:${value}`);
}
function validateTransitRegion(region, label) {
    if (!isRecord(region) || typeof region.id !== 'string' || !region.id || !Array.isArray(region.polygon)
        || region.polygon.length < 3 || region.polygon.length > 256
        || region.polygon.some(p => !isRecord(p) || !Number.isFinite(p.locX) || !Number.isFinite(p.locY))
        || !Number.isFinite(region.minZ) || !Number.isFinite(region.maxZ) || region.minZ > region.maxZ
        || !['land_road', 'town_approach', 'farm_access', 'deny'].includes(region.role)
        || typeof region.source !== 'string' || !region.source || typeof region.reason !== 'string' || !region.reason) {
        throw new Error(`${label}:invalid_transit_region`);
    }
}
function validateAuthored(input) {
    if (!isRecord(input) || input.schemaVersion !== SCHEMA_VERSION || !['requirements_only', 'slice_candidates'].includes(input.state)) {
        throw new Error('authored_schema_or_state_invalid');
    }
    if (!Array.isArray(input.requiredAreas) || input.requiredAreas.length !== 5
        || !Array.isArray(input.requiredPolygons) || input.requiredPolygons.length !== 189
        || !Array.isArray(input.requiredTowns) || input.requiredTowns.length !== 16
        || !Array.isArray(input.waypointSeeds) || input.waypointSeeds.length !== 23
        || !isRecord(input.serviceSeedSelection) || !Array.isArray(input.serviceSeedSelection.roles)
        || input.serviceSeedSelection.includeCastellan !== true) throw new Error('authored_requirement_inventory_incomplete');
    const serviceRoles = ['gatekeeper', 'seller', 'generic_merchant', 'warehouse'];
    if (input.serviceSeedSelection.roles.length !== serviceRoles.length
        || new Set(input.serviceSeedSelection.roles).size !== serviceRoles.length
        || serviceRoles.some(role => !input.serviceSeedSelection.roles.includes(role))) throw new Error('serviceSeedSelection:invalid_roles');
    const areaIds = uniqueIds(input.requiredAreas, 'requiredAreas');
    const expectedAreaCounts = new Map([['ruins_of_agony', 18], ['ruins_of_despair', 9],
        ['abandoned_camp', 37], ['langk_lizardmen', 26], ['wasteland', 99]]);
    if ([...areaIds].some(id => !expectedAreaCounts.has(id))) throw new Error('requiredAreas:unknown_area');
    const actualAreaCounts = new Map([...areaIds].map(id => [id, 0]));
    const polygonIds = new Set();
    for (const row of input.requiredPolygons) {
        if (!isRecord(row) || typeof row.areaId !== 'string' || typeof row.spawnId !== 'string'
            || !STATUSES.has(row.status) || typeof row.reason !== 'string') throw new Error('requiredPolygons:invalid_record');
        if (!areaIds.has(row.areaId)) throw new Error(`requiredPolygons:unknown_area:${row.areaId}`);
        if (polygonIds.has(row.spawnId)) throw new Error(`requiredPolygons:duplicate_${row.spawnId}`);
        polygonIds.add(row.spawnId);
        actualAreaCounts.set(row.areaId, actualAreaCounts.get(row.areaId) + 1);
    }
    for (const [areaId, expected] of expectedAreaCounts) {
        if (!areaIds.has(areaId) || actualAreaCounts.get(areaId) !== expected) throw new Error(`requiredPolygons:count_mismatch:${areaId}`);
    }
    if (polygonIds.has('gludio_t18_21_009')) throw new Error('requiredPolygons:excluded_duplicate_agony_spawn');
    const townIds = new Set();
    for (const row of input.requiredTowns) {
        if (!isRecord(row) || typeof row.townKey !== 'string' || !row.townKey
            || !finitePoint(row.seedPoint) || !STATUSES.has(row.status) || typeof row.reason !== 'string'
            || typeof row.restartTownKey !== 'string') throw new Error('requiredTowns:invalid_record');
        if (townIds.has(row.townKey)) throw new Error(`requiredTowns:duplicate_${row.townKey}`);
        townIds.add(row.townKey);
    }
    const gateIds = new Set();
    for (const gate of input.waypointSeeds) {
        if (!isRecord(gate) || typeof gate.id !== 'string' || !gate.id || gate.source !== 'townGates'
            || !townIds.has(gate.townKey) || typeof gate.gateId !== 'string'
            || !Array.isArray(gate.sides) || gate.sides.length !== 3
            || gate.sides.join(',') !== 'inside,passage,outside' || gateIds.has(gate.id)) {
            throw new Error('waypointSeeds:invalid_or_duplicate_gate');
        }
        gateIds.add(gate.id);
    }
    if (!Array.isArray(input.acceptedTransitRegions) || !Array.isArray(input.rejectedTransitRegions)
        || input.acceptedTransitRegions.length + input.rejectedTransitRegions.length > 128) throw new Error('transitRegions:limit_exceeded');
    let authoredVertices = 0;
    for (const region of input.acceptedTransitRegions) {
        validateTransitRegion(region, 'acceptedTransitRegions'); authoredVertices += region.polygon.length;
    }
    for (const region of input.rejectedTransitRegions) {
        validateTransitRegion(region, 'rejectedTransitRegions'); authoredVertices += region.polygon.length;
    }
    const waypoints = uniqueIds(input.waypoints, 'waypoints');
    if (input.waypoints.length > LIMITS.waypoints) throw new Error('waypoints:limit_exceeded');
    for (const waypoint of input.waypoints) {
        if (!finitePoint(waypoint.point) || !['town_seed', 'town_gate_inside', 'town_gate_passage', 'town_gate_outside',
            'town_service_approach', 'castellan_approach', 'road_junction', 'farm_entry', 'farm_internal'].includes(waypoint.kind)
            || typeof waypoint.provenance !== 'string' || !waypoint.provenance) throw new Error(`waypoint:${waypoint.id}:invalid`);
        if (waypoint.areaId && !input.requiredAreas.some(area => area.id === waypoint.areaId)) throw new Error(`waypoint:${waypoint.id}:unknown_area`);
        if (waypoint.spawnId && !polygonIds.has(waypoint.spawnId)) throw new Error(`waypoint:${waypoint.id}:unknown_polygon`);
        if (waypoint.townKey && !townIds.has(waypoint.townKey)) throw new Error(`waypoint:${waypoint.id}:unknown_town`);
    }
    const regionIds = new Set();
    for (const region of [...(input.acceptedTransitRegions || []), ...(input.rejectedTransitRegions || [])]) {
        if (regionIds.has(region.id)) throw new Error(`transitRegions:duplicate_${region.id}`);
        regionIds.add(region.id);
    }
    const trunks = uniqueIds(input.trunks, 'trunks');
    if (input.trunks.length > LIMITS.trunks) throw new Error('trunks:limit_exceeded');
    for (const trunk of input.trunks) {
        ref(trunk.from, waypoints, `trunk:${trunk.id}:from`);
        ref(trunk.to, waypoints, `trunk:${trunk.id}:to`);
        if (trunk.from === trunk.to || !Array.isArray(trunk.transitRegionIds)
            || trunk.transitRegionIds.some(id => !regionIds.has(id))) throw new Error(`trunk:${trunk.id}:invalid`);
    }
    if (authoredVertices > LIMITS.vertices) throw new Error('transitRegions:vertex_limit_exceeded');
    return { polygonIds, townIds, waypointIds: waypoints, trunkIds: trunks };
}

async function validateAuthoredBatched(input, checkpoint) {
    if (!isRecord(input) || input.schemaVersion !== SCHEMA_VERSION || !['requirements_only', 'slice_candidates'].includes(input.state)
        || !Array.isArray(input.requiredAreas) || input.requiredAreas.length !== 5
        || !Array.isArray(input.requiredPolygons) || input.requiredPolygons.length !== 189
        || !Array.isArray(input.requiredTowns) || input.requiredTowns.length !== 16
        || !Array.isArray(input.waypointSeeds) || input.waypointSeeds.length !== 23
        || !isRecord(input.serviceSeedSelection) || input.serviceSeedSelection.includeCastellan !== true
        || !Array.isArray(input.serviceSeedSelection.roles)) throw new Error('authored_requirement_inventory_incomplete');
    const serviceRoles = ['gatekeeper', 'seller', 'generic_merchant', 'warehouse'];
    if (input.serviceSeedSelection.roles.length !== serviceRoles.length
        || new Set(input.serviceSeedSelection.roles).size !== serviceRoles.length
        || serviceRoles.some(role => !input.serviceSeedSelection.roles.includes(role))) throw new Error('serviceSeedSelection:invalid_roles');
    const areas = new Set(), polygons = new Set(), towns = new Set(), gates = new Set();
    for (const area of input.requiredAreas) {
        const pending = checkpoint(); if (pending) await pending;
        if (!isRecord(area) || typeof area.id !== 'string' || !area.id || areas.has(area.id)) throw new Error('requiredAreas:invalid');
        areas.add(area.id);
    }
    const expectedCounts = new Map([['ruins_of_agony', 18], ['ruins_of_despair', 9],
        ['abandoned_camp', 37], ['langk_lizardmen', 26], ['wasteland', 99]]);
    const counts = new Map([...areas].map(id => [id, 0]));
    for (const row of input.requiredPolygons) {
        const pending = checkpoint(); if (pending) await pending;
        if (!isRecord(row) || !areas.has(row.areaId) || typeof row.spawnId !== 'string' || !row.spawnId
            || !STATUSES.has(row.status) || typeof row.reason !== 'string' || polygons.has(row.spawnId)) {
            throw new Error('requiredPolygons:invalid');
        }
        polygons.add(row.spawnId); counts.set(row.areaId, counts.get(row.areaId) + 1);
    }
    for (const [id, count] of expectedCounts) if (!areas.has(id) || counts.get(id) !== count) throw new Error(`requiredPolygons:count_mismatch:${id}`);
    if (polygons.has('gludio_t18_21_009')) throw new Error('requiredPolygons:excluded_duplicate_agony_spawn');
    for (const row of input.requiredTowns) {
        const pending = checkpoint(); if (pending) await pending;
        if (!isRecord(row) || typeof row.townKey !== 'string' || !row.townKey || towns.has(row.townKey)
            || !finitePoint(row.seedPoint) || !STATUSES.has(row.status) || typeof row.reason !== 'string'
            || typeof row.restartTownKey !== 'string') throw new Error('requiredTowns:invalid');
        towns.add(row.townKey);
    }
    for (const gate of input.waypointSeeds) {
        const pending = checkpoint(); if (pending) await pending;
        if (!isRecord(gate) || typeof gate.id !== 'string' || !gate.id || gates.has(gate.id)
            || gate.source !== 'townGates' || !towns.has(gate.townKey) || typeof gate.gateId !== 'string'
            || !Array.isArray(gate.sides) || gate.sides.join(',') !== 'inside,passage,outside') throw new Error('waypointSeeds:invalid');
        gates.add(gate.id);
    }
    if (!Array.isArray(input.acceptedTransitRegions) || !Array.isArray(input.rejectedTransitRegions)
        || input.acceptedTransitRegions.length + input.rejectedTransitRegions.length > 128) throw new Error('transitRegions:limit_exceeded');
    const regionIds = new Set();
    let vertices = 0;
    for (const region of [...input.acceptedTransitRegions, ...input.rejectedTransitRegions]) {
        const pending = checkpoint(); if (pending) await pending;
        if (!isRecord(region) || typeof region.id !== 'string' || !region.id || regionIds.has(region.id)
            || !Array.isArray(region.polygon) || region.polygon.length < 3 || region.polygon.length > 256
            || !Number.isFinite(region.minZ) || !Number.isFinite(region.maxZ) || region.minZ > region.maxZ
            || !['land_road', 'town_approach', 'farm_access', 'deny'].includes(region.role)
            || typeof region.source !== 'string' || !region.source || typeof region.reason !== 'string' || !region.reason) {
            throw new Error('transitRegions:invalid');
        }
        regionIds.add(region.id); vertices += region.polygon.length;
        for (const point of region.polygon) {
            const pending = checkpoint(); if (pending) await pending;
            if (!isRecord(point) || !Number.isFinite(point.locX) || !Number.isFinite(point.locY)) throw new Error('transitRegions:invalid_vertex');
        }
    }
    if (vertices > LIMITS.vertices) throw new Error('transitRegions:vertex_limit_exceeded');
    if (!Array.isArray(input.waypoints) || input.waypoints.length > LIMITS.waypoints) throw new Error('waypoints:limit_exceeded');
    const waypointIds = new Set();
    for (const waypoint of input.waypoints) {
        const pending = checkpoint(); if (pending) await pending;
        if (!isRecord(waypoint) || typeof waypoint.id !== 'string' || !waypoint.id || waypointIds.has(waypoint.id)
            || !finitePoint(waypoint.point) || typeof waypoint.provenance !== 'string' || !waypoint.provenance
            || waypoint.areaId && !areas.has(waypoint.areaId) || waypoint.spawnId && !polygons.has(waypoint.spawnId)
            || waypoint.townKey && !towns.has(waypoint.townKey)) throw new Error('waypoints:invalid');
        waypointIds.add(waypoint.id);
    }
    if (!Array.isArray(input.trunks) || input.trunks.length > LIMITS.trunks) throw new Error('trunks:limit_exceeded');
    const trunkIds = new Set();
    for (const trunk of input.trunks) {
        const pending = checkpoint(); if (pending) await pending;
        if (!isRecord(trunk) || typeof trunk.id !== 'string' || !trunk.id || trunkIds.has(trunk.id)
            || !waypointIds.has(trunk.from) || !waypointIds.has(trunk.to) || trunk.from === trunk.to
            || !Array.isArray(trunk.transitRegionIds) || trunk.transitRegionIds.some(id => !regionIds.has(id))) {
            throw new Error('trunks:invalid');
        }
        trunkIds.add(trunk.id);
    }
}

async function validateRecord(record, expectedIdentity = null, loadContext = {}) {
    const baselineRss = loadContext.baselineRss ?? process.memoryUsage.rss();
    const startedAtWallMs = loadContext.startedAtWallMs ?? Date.now();
    let checked = 0;
    function checkBudget() {
        if (Date.now() - startedAtWallMs > LIMITS.maxLoaderMs) throw new Error('loader_wall_limit');
        if (process.memoryUsage.rss() - baselineRss > LIMITS.maxLoaderRss) throw new Error('loader_additional_rss_limit');
    }
    // Fast checkpoints return no promise: awaiting every scalar creates a
    // whole validation pass of temporary promises without yielding to I/O.
    function checkpoint(count = 1) {
        let pending;
        if (loadContext.checkpoint) pending = loadContext.checkpoint(count);
        else {
            checked += count;
            if (checked >= LIMITS.maxBatchRecords) {
                checked %= LIMITS.maxBatchRecords;
                pending = new Promise(resolve => setImmediate(resolve));
            }
        }
        if (pending) return Promise.resolve(pending).then(checkBudget);
        checkBudget();
    }
    async function unique(rows, label, key = 'id') {
        if (!Array.isArray(rows)) throw new Error(`${label}:expected_array`);
        const ids = new Set();
        for (const row of rows) {
            const pending = checkpoint(); if (pending) await pending;
            if (!isRecord(row) || typeof row[key] !== 'string' || !row[key]) throw new Error(`${label}:invalid_${key}`);
            if (ids.has(row[key])) throw new Error(`${label}:duplicate_${row[key]}`);
            ids.add(row[key]);
        }
        return ids;
    }
    if (!isRecord(record) || record.schemaVersion !== SCHEMA_VERSION || record.algorithmVersion !== ALGORITHM_VERSION) {
        throw new Error('generated_schema_or_algorithm_version_mismatch');
    }
    if (!isRecord(record.scope) || !['slice', 'full'].includes(record.scope.kind)
        || !Array.isArray(record.scope.requirementIds) || !Array.isArray(record.scope.waypointIds)
        || !Array.isArray(record.scope.connectionIds)) throw new Error('generated_scope_invalid');
    for (const key of ['requirementIds', 'waypointIds', 'connectionIds']) {
        const values = record.scope[key], ids = new Set();
        for (const value of values) {
            const pending = checkpoint(); if (pending) await pending;
            if (typeof value !== 'string' || !value || ids.has(value)) throw new Error(`generated_scope_${key}_invalid`);
            ids.add(value);
        }
    }
    if (!Array.isArray(record.inputs) || record.inputs.length === 0) throw new Error('generated_inputs_invalid');
    const inputIds = new Set();
    for (const input of record.inputs) {
        const pending = checkpoint(); if (pending) await pending;
        if (!isRecord(input) || typeof input.id !== 'string' || !input.id || typeof input.path !== 'string' || !input.path
            || !(input.missing === true || /^[a-f0-9]{64}$/.test(input.sha256))
            || (input.loadedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.loadedSha256))
            || inputIds.has(input.id)) throw new Error('generated_inputs_invalid');
        inputIds.add(input.id);
    }
    const sortedInputs = [...record.inputs].sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < sortedInputs.length; i++) {
        const pending = checkpoint(); if (pending) await pending;
        if (record.inputs[i].id !== sortedInputs[i].id) throw new Error('generated_inputs_not_unique_sorted');
    }
    if (expectedIdentity?.authoredDigest) {
        const { serviceInventory: ignoredServiceInventory, ...authoredRequirements } = record.requirements;
        if (sha256(canonicalStringify(authoredRequirements)) !== expectedIdentity.authoredDigest) {
            throw new Error('journey_authored_requirements_mismatch');
        }
    }
    const inputDigest = await canonicalDigest(record.inputs, false, checkpoint);
    if (record.inputFingerprint !== inputDigest.sha256) throw new Error('generated_input_fingerprint_invalid');
    if (expectedIdentity) {
        if (expectedIdentity.status === 'disabled' || expectedIdentity.fingerprint !== record.inputFingerprint) {
            throw new Error('input_identity_mismatch');
        }
        if (expectedIdentity.inputs && canonicalStringify(expectedIdentity.inputs) !== canonicalStringify(record.inputs)) {
            throw new Error('input_identity_manifest_mismatch');
        }
        if (expectedIdentity.scope && canonicalStringify(expectedIdentity.scope) !== canonicalStringify(record.scope)) {
            throw new Error('input_scope_mismatch');
        }
    }
    const recordDigest = await canonicalDigest(record, true, checkpoint);
    if (typeof record.checksum !== 'string' || record.checksum !== recordDigest.sha256) throw new Error('generated_checksum_mismatch');
    if (!isRecord(record.requirements)) throw new Error('generated_inventory_incomplete');
    await validateAuthoredBatched(record.requirements, checkpoint);
    if (!Array.isArray(record.requirements.serviceInventory)) throw new Error('generated_service_inventory_missing');
    const serviceInventoryIds = await unique(record.requirements.serviceInventory, 'generated_service_inventory');
    if (!isRecord(record.coverage) || !Array.isArray(record.coverage.polygons)
        || !Array.isArray(record.coverage.components) || !Array.isArray(record.coverage.towns)
        || !Array.isArray(record.coverage.gates) || !Array.isArray(record.coverage.services)
        || !Array.isArray(record.coverage.connections)) throw new Error('generated_coverage_invalid');
    if (record.coverage.polygons.length !== 189 || record.coverage.towns.length !== 16
        || record.coverage.gates.length !== 23 || record.coverage.connections.length !== record.requirements.trunks.length
        || record.coverage.services.length !== serviceInventoryIds.size
        || record.coverage.components.length > LIMITS.components) throw new Error('generated_coverage_count_invalid');
    const polygonRequirementIds = new Set(record.requirements.requiredPolygons.map(row => row.spawnId));
    const townRequirementIds = new Set(record.requirements.requiredTowns.map(row => row.townKey));
    if (new Set(record.coverage.polygons.map(row => row.requirementId)).size !== 189
        || record.coverage.polygons.some(row => !polygonRequirementIds.has(row.requirementId))
        || new Set(record.coverage.towns.map(row => row.requirementId)).size !== 16
        || record.coverage.towns.some(row => !townRequirementIds.has(row.requirementId))) throw new Error('generated_inventory_coverage_mismatch');
    const allCoverage = [...record.coverage.polygons, ...record.coverage.components, ...record.coverage.towns,
        ...record.coverage.gates, ...record.coverage.services, ...record.coverage.connections];
    const coverageKeys = new Set();
    for (const service of record.coverage.services) {
        const pending = checkpoint(); if (pending) await pending;
        if (!serviceInventoryIds.has(service.requirementId)) throw new Error('generated_service_inventory_coverage_mismatch');
    }
    for (const entry of allCoverage) {
        const pending = checkpoint(); if (pending) await pending;
        if (!isRecord(entry) || !['polygon', 'component', 'town', 'gate', 'service', 'connection'].includes(entry.kind)
            || !STATUSES.has(entry.status) || !REASONS.has(entry.reason) && entry.reason !== null
            || typeof entry.requirementId !== 'string' || !entry.requirementId || !Array.isArray(entry.certificateIds)
            || (entry.status === 'supported' ? entry.reason !== null : entry.reason === null)) {
            throw new Error(`generated_coverage_entry_invalid:${entry.kind}:${entry.requirementId}:${entry.status}:${entry.reason}`);
        }
        const key = `${entry.kind}:${entry.requirementId}`;
        if (coverageKeys.has(key)) throw new Error(`generated_coverage_duplicate:${key}`);
        coverageKeys.add(key);
    }
    if (!Array.isArray(record.polygons) || !Array.isArray(record.waypoints)
        || !Array.isArray(record.components) || !Array.isArray(record.patches)
        || !Array.isArray(record.membershipSpans) || record.membershipSpans.length > LIMITS.rowSpans
        || !Array.isArray(record.trunks) || record.trunks.length > LIMITS.trunks
        || !Array.isArray(record.attachments) || !Array.isArray(record.certificates)
        || !Array.isArray(record.unresolved) || !isRecord(record.buildStats)) throw new Error('generated_tables_invalid');
    const waypointIds = await unique(record.waypoints, 'generated_waypoints');
    if (record.waypoints.length > LIMITS.waypoints) throw new Error('generated_waypoints_limit');
    const componentIds = await unique(record.components, 'generated_components');
    if (componentIds.size > LIMITS.components) throw new Error('generated_components_limit');
    const patchIds = await unique(record.patches, 'generated_patches');
    const edgeIds = await unique(record.trunks, 'generated_trunks');
    const certificateIds = await unique(record.certificates, 'generated_certificates');
    const selectedPolygons = new Set(record.scope.requirementIds.filter(id => polygonRequirementIds.has(id)));
    const polygonKeys = new Set();
    let vertices = 0;
    for (const polygon of record.polygons) {
        const pending = checkpoint(); if (pending) await pending;
        if (!isRecord(polygon) || !polygonRequirementIds.has(polygon.spawnId)
            || !selectedPolygons.has(polygon.spawnId) || typeof polygon.areaId !== 'string'
            || !Array.isArray(polygon.bounds) || polygon.bounds.length < 3
            || polygon.bounds.some(point => !isRecord(point)
                || !['locX', 'locY', 'minZ', 'maxZ'].every(key => Number.isFinite(point[key]))
                || point.minZ > point.maxZ)) throw new Error('generated_polygon_geometry_invalid');
        const key = `${polygon.areaId}\0${polygon.spawnId}`;
        if (polygonKeys.has(key)) throw new Error('generated_polygon_geometry_duplicate');
        polygonKeys.add(key); vertices += polygon.bounds.length;
    }
    for (const waypoint of record.waypoints) {
        const pending = checkpoint(); if (pending) await pending;
        if (!finitePoint(waypoint.point)) throw new Error(`generated_waypoint_point_invalid:${waypoint.id}`);
    }
    for (const component of record.components) {
        const pending = checkpoint(); if (pending) await pending;
        if (!Number.isInteger(component.nodeCount) || component.nodeCount < 1 || !Array.isArray(component.patchIds)
            || component.patchIds.some(id => !patchIds.has(id)) || !Array.isArray(component.entryAnchorIds)
            || component.entryAnchorIds.length > LIMITS.maxEntryAnchors || component.patchIds.length > LIMITS.maxPatches
            || !STATUSES.has(component.status) || !REASONS.has(component.reason) && component.reason !== null) {
            throw new Error(`generated_component_invalid:${component.id}`);
        }
    }
    for (const patch of record.patches) {
        const pending = checkpoint(); if (pending) await pending;
        if (!componentIds.has(patch.componentId) || !Number.isInteger(patch.nodeCount) || patch.nodeCount < 1
            || patch.nodeCount > LIMITS.localNodes || !Number.isFinite(patch.maxPathDistance)
            || patch.maxPathDistance > LIMITS.localDistance || !Number.isFinite(patch.maxXYRadius)
            || patch.maxXYRadius > LIMITS.localRadius || !Array.isArray(patch.membershipSpanIndices)) {
            throw new Error(`generated_patch_invalid:${patch.id}`);
        }
    }
    const requirementAreas = new Set(record.requirements.requiredAreas.map(area => area.id));
    for (const span of record.membershipSpans) {
        const pending = checkpoint(); if (pending) await pending;
        if (!isRecord(span) || !requirementAreas.has(span.areaId) || !polygonRequirementIds.has(span.spawnId)
            || !selectedPolygons.has(span.spawnId) || !Number.isInteger(span.layerZ) || !Number.isInteger(span.rowY)
            || !Number.isInteger(span.xStart) || !Number.isInteger(span.xEnd) || span.xStart > span.xEnd
            || !componentIds.has(span.componentId) || !Array.isArray(span.patchIds) || !span.patchIds.length
            || span.patchIds.length > LIMITS.overlapSpansPerPoint || span.patchIds.some(id => !patchIds.has(id))) {
            throw new Error('generated_membership_span_invalid');
        }
    }
    for (let i = 1; i < record.membershipSpans.length; i++) {
        const pending = checkpoint(); if (pending) await pending;
        const a = record.membershipSpans[i - 1], b = record.membershipSpans[i];
        const order = a.areaId.localeCompare(b.areaId) || a.spawnId.localeCompare(b.spawnId)
            || a.layerZ - b.layerZ || a.rowY - b.rowY || a.xStart - b.xStart || a.xEnd - b.xEnd
            || a.componentId.localeCompare(b.componentId);
        if (order > 0) throw new Error('generated_membership_spans_not_sorted');
    }
    const spans = record.membershipSpans;
    for (const patch of record.patches) for (const index of patch.membershipSpanIndices) {
        const pending = checkpoint(); if (pending) await pending;
        if (!Number.isInteger(index) || index < 0 || index >= spans.length || !spans[index].patchIds.includes(patch.id)) {
            throw new Error(`generated_patch_span_reference_invalid:${patch.id}`);
        }
    }
    const acceptedRegions = new Set(record.requirements.acceptedTransitRegions.map(region => region.id));
    for (const edge of record.trunks) {
        const pending = checkpoint(); if (pending) await pending;
        if (!waypointIds.has(edge.from) || !waypointIds.has(edge.to) || !Array.isArray(edge.points)
            || edge.points.length < 2 || edge.points.length > LIMITS.trunkVertices
            || !Number.isFinite(edge.length) || edge.length < 0 || edge.length > LIMITS.trunkLength
            || !Array.isArray(edge.transitRegionIds) || edge.transitRegionIds.some(id => !acceptedRegions.has(id))
            || !Array.isArray(edge.chunkOffsets) || edge.points.some(point => !Array.isArray(point)
                || point.length !== 3 || !point.every(Number.isInteger))) throw new Error(`generated_trunk_invalid:${edge.id}`);
        vertices += edge.points.length;
        if (!record.scope.connectionIds.includes(edge.id)) throw new Error(`generated_trunk_outside_scope:${edge.id}`);
    }
    const attachmentBuckets = new Map();
    for (const attachment of record.attachments) {
        const pending = checkpoint(); if (pending) await pending;
        if (!isRecord(attachment) || typeof attachment.anchorId !== 'string' || !attachment.anchorId
            || !componentIds.has(attachment.componentId) || attachment.patchId && !patchIds.has(attachment.patchId)
            || !finitePoint(attachment.point) || !['forward', 'reverse', 'both'].includes(attachment.direction)) {
            throw new Error('generated_attachment_invalid');
        }
        const key = `${Math.floor(attachment.point.locX / 2048)}:${Math.floor(attachment.point.locY / 2048)}:${Math.floor(attachment.point.locZ / 64)}`;
        const count = (attachmentBuckets.get(key) || 0) + 1;
        if (count > LIMITS.attachmentReferencesPerBucket) throw new Error(`generated_attachment_bucket_overflow:${key}`);
        attachmentBuckets.set(key, count);
    }
    for (const certificate of record.certificates) {
        const pending = checkpoint(); if (pending) await pending;
        if (!isRecord(certificate) || typeof certificate.id !== 'string' || !certificate.id
            || typeof certificate.kind !== 'string' || typeof certificate.requirementId !== 'string'
            || typeof certificate.direction !== 'string') throw new Error('generated_certificate_invalid');
        if (certificate.componentId && !componentIds.has(certificate.componentId)) throw new Error('generated_certificate_component_missing');
        if (certificate.patchId && !patchIds.has(certificate.patchId)) throw new Error('generated_certificate_patch_missing');
        if (certificate.geometry) {
            if (!Array.isArray(certificate.geometry)) throw new Error('generated_certificate_geometry_invalid');
            vertices += certificate.geometry.length;
            for (const point of certificate.geometry) {
                const pending = checkpoint(); if (pending) await pending;
                if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isInteger)) {
                    throw new Error('generated_certificate_geometry_invalid');
                }
            }
        }
    }
    if (vertices > LIMITS.vertices) throw new Error('generated_vertex_limit_exceeded');
    for (const entry of allCoverage) for (const id of entry.certificateIds) {
        const pending = checkpoint(); if (pending) await pending;
        if (!certificateIds.has(id) && !componentIds.has(id)) throw new Error(`generated_coverage_certificate_missing:${id}`);
    }
    const expectedUnresolved = allCoverage.filter(entry => entry.status !== 'supported')
        .map(entry => `${entry.kind}\0${entry.requirementId}\0${entry.status}`).sort();
    const actualUnresolved = record.unresolved.map(entry => `${entry.kind}\0${entry.requirementId}\0${entry.status}`).sort();
    if (expectedUnresolved.length !== actualUnresolved.length
        || expectedUnresolved.some((value, index) => value !== actualUnresolved[index])) throw new Error('generated_unresolved_inventory_mismatch');
    if (!isRecord(record.buildStats) || Object.values(record.buildStats).some(value => typeof value === 'number'
        && (!Number.isFinite(value) || value < 0))) throw new Error('generated_build_stats_invalid');
    const bytes = recordDigest.bytes + Buffer.byteLength(`"checksum":${JSON.stringify(record.checksum)},`);
    if (bytes > LIMITS.generatedBytes) throw new Error('generated_size_limit_exceeded');
    if (Date.now() - startedAtWallMs > LIMITS.maxLoaderMs) throw new Error('loader_wall_limit');
    if (process.memoryUsage.rss() - baselineRss > LIMITS.maxLoaderRss) throw new Error('loader_additional_rss_limit');
    return { bytes, checksum: record.checksum, inputFingerprint: record.inputFingerprint };
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

module.exports = {
    ALGORITHM_VERSION,
    LIMITS,
    SCHEMA_VERSION,
    canonicalStringify,
    checksumOf,
    deepFreeze,
    parseStrictJson,
    sha256,
    validateAuthored,
    validateRecord
};
});
