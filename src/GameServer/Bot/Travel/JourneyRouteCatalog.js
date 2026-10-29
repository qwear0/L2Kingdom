require('../../Geodata/JourneyGeometryIdentity.js').define(module, require, function (module, exports, require, __filename, __dirname) {
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const Format = require('./JourneyRouteFormat');
const Inputs = require('./JourneyRouteInputs');

const CELL = 16;
const BUCKET_XY = 2048;
const BUCKET_Z = 64;
let activeCatalog = null;

function statusResult(reason) {
    return Object.freeze({ status: 'disabled', reason: String(reason || 'journey_catalogue_disabled').slice(0, 300) });
}
function keyForRow(areaId, spawnId, layerZ, rowY) {
    return `${areaId}\0${spawnId}\0${layerZ}\0${rowY}`;
}
function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j];
        if ((a.locY > point.locY) !== (b.locY > point.locY)
            && point.locX < (b.locX - a.locX) * (point.locY - a.locY) / (b.locY - a.locY) + a.locX) inside = !inside;
    }
    return inside;
}
function lowerBound(spans, cellX) {
    let low = 0, high = spans.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (spans[middle].xStart <= cellX) low = middle + 1;
        else high = middle;
    }
    return low - 1;
}
async function makeTopology(record, checkpoint) {
    const waypointIds = record.waypoints.map(row => row.id).sort();
    const waypointIndex = new Map(waypointIds.map((id, index) => [id, index]));
    const count = waypointIds.length;
    const distance = new Float64Array(count * count);
    distance.fill(Infinity);
    const firstEdge = new Int32Array(count * count);
    firstEdge.fill(-1);
    for (let i = 0; i < count; i++) distance[i * count + i] = 0;
    const edges = [...record.trunks].sort((a, b) => a.id.localeCompare(b.id));
    const adjacency = Array.from({ length: count }, () => []);
    for (let i = 0; i < edges.length; i++) {
        const pending = checkpoint(); if (pending) await pending;
        const edge = edges[i], from = waypointIndex.get(edge.from), to = waypointIndex.get(edge.to);
        if (from === undefined || to === undefined) throw new Error(`trunk_endpoint_missing:${edge.id}`);
        adjacency[from].push(i);
        const cell = from * count + to;
        if (edge.length < distance[cell]) {
            distance[cell] = edge.length;
            firstEdge[cell] = i;
        }
    }
    // The graph is at most 256 nodes, so shared all-pairs next hops stay small
    // and make normal route lookup independent of bots or requested journeys.
    let relaxations = 0;
    for (let middle = 0; middle < count; middle++) {
        for (let from = 0; from < count; from++) {
            const prefix = distance[from * count + middle];
            if (!Number.isFinite(prefix)) continue;
            for (let to = 0; to < count; to++) {
                if ((++relaxations & 4095) === 0) await checkpoint(4096);
                const suffix = distance[middle * count + to];
                if (!Number.isFinite(suffix)) continue;
                const index = from * count + to, candidate = prefix + suffix;
                if (candidate < distance[index]) {
                    const nextEdge = from === middle ? firstEdge[middle * count + to] : firstEdge[from * count + middle];
                    if (nextEdge < 0) continue;
                    distance[index] = candidate;
                    firstEdge[index] = nextEdge;
                }
            }
        }
    }
    for (const rows of adjacency) rows.sort((a, b) => edges[a].id.localeCompare(edges[b].id));
    return { waypointIds, waypointIndex, count, distance, firstEdge, edges, adjacency };
}
async function freezeDeep(value, checkpoint) {
    const pending = [value];
    let visited = 0;
    while (pending.length) {
        const node = pending.pop();
        if (!node || typeof node !== 'object' || Object.isFrozen(node)) continue;
        // Freeze before enqueueing children so aliases/cycles cannot expand the
        // work list. Nothing is published until every descendant is frozen.
        Object.freeze(node);
        // Parsed JSON arrays have only indexed children. Enumerating their
        // numeric keys allocates strings for geometry and span-index scalars.
        const keys = Array.isArray(node) ? null : Object.keys(node);
        const length = keys ? keys.length : node.length;
        for (let index = 0; index < length; index++) {
            const child = node[keys ? keys[index] : index];
            if (child && typeof child === 'object' && !Object.isFrozen(child)) pending.push(child);
            if (++visited === Format.LIMITS.maxBatchRecords) {
                await checkpoint(visited); visited = 0;
            }
        }
    }
    if (visited) await checkpoint(visited);
    return value;
}
async function makeIndexes(record, revision, checkpoint) {
    const spansByRow = new Map();
    for (const span of record.membershipSpans) {
        const pending = checkpoint(); if (pending) await pending;
        const key = keyForRow(span.areaId, span.spawnId, span.layerZ, span.rowY);
        if (!spansByRow.has(key)) spansByRow.set(key, []);
        spansByRow.get(key).push(span);
    }
    for (const spans of spansByRow.values()) {
        for (let i = 1; i < spans.length; i++) {
            const pending = checkpoint(); if (pending) await pending;
            if (spans[i].xStart <= spans[i - 1].xEnd) throw new Error('membership_spans_overlap_or_duplicate');
        }
    }
    const polygonByKey = new Map();
    for (const polygon of record.polygons) {
        const pending = checkpoint(); if (pending) await pending;
        polygonByKey.set(`${polygon.areaId}\0${polygon.spawnId}`, polygon);
    }
    const coverageByKey = new Map();
    for (const entry of [...record.coverage.polygons, ...record.coverage.components, ...record.coverage.towns,
        ...record.coverage.gates, ...record.coverage.services, ...record.coverage.connections]) {
        const pending = checkpoint(); if (pending) await pending;
        coverageByKey.set(`${entry.kind}\0${entry.requirementId}`, entry);
    }
    const attachments = new Map();
    for (const entry of record.attachments || []) {
        const pending = checkpoint(); if (pending) await pending;
        const point = entry.point;
        const key = `${Math.floor(point.locX / BUCKET_XY)}:${Math.floor(point.locY / BUCKET_XY)}:${Math.floor(point.locZ / BUCKET_Z)}`;
        if (!attachments.has(key)) attachments.set(key, []);
        const bucket = attachments.get(key);
        bucket.push(entry);
        if (bucket.length > Format.LIMITS.attachmentReferencesPerBucket) throw new Error(`attachment_bucket_overflow:${key}`);
    }
    for (const rows of attachments.values()) rows.sort((a, b) => a.anchorId.localeCompare(b.anchorId));
    const topology = await makeTopology(record, checkpoint);
    const edgeById = new Map(topology.edges.map(edge => [edge.id, edge]));

    function membership(areaId, spawnId, point) {
        if (!point || !['locX', 'locY', 'locZ'].every(key => Number.isFinite(point[key]))) {
            return Object.freeze({ status: 'missing', reason: 'invalid_point' });
        }
        const coverage = coverageByKey.get(`polygon\0${spawnId}`);
        if (!coverage) return Object.freeze({ status: 'missing', reason: 'unknown_requirement' });
        if (coverage.status !== 'supported') return Object.freeze({ status: coverage.status, reason: coverage.reason,
            requirementId: spawnId });
        const polygon = polygonByKey.get(`${areaId}\0${spawnId}`);
        if (!polygon) return Object.freeze({ status: 'unresolved', reason: 'polygon_geometry_missing', requirementId: spawnId });
        const minZ = Math.min(...polygon.bounds.map(p => p.minZ)), maxZ = Math.max(...polygon.bounds.map(p => p.maxZ));
        if (point.locZ < minZ || point.locZ > maxZ || !pointInPolygon(point, polygon.bounds)) {
            return Object.freeze({ status: 'missing', reason: 'outside_polygon' });
        }
        if (!Number.isInteger(point.locX) || !Number.isInteger(point.locY) || !Number.isInteger(point.locZ)) {
            return Object.freeze({ status: 'missing', reason: 'non_integral_native_cell' });
        }
        const cx = point.locX >> 4, cy = point.locY >> 4;
        const rows = spansByRow.get(keyForRow(areaId, spawnId, point.locZ, cy));
        if (!rows) return Object.freeze({ status: 'missing', reason: 'no_admitted_layer' });
        const index = lowerBound(rows, cx);
        const candidates = [];
        for (let i = Math.max(0, index - 1); i < rows.length && rows[i].xStart <= cx; i++) {
            if (cx <= rows[i].xEnd) candidates.push(rows[i]);
        }
        if (candidates.length > Format.LIMITS.overlapSpansPerPoint) {
            return Object.freeze({ status: 'unresolved', reason: 'membership_overlap_limit' });
        }
        if (!candidates.length) return Object.freeze({ status: 'missing', reason: 'no_admitted_layer' });
        const first = candidates[0];
        if (candidates.some(span => span.componentId !== first.componentId)) {
            return Object.freeze({ status: 'unresolved', reason: 'ambiguous_component_membership' });
        }
        const patchIds = [...new Set(candidates.flatMap(span => span.patchIds))].sort();
        return Object.freeze({ status: 'supported', componentId: first.componentId, patchIds: Object.freeze(patchIds) });
    }
    function attachmentsFor(point, direction, destinationComponent = null) {
        if (!point || !['locX', 'locY', 'locZ'].every(key => Number.isFinite(point[key]))) return Object.freeze([]);
        const bx = Math.floor(point.locX / BUCKET_XY), by = Math.floor(point.locY / BUCKET_XY), bz = Math.floor(point.locZ / BUCKET_Z);
        const candidates = [];
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
            const rows = attachments.get(`${bx + dx}:${by + dy}:${bz + dz}`) || [];
            if (rows.length > Format.LIMITS.attachmentReferencesPerBucket) return Object.freeze([]);
            for (const row of rows) {
                if (row.direction !== direction && row.direction !== 'both') continue;
                if (destinationComponent && row.componentId !== destinationComponent) continue;
                const dx = row.point.locX - point.locX, dy = row.point.locY - point.locY;
                const dz = Math.abs(row.point.locZ - point.locZ);
                const distanceLowerBound = Math.hypot(dx, dy);
                if (distanceLowerBound > Format.LIMITS.localRadius || dz > 64) continue;
                candidates.push({ row, distanceLowerBound });
            }
        }
        candidates.sort((a, b) => Number(b.row.componentId === destinationComponent) - Number(a.row.componentId === destinationComponent)
            || a.distanceLowerBound - b.distanceLowerBound || a.row.anchorId.localeCompare(b.row.anchorId));
        return Object.freeze(candidates.slice(0, Format.LIMITS.attachmentCandidates).map(({ row, distanceLowerBound }) =>
            Object.freeze({ anchorId: row.anchorId, componentId: row.componentId, patchId: row.patchId || null,
                distanceLowerBound })));
    }
    function route(fromAnchorId, toAnchorId, exclusions = {}) {
        const from = topology.waypointIndex.get(fromAnchorId), to = topology.waypointIndex.get(toAnchorId);
        if (from === undefined || to === undefined) return Object.freeze({ status: 'blocked', reason: 'unknown_anchor' });
        if (from === to) return Object.freeze({ status: 'routed', edgeIds: Object.freeze([]), length: 0 });
        const excludedEdges = new Set(exclusions.edgeIds || exclusions.edges || []);
        const excludedRegions = new Set(exclusions.transitRegionIds || exclusions.regions || []);
        let sequence;
        if (!excludedEdges.size && !excludedRegions.size) {
            if (!Number.isFinite(topology.distance[from * topology.count + to])) {
                return Object.freeze({ status: 'blocked', reason: 'no_route_in_declared_graph' });
            }
            sequence = [];
            let cursor = from, guard = 0;
            while (cursor !== to && guard++ <= topology.count) {
                const edgeIndex = topology.firstEdge[cursor * topology.count + to];
                if (edgeIndex < 0) return Object.freeze({ status: 'blocked', reason: 'topology_next_hop_invalid' });
                const edge = topology.edges[edgeIndex];
                sequence.push(edge.id);
                cursor = topology.waypointIndex.get(edge.to);
            }
        } else {
            const distances = new Float64Array(topology.count); distances.fill(Infinity); distances[from] = 0;
            const previous = new Int32Array(topology.count); previous.fill(-1);
            const previousEdge = new Int32Array(topology.count); previousEdge.fill(-1);
            const visited = new Uint8Array(topology.count);
            for (let iteration = 0; iteration < topology.count; iteration++) {
                let current = -1;
                for (let i = 0; i < topology.count; i++) if (!visited[i]
                    && (current < 0 || distances[i] < distances[current] || distances[i] === distances[current]
                        && topology.waypointIds[i] < topology.waypointIds[current])) current = i;
                if (current < 0 || !Number.isFinite(distances[current])) break;
                if (current === to) break;
                visited[current] = 1;
                for (const edgeIndex of topology.adjacency[current]) {
                    const edge = topology.edges[edgeIndex];
                    if (excludedEdges.has(edge.id) || edge.transitRegionIds.some(id => excludedRegions.has(id))) continue;
                    const next = topology.waypointIndex.get(edge.to), candidate = distances[current] + edge.length;
                    if (candidate < distances[next]) {
                        distances[next] = candidate;
                        previous[next] = current;
                        previousEdge[next] = edgeIndex;
                    }
                }
            }
            if (!Number.isFinite(distances[to])) return Object.freeze({ status: 'blocked', reason: 'no_route_in_declared_graph' });
            sequence = [];
            for (let cursor = to; cursor !== from;) {
                const edgeIndex = previousEdge[cursor];
                if (edgeIndex < 0 || sequence.length > topology.edges.length) {
                    return Object.freeze({ status: 'blocked', reason: 'topology_parent_invalid' });
                }
                sequence.push(topology.edges[edgeIndex].id);
                cursor = previous[cursor];
            }
            sequence.reverse();
        }
        const length = sequence.reduce((total, id) => total + edgeById.get(id).length, 0);
        return Object.freeze({ status: 'routed', edgeIds: Object.freeze(sequence), length });
    }
    function fragment(edgeId, cursor) {
        const edge = edgeById.get(edgeId);
        if (!edge) return Object.freeze({ status: 'missing', reason: 'unknown_edge' });
        if (!Number.isInteger(cursor) || cursor < 0 || cursor >= edge.points.length) {
            return Object.freeze({ status: 'missing', reason: 'invalid_cursor' });
        }
        let end = cursor, length = 0;
        while (end + 1 < edge.points.length && end - cursor + 2 <= 64) {
            const a = edge.points[end], b = edge.points[end + 1];
            const step = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (length + step > 4096) break;
            length += step;
            end++;
        }
        const nextCursor = end < edge.points.length - 1 ? end : null;
        return Object.freeze({ status: 'ready', revision, edgeId, cursor, startIndex: cursor, endIndex: end,
            nextCursor, length, pointAt(index) {
                if (!Number.isInteger(index) || index < cursor || index > end) throw new RangeError('journey_fragment_index_out_of_range');
                return edge.points[index];
            } });
    }
    const immutableRecord = await freezeDeep(record, checkpoint);
    return Object.freeze({
        revision,
        scope: immutableRecord.scope,
        record: immutableRecord,
        membership,
        attachments: attachmentsFor,
        walkRoute: route,
        fragment
    });
}
async function load(file = Inputs.DEFAULT_FILE, inputIdentity = null) {
    activeCatalog = null;
    const startedAt = inputIdentity?.startedAtMonotonic ?? performance.now();
    const baselineRss = inputIdentity?.baselineRssBytes ?? process.memoryUsage.rss();
    const startedAtWallMs = inputIdentity?.startedAtWallMs ?? Date.now();
    const fullPath = path.resolve(file);
    let handle;
    try {
        const pathStat = await fs.lstat(fullPath, { bigint: true });
        if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error('journey_catalogue_not_regular_file');
        if (pathStat.size > BigInt(Format.LIMITS.generatedBytes)) throw new Error('journey_catalogue_size_limit');
        handle = await fs.open(fullPath, 'r');
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino
            || stat.size !== pathStat.size || stat.size > BigInt(Format.LIMITS.generatedBytes)) {
            throw new Error('journey_catalogue_changed_while_opening');
        }
        let bytes = Buffer.alloc(Number(stat.size));
        let offset = 0;
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) throw new Error('journey_catalogue_truncated_while_reading');
            offset += bytesRead;
        }
        const finalStat = await handle.stat({ bigint: true });
        if (finalStat.size !== stat.size || finalStat.mtimeNs !== stat.mtimeNs || finalStat.ctimeNs !== stat.ctimeNs) {
            throw new Error('journey_catalogue_changed_while_reading');
        }
        await handle.close(); handle = null;
        if (inputIdentity?.status === 'disabled') throw new Error(inputIdentity.reason || 'journey_input_identity_disabled');
        if (!inputIdentity || typeof inputIdentity.fingerprint !== 'string') throw new Error('journey_input_identity_required');
        const record = Format.parseStrictJson(bytes.toString('utf8'), 'journey_catalogue');
        // Validation/indexing needs the parsed tree, not a second file-sized
        // backing buffer retained across its asynchronous checkpoints.
        bytes = null;
        let recordsSinceYield = 0;
        const checkBudget = () => {
            if (Date.now() - startedAtWallMs > Format.LIMITS.maxLoaderMs
                || process.memoryUsage.rss() - baselineRss > Format.LIMITS.maxLoaderRss) {
                throw new Error('journey_loader_budget_exceeded');
            }
        };
        // Only a real batch boundary needs a promise; fast callers still check
        // the budget synchronously rather than allocating per-record awaits.
        const checkpoint = (count = 1) => {
            recordsSinceYield += count;
            if (recordsSinceYield >= Format.LIMITS.maxBatchRecords) {
                recordsSinceYield %= Format.LIMITS.maxBatchRecords;
                return new Promise(resolve => setImmediate(resolve)).then(checkBudget);
            }
            checkBudget();
        };
        await Format.validateRecord(record, inputIdentity, { checkpoint, baselineRss, startedAtWallMs });
        if (Format.canonicalStringify(record.scope) !== Format.canonicalStringify(inputIdentity.scope)) {
            throw new Error('journey_scope_identity_mismatch');
        }
        const revision = `${record.inputFingerprint}:${record.checksum}`;
        const catalogue = await makeIndexes(record, revision, checkpoint);
        await checkpoint(Format.LIMITS.maxBatchRecords);
        const retainedRss = process.memoryUsage.rss() - baselineRss;
        if (retainedRss > Format.LIMITS.maxRetainedRss) throw new Error('loader_retained_rss_limit');
        activeCatalog = catalogue;
        return Object.freeze({ status: 'ready', revision, catalogue });
    } catch (error) {
        const reason = error.code === 'ENOENT' ? 'journey_catalogue_missing' : `journey_catalogue_invalid:${error.message || error}`;
        activeCatalog = null;
        return statusResult(reason);
    } finally {
        if (handle) await handle.close();
    }
}

module.exports = {
    defaultFile: () => Inputs.DEFAULT_FILE,
    current: () => activeCatalog,
    load,
    membership(areaId, spawnId, point) {
        return activeCatalog ? activeCatalog.membership(areaId, spawnId, point)
            : Object.freeze({ status: 'unresolved', reason: 'catalogue_disabled' });
    },
    attachments(point, direction, destinationComponent) {
        return activeCatalog ? activeCatalog.attachments(point, direction, destinationComponent) : Object.freeze([]);
    },
    walkRoute(fromAnchorId, toAnchorId, exclusions) {
        return activeCatalog ? activeCatalog.walkRoute(fromAnchorId, toAnchorId, exclusions)
            : Object.freeze({ status: 'blocked', reason: 'catalogue_disabled' });
    },
    fragment(edgeId, cursor) {
        return activeCatalog ? activeCatalog.fragment(edgeId, cursor)
            : Object.freeze({ status: 'missing', reason: 'catalogue_disabled' });
    }
};
});
