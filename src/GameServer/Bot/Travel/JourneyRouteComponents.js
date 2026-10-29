require('../../Geodata/JourneyGeometryIdentity.js').define(module, require, function (module, exports, require, __filename, __dirname) {
'use strict';

const { createHash } = require('node:crypto');
const Format = require('./JourneyRouteFormat');

const CELL = 16;
const DIRECTIONS = Object.freeze([[0, -1], [0, 1], [1, 0], [-1, 0]]);
const MAX_POLYGON_CELLS = 237600;

function tupleCompare(a, b) {
    return a.cx - b.cx || a.cy - b.cy || a.z - b.z;
}
function pointInPolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j];
        if ((a.locY > y) !== (b.locY > y)
            && x < (b.locX - a.locX) * (y - a.locY) / (b.locY - a.locY) + a.locX) inside = !inside;
    }
    return inside;
}
function insideOrBoundary(x, y, polygon) {
    const point = { locX: x, locY: y };
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        if (orient(polygon[j], polygon[i], point) === 0 && onSegment(polygon[j], polygon[i], point)) return true;
    }
    return pointInPolygon(x, y, polygon);
}
function segmentInsidePolygon(a, b, polygon) {
    if (!insideOrBoundary(a.locX, a.locY, polygon) || !insideOrBoundary(b.locX, b.locY, polygon)) return false;
    const dx = b.locX - a.locX, dy = b.locY - a.locY;
    const cuts = [0, 1];
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const c = polygon[j], d = polygon[i], ex = d.locX - c.locX, ey = d.locY - c.locY;
        const denominator = dx * ey - dy * ex;
        if (Math.abs(denominator) < 1e-9) continue;
        const t = ((c.locX - a.locX) * ey - (c.locY - a.locY) * ex) / denominator;
        const u = ((c.locX - a.locX) * dy - (c.locY - a.locY) * dx) / denominator;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
    }
    cuts.sort((left, right) => left - right);
    for (let i = 1; i < cuts.length; i++) {
        const t = (cuts[i - 1] + cuts[i]) / 2;
        if (!insideOrBoundary(a.locX + dx * t, a.locY + dy * t, polygon)) return false;
    }
    return true;
}
function orient(a, b, c) {
    return (b.locX - a.locX) * (c.locY - a.locY) - (b.locY - a.locY) * (c.locX - a.locX);
}
function onSegment(a, b, p) {
    return Math.min(a.locX, b.locX) <= p.locX && p.locX <= Math.max(a.locX, b.locX)
        && Math.min(a.locY, b.locY) <= p.locY && p.locY <= Math.max(a.locY, b.locY);
}
function segmentsIntersect(a, b, c, d) {
    const abC = orient(a, b, c), abD = orient(a, b, d), cdA = orient(c, d, a), cdB = orient(c, d, b);
    return (abC === 0 && onSegment(a, b, c)) || (abD === 0 && onSegment(a, b, d))
        || (cdA === 0 && onSegment(c, d, a)) || (cdB === 0 && onSegment(c, d, b))
        || (abC < 0) !== (abD < 0) && (cdA < 0) !== (cdB < 0);
}
function clipPolygonToCell(polygon, cx, cy) {
    const minX = cx * CELL, minY = cy * CELL, maxX = minX + CELL, maxY = minY + CELL;
    let points = polygon.map(point => ({ locX: point.locX, locY: point.locY }));
    const clips = [
        { inside: p => p.locX >= minX, cross: (a, b) => ({ locX: minX,
            locY: a.locY + (b.locY - a.locY) * (minX - a.locX) / (b.locX - a.locX) }) },
        { inside: p => p.locX <= maxX, cross: (a, b) => ({ locX: maxX,
            locY: a.locY + (b.locY - a.locY) * (maxX - a.locX) / (b.locX - a.locX) }) },
        { inside: p => p.locY >= minY, cross: (a, b) => ({ locX: a.locX + (b.locX - a.locX) * (minY - a.locY) / (b.locY - a.locY), locY: minY }) },
        { inside: p => p.locY <= maxY, cross: (a, b) => ({ locX: a.locX + (b.locX - a.locX) * (maxY - a.locY) / (b.locY - a.locY), locY: maxY }) }
    ];
    for (const clip of clips) {
        if (!points.length) return null;
        const output = [];
        let previous = points[points.length - 1], previousInside = clip.inside(previous);
        for (const current of points) {
            const currentInside = clip.inside(current);
            if (currentInside !== previousInside) {
                const denominator = (previous.locX !== current.locX && (clip === clips[0] || clip === clips[1]))
                    ? current.locX - previous.locX : current.locY - previous.locY;
                if (denominator) output.push(clip.cross(previous, current));
            }
            if (currentInside) output.push(current);
            previous = current; previousInside = currentInside;
        }
        points = output;
    }
    if (points.length < 3) return null;
    let twiceArea = 0, cxSum = 0, cySum = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const cross = points[j].locX * points[i].locY - points[i].locX * points[j].locY;
        twiceArea += cross;
        cxSum += (points[j].locX + points[i].locX) * cross;
        cySum += (points[j].locY + points[i].locY) * cross;
    }
    if (Math.abs(twiceArea) < 1e-7) return null;
    const centroid = { locX: cxSum / (3 * twiceArea), locY: cySum / (3 * twiceArea) };
    const candidates = [centroid, ...points];
    for (let y = 1; y <= 7; y++) for (let x = 1; x <= 7; x++) {
        candidates.push({ locX: minX + CELL * x / 8, locY: minY + CELL * y / 8 });
    }
    const integerCandidates = candidates.map(point => ({ locX: Math.round(point.locX), locY: Math.round(point.locY) }));
    const sample = integerCandidates.find(point => point.locX > minX && point.locX < maxX
        && point.locY > minY && point.locY < maxY && pointInPolygon(point.locX, point.locY, polygon));
    return { points, sample };
}
function convexPolygon(polygon) {
    let sign = 0;
    for (let i = 0; i < polygon.length; i++) {
        const value = orient(polygon[i], polygon[(i + 1) % polygon.length], polygon[(i + 2) % polygon.length]);
        if (Math.abs(value) < 1e-9) continue;
        const current = Math.sign(value);
        if (sign && current !== sign) return false;
        sign = current;
    }
    return sign !== 0;
}
function floorRange(bounds) {
    return { minZ: Math.min(...bounds.map(p => p.minZ)), maxZ: Math.max(...bounds.map(p => p.maxZ)) };
}
function createBudget(options) {
    const budget = options.budget;
    return {
        poll: () => budget?.poll(),
        scan: count => budget?.scan(count),
        decoded: count => budget?.decodedLayers(count),
        transition: () => budget?.transition(),
        checkNative: () => {
            // walkSegment calls this after each 128 native cell transitions.
            budget?.nativeTransitions(128);
        }
    };
}
class DistanceHeap {
    constructor() { this.distances = []; this.nodes = []; }
    get length() { return this.nodes.length; }
    push(distance, node) {
        const distances = this.distances, nodes = this.nodes;
        let index = nodes.length;
        distances.push(distance); nodes.push(node);
        while (index > 0) {
            const parent = (index - 1) >> 1;
            if (distances[parent] < distance || distances[parent] === distance && nodes[parent] <= node) break;
            distances[index] = distances[parent]; nodes[index] = nodes[parent]; index = parent;
        }
        distances[index] = distance; nodes[index] = node;
    }
    pop() {
        const distances = this.distances, nodes = this.nodes;
        if (!nodes.length) return null;
        const result = { distance: distances[0], node: nodes[0] };
        const lastDistance = distances.pop(), lastNode = nodes.pop();
        if (!nodes.length) return result;
        let index = 0;
        while (index * 2 + 1 < nodes.length) {
            const left = index * 2 + 1, right = left + 1;
            const child = right < nodes.length && (distances[right] < distances[left]
                || distances[right] === distances[left] && nodes[right] < nodes[left]) ? right : left;
            if (distances[child] > lastDistance || distances[child] === lastDistance && nodes[child] >= lastNode) break;
            distances[index] = distances[child]; nodes[index] = nodes[child]; index = child;
        }
        distances[index] = lastDistance; nodes[index] = lastNode;
        return result;
    }
}
function queueDistances(start, nodes, edgesKey, maxDistance, maxRadius, budget) {
    const distance = new Float64Array(nodes.length);
    const parent = new Int32Array(nodes.length);
    const visited = new Uint8Array(nodes.length);
    distance.fill(Infinity);
    parent.fill(-2);
    distance[start] = 0; parent[start] = -1;
    const heap = new DistanceHeap();
    heap.push(0, start);
    const costKey = edgesKey === 'out' ? 'outCosts' : 'inCosts';
    let expansions = 0;
    while (heap.length) {
        if ((++expansions & 127) === 0) budget.poll();
        budget.expand?.();
        const current = heap.pop();
        if (current.distance !== distance[current.node] || visited[current.node]) continue;
        visited[current.node] = 1;
        const origin = nodes[start], neighbors = nodes[current.node][edgesKey], costs = nodes[current.node][costKey];
        for (let index = 0; index < neighbors.length; index++) {
            const next = neighbors[index], node = nodes[next];
            const candidate = current.distance + costs[index];
            if (candidate > maxDistance || candidate >= distance[next]
                || Math.hypot(node.x - origin.x, node.y - origin.y) > maxRadius) continue;
            distance[next] = candidate;
            parent[next] = current.node;
            heap.push(candidate, next);
        }
    }
    return { distance, parent };
}
function uncoveredPath(target, parent, covered, nodeCount) {
    const path = [];
    let current = target;
    while (current >= 0 && !covered.has(current) && path.length <= nodeCount) {
        path.push(current);
        current = parent[current];
    }
    return current === -1 || covered.has(current) ? path : null;
}
function patchComponent(component, nodes, idPrefix, budget) {
    const localByGlobal = new Map(component.map((globalIndex, localIndex) => [globalIndex, localIndex]));
    const localNodes = component.map(globalIndex => {
        const node = nodes[globalIndex];
        const out = [], outCosts = [], incoming = [], inCosts = [];
        for (let edge = 0; edge < node.out.length; edge++) {
            const local = localByGlobal.get(node.out[edge]);
            if (local !== undefined) { out.push(local); outCosts.push(node.outCosts[edge]); }
        }
        for (let edge = 0; edge < node.in.length; edge++) {
            const local = localByGlobal.get(node.in[edge]);
            if (local !== undefined) { incoming.push(local); inCosts.push(node.inCosts[edge]); }
        }
        return { ...node, out, outCosts, in: incoming, inCosts };
    });
    const uncovered = new Set(localNodes.map((_, index) => index));
    const patches = [];
    const nearestRoundTrip = new Float64Array(localNodes.length);
    nearestRoundTrip.fill(Infinity);
    const candidates = localNodes.map((_, index) => index);
    let refinementVisits = 0;

    while (uncovered.size) {
        budget.poll();
        if (patches.length >= Format.LIMITS.maxPatches) return { supported: false, reason: 'anchor_limit', patches, refinementVisits };
        let anchor;
        if (!patches.length) anchor = candidates[0];
        else {
            let farthest = -1;
            for (const nodeIndex of candidates) {
                if (!uncovered.has(nodeIndex)) continue;
                const distance = nearestRoundTrip[nodeIndex];
                if (distance > farthest || distance === farthest && (!Number.isInteger(anchor)
                    || tupleCompare(localNodes[nodeIndex], localNodes[anchor]) < 0)) {
                    anchor = nodeIndex;
                    farthest = distance;
                }
            }
        }
        const forward = queueDistances(anchor, localNodes, 'out', Format.LIMITS.localDistance,
            Format.LIMITS.localRadius, budget);
        const reverse = queueDistances(anchor, localNodes, 'in', Format.LIMITS.localDistance,
            Format.LIMITS.localRadius, budget);
        const eligible = [];
        for (const nodeIndex of uncovered) {
            if ((++refinementVisits & 127) === 0) budget.poll();
            budget.refine?.();
            const d1 = forward.distance[nodeIndex], d2 = reverse.distance[nodeIndex];
            if (d1 >= 0 && d2 >= 0) eligible.push({ nodeIndex, distance: Math.max(d1, d2), xy: Math.hypot(
                localNodes[nodeIndex].x - localNodes[anchor].x, localNodes[nodeIndex].y - localNodes[anchor].y) });
        }
        eligible.sort((a, b) => a.distance - b.distance || a.xy - b.xy
            || tupleCompare(localNodes[a.nodeIndex], localNodes[b.nodeIndex]));
        const members = new Set();
        const covered = [];
        for (const candidate of eligible) {
            const forwardPath = uncoveredPath(candidate.nodeIndex, forward.parent, members, localNodes.length);
            const reversePath = uncoveredPath(candidate.nodeIndex, reverse.parent, members, localNodes.length);
            if (!forwardPath || !reversePath) continue;
            // Parent-tree paths share prefixes; stop at an already included
            // ancestor so refinement work is linear in newly admitted witnesses.
            const additions = [...new Set([...forwardPath, ...reversePath])];
            if (members.size + additions.length > Format.LIMITS.localNodes) continue;
            for (const nodeIndex of additions) members.add(nodeIndex);
            covered.push(candidate);
        }
        if (!covered.length) return { supported: false, reason: 'limit_reached', patches, refinementVisits };
        for (let nodeIndex = 0; nodeIndex < localNodes.length; nodeIndex++) {
            const d1 = forward.distance[nodeIndex], d2 = reverse.distance[nodeIndex];
            const distance = d1 >= 0 && d2 >= 0 ? Math.max(d1, d2)
                : Math.hypot(localNodes[nodeIndex].x - localNodes[anchor].x, localNodes[nodeIndex].y - localNodes[anchor].y);
            nearestRoundTrip[nodeIndex] = Math.min(nearestRoundTrip[nodeIndex], distance);
        }
        for (const nodeIndex of members) uncovered.delete(nodeIndex);
        let maxPathDistance = 0, maxXYRadius = 0;
        for (const candidate of covered) {
            maxPathDistance = Math.max(maxPathDistance, candidate.distance);
            maxXYRadius = Math.max(maxXYRadius, candidate.xy);
        }
        const anchorNode = localNodes[anchor];
        patches.push({
            id: `${idPrefix}:patch:${patches.length + 1}`,
            anchorNode: component[anchor],
            anchor: { locX: anchorNode.x, locY: anchorNode.y, locZ: anchorNode.z },
            nodeCount: members.size,
            maxPathDistance,
            maxXYRadius,
            members: new Set([...members].map(index => component[index])),
            coveredTargets: covered.length
        });
    }
    return { supported: component.length > 0, reason: null, patches, refinementVisits };
}

function stronglyConnected(nodes, poll) {
    const visited = new Uint8Array(nodes.length);
    const order = new Int32Array(nodes.length);
    let orderLength = 0;
    const stackNodes = new Int32Array(nodes.length);
    const stackEdges = new Int32Array(nodes.length);
    for (let start = 0; start < nodes.length; start++) {
        if (visited[start]) continue;
        let top = 0;
        stackNodes[0] = start; stackEdges[0] = 0; visited[start] = 1;
        while (top >= 0) {
            if ((orderLength & 127) === 0) poll();
            const nodeIndex = stackNodes[top], edgeIndex = stackEdges[top];
            const edges = nodes[nodeIndex].out;
            if (edgeIndex < edges.length) {
                stackEdges[top]++;
                const next = edges[edgeIndex];
                if (!visited[next]) {
                    visited[next] = 1;
                    stackNodes[++top] = next;
                    stackEdges[top] = 0;
                }
            } else {
                order[orderLength++] = nodeIndex;
                top--;
            }
        }
    }
    visited.fill(0);
    const result = [];
    const work = new Int32Array(nodes.length);
    for (let i = orderLength - 1; i >= 0; i--) {
        const root = order[i];
        if (visited[root]) continue;
        let size = 0;
        work[size++] = root; visited[root] = 1;
        const component = [];
        while (size) {
            if ((component.length & 127) === 0) poll();
            const current = work[--size];
            component.push(current);
            for (const next of nodes[current].in) if (!visited[next]) {
                visited[next] = 1;
                work[size++] = next;
            }
        }
        component.sort((a, b) => tupleCompare(nodes[a], nodes[b]));
        result.push(component);
    }
    result.sort((a, b) => tupleCompare(nodes[a[0]], nodes[b[0]]));
    return result;
}

function encodeSpans(areaId, spawnId, nodes, patches, componentId) {
    const patchByNode = new Map();
    for (const patch of patches) for (const node of patch.members) {
        let ids = patchByNode.get(node);
        if (!ids) patchByNode.set(node, ids = []);
        ids.push(patch.id);
    }
    const byRow = new Map();
    for (const [nodeIndex, patchIds] of patchByNode) {
        const node = nodes[nodeIndex];
        const key = `${node.z}:${node.cy}`;
        if (!byRow.has(key)) byRow.set(key, []);
        byRow.get(key).push({ cx: node.cx, patchIds: patchIds.sort() });
    }
    const spans = [];
    const rows = [...byRow.entries()].sort((a, b) => {
        const [az, ay] = a[0].split(':').map(Number), [bz, by] = b[0].split(':').map(Number);
        return az - bz || ay - by;
    });
    for (const [key, cells] of rows) {
        const [layerZ, rowY] = key.split(':').map(Number);
        cells.sort((a, b) => a.cx - b.cx);
        let first = null, previous = null;
        const flush = () => {
            if (!first) return;
            spans.push({ areaId, spawnId, layerZ, rowY, xStart: first.cx, xEnd: previous.cx,
                componentId, patchIds: [...new Set(first.patchIds)].sort() });
        };
        for (const cell of cells) {
            if (previous && (cell.cx !== previous.cx + 1 || cell.patchIds.join('\0') !== previous.patchIds.join('\0'))) {
                flush(); first = null;
            }
            first ||= cell;
            previous = cell;
        }
        flush();
    }
    return spans;
}

// A closed boundary is a native transition fact, not spawn-root admission.
// Retain these components: an authored/native root could already be inside.
function nativeBoundary(component, nodes, Geo, Surface, budget) {
    const members = new Set(component.map(index => `${nodes[index].cx}:${nodes[index].cy}:${nodes[index].z}`));
    const evidence = { status: 'closed', checkedPairs: 0, includesDiagonals: true, includesSameCellLayers: true,
        rootAdmission: 'not_proven' };
    const surfaceBudget = { beforeLayers: () => budget.beforeLayers(), decoded: count => budget.decoded(count),
        walk: () => budget.transition(), transition: () => budget.transition(), poll: () => budget.poll() };
    for (const index of component) {
        const node = nodes[index], from = { locX: node.x, locY: node.y, locZ: node.z };
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const x = ((node.cx + dx) << 4) + 8, y = ((node.cy + dy) << 4) + 8;
            if (!Geo.hasGeo(x, y)) return { ...evidence, status: 'unknown', reason: 'missing_geodata' };
            const layers = Surface.layers(x, y, surfaceBudget);
            if (!layers.length && Geo.getCellData(x, y, from.locZ).nswe !== 0) {
                return { ...evidence, status: 'unknown', reason: 'no_admitted_surface' };
            }
            for (const layer of layers) {
                if (!layer.nswe || members.has(`${node.cx + dx}:${node.cy + dy}:${layer.z}`)) continue;
                const to = { locX: x, locY: y, locZ: layer.z };
                budget.transition(4);
                if ((++evidence.checkedPairs & 127) === 0) budget.poll();
                const outgoing = Geo.walkSegment(from, to, true);
                const incoming = Geo.walkSegment(to, from, true);
                const spawnOut = Surface.walk(from, to, surfaceBudget);
                const spawnIn = Surface.walk(to, from, surfaceBudget);
                if (outgoing?.locZ === to.locZ || incoming?.locZ === from.locZ || spawnOut || spawnIn) {
                    return { ...evidence, status: 'open', witness: { from, to,
                        movementOut: outgoing?.locZ === to.locZ, movementIn: incoming?.locZ === from.locZ,
                        spawnOut: !!spawnOut, spawnIn: !!spawnIn } };
                }
            }
        }
    }
    return evidence;
}

// Extend a small unresolved pocket through native transitions outside its farm
// polygon, without adding farm membership. A closed finite cut is usable only
// after the caller also proves complete native seed/producer ancestry.
function nativeAdmissionClosure(points, Geo, Surface, budget) {
    const key = p => `${p.locX >> 4}:${p.locY >> 4}:${p.locZ}`;
    const states = new Map(points.map(point => [key(point), point]));
    const queue = [...states.values()], origin = queue[0];
    const surfaceBudget = { beforeLayers: () => budget.beforeLayers(), decoded: count => budget.decoded(count),
        walk: () => budget.transition(), transition: () => budget.transition(), poll: () => budget.poll() };
    let expanded = 0, checkedPairs = 0;
    const result = (status, reason = null) => ({ status, reason, expanded, checkedPairs,
        states: [...states.values()].map(p => [p.locX, p.locY, p.locZ]) });
    budget.beginSearch();
    try {
        while (expanded < queue.length) {
            if (expanded >= Format.LIMITS.maxSearchExpansionsPerCall) return result('unknown', 'work_limit');
            const from = queue[expanded++];
            if ((expanded & 127) === 0) budget.searchCheckpoint();
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const x = from.locX + dx * CELL, y = from.locY + dy * CELL;
                if (!Geo.hasGeo(x, y)) return result('unknown', 'missing_geodata');
                const layers = Surface.layers(x, y, surfaceBudget);
                if (!layers.length && Geo.getCellData(x, y, from.locZ).nswe !== 0) return result('unknown', 'no_admitted_surface');
                for (const layer of layers) {
                    if (!layer.nswe) continue;
                    const to = { locX: x, locY: y, locZ: layer.z }, id = key(to);
                    if (states.has(id)) continue;
                    budget.transition(4); checkedPairs++;
                    const movementOut = Geo.walkSegment(from, to, true), movementIn = Geo.walkSegment(to, from, true);
                    const spawnOut = Surface.walk(from, to, surfaceBudget), spawnIn = Surface.walk(to, from, surfaceBudget);
                    if (movementOut?.locZ !== to.locZ && movementIn?.locZ !== from.locZ && !spawnOut && !spawnIn) continue;
                    if (Math.hypot(x - origin.locX, y - origin.locY) > Format.LIMITS.localRadius) return result('unknown', 'limit_reached');
                    states.set(id, to); queue.push(to);
                }
            }
        }
        return result('closed');
    } catch (error) {
        if (error.global || error.code !== 'JOURNEY_BUILD_LIMIT') throw error;
        return result('unknown', 'limit_reached');
    } finally { budget.endSearch({ nodesExpanded: expanded }); }
}

function decomposePolygon({ areaId, spawnId, bounds, fingerprint,
    Geo, Surface, budget, admission, areaContains, excludePoint = null }) {
    const startedAt = performance.now();
    const scan = createBudget({ budget });
    const excluded = { dungeonCells: 0, raidCells: 0, waterOrUnavailable: 0 };
    const stats = { bboxCells: 0, examinedCells: 0, decodedLayers: 0, admittedLayers: 0,
        blockedLayers: 0, outOfZLayers: 0, noSurfaceCells: 0, boundaryFragments: 0,
        unresolvedBoundaryFragments: 0, nonSpawnBoundaryFragments: 0, unresolvedAuthoredPoints: 0,
        ambiguousLayerCells: 0, transitions: 0, components: 0, localPatches: 0,
        localRefinementVisits: 0, maxPatchNodes: 0, durationMs: 0 };
    if (!Array.isArray(bounds) || bounds.length < 3 || bounds.some(point =>
        !point || !['locX', 'locY', 'minZ', 'maxZ'].every(key => Number.isFinite(point[key])) || point.minZ > point.maxZ)) {
        return { status: 'unresolved', reason: 'invalid_input', nodes: [], components: [], patches: [], spans: [], stats, excluded };
    }
    const z = floorRange(bounds);
    const convex = convexPolygon(bounds);
    const minX = Math.min(...bounds.map(point => point.locX)), maxX = Math.max(...bounds.map(point => point.locX));
    const minY = Math.min(...bounds.map(point => point.locY)), maxY = Math.max(...bounds.map(point => point.locY));
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const y0 = Math.floor(minY / CELL), y1 = Math.floor(maxY / CELL);
    const width = x1 - x0 + 1, height = y1 - y0 + 1;
    const cellCount = width * height;
    stats.bboxCells = cellCount;
    if (!Number.isSafeInteger(cellCount) || cellCount < 1 || cellCount > MAX_POLYGON_CELLS) {
        return { status: 'unresolved', reason: 'limit_reached', nodes: [], components: [], patches: [], spans: [], stats, excluded };
    }
    const nodes = [];
    const byCell = new Map();
    const ambiguousCells = new Set();
    const pointInside = areaContains || ((point) => pointInPolygon(point.locX, point.locY, bounds));
    if (!admission) throw new Error('native_spawn_admission_required');
    const boundaryPointCandidates = new Map();
    for (const point of admission.authoredPoints.filter(point => admission.containsXY(point.locX, point.locY))) {
        const key = `${point.locX >> 4}:${point.locY >> 4}`;
        if (!boundaryPointCandidates.has(key)) boundaryPointCandidates.set(key, []);
        boundaryPointCandidates.get(key).push(point);
    }
    for (const points of boundaryPointCandidates.values()) points.sort((a, b) => a.locX - b.locX || a.locY - b.locY || a.locZ - b.locZ);
    const hasLayerData = point => Geo.hasGeo(point.locX, point.locY);
    const nativeBudget = { checkBudget: scan.checkNative };
    try {
        for (let cy = y0; cy <= y1; cy++) {
            for (let cx = x0; cx <= x1; cx++) {
                if ((stats.examinedCells & 127) === 0) budget.poll();
                budget.scan(1);
                stats.examinedCells++;
                const center = { locX: (cx << 4) + 8, locY: (cy << 4) + 8, locZ: z.minZ };
                const admittedXY = admission.randomCentre(center.locX, center.locY) && pointInside(center);
                if (!admittedXY) {
                    const fragment = clipPolygonToCell(bounds, cx, cy);
                    if (fragment) {
                        const boundary = !pointInside(center);
                        if (boundary) stats.boundaryFragments++;
                        const cellKey = `${cx}:${cy}`;
                        const candidates = (boundaryPointCandidates.get(cellKey) || [])
                            .map(point => ({ ...point, expectedZ: point.locZ }));
                        if (!candidates.length) {
                            // Neither centre-only random discovery nor an
                            // authored native point admits this cell fragment.
                            if (boundary) stats.nonSpawnBoundaryFragments++;
                            continue;
                        }
                        const boundaryNodesByZ = new Map();
                        let admitted = 0, boundaryFailure = !convex;
                        const markAmbiguous = () => {
                            if (!ambiguousCells.has(cellKey)) { ambiguousCells.add(cellKey); stats.ambiguousLayerCells++; }
                        };
                        for (const point of candidates) {
                            const normalized = Surface.supported(point, budget);
                            if (!normalized || !pointInside(normalized)) { boundaryFailure = true; continue; }
                            const layers = Surface.layers(point.locX, point.locY, budget);
                            stats.decodedLayers += layers.length;
                            if (!layers.length && !hasLayerData(point)) {
                                stats.noSurfaceCells++;
                                excluded.waterOrUnavailable++;
                            }
                            const seenAtPoint = new Set();
                            let matchedExpected = false;
                            for (const layer of layers) {
                                if (!layer.nswe) { stats.blockedLayers++; continue; }
                                if (!admission.layer(layer.z, layer.nswe) || layer.z !== normalized.locZ) continue;
                                const exclusion = excludePoint?.({ locX: point.locX, locY: point.locY, locZ: layer.z });
                                if (exclusion) {
                                    if (exclusion === 'dungeon') excluded.dungeonCells++;
                                    else if (exclusion === 'raid') excluded.raidCells++;
                                    continue;
                                }
                                matchedExpected = true;
                                if (seenAtPoint.has(layer.z)) { markAmbiguous(); continue; }
                                seenAtPoint.add(layer.z);
                                const existing = boundaryNodesByZ.get(layer.z);
                                if (existing !== undefined) {
                                    const node = nodes[existing];
                                    if (node.x !== point.locX || node.y !== point.locY) {
                                        const firstPoint = { locX: node.x, locY: node.y, locZ: layer.z };
                                        const nextPoint = { locX: point.locX, locY: point.locY, locZ: layer.z };
                                        if (!segmentInsidePolygon(firstPoint, nextPoint, bounds)) { boundaryFailure = true; continue; }
                                        budget.transition(2); stats.transitions += 2;
                                        const forward = Geo.walkSegment(firstPoint, nextPoint, true, nativeBudget);
                                        const reverse = Geo.walkSegment(nextPoint, firstPoint, true, nativeBudget);
                                        if (!forward || forward.locZ !== layer.z || !reverse || reverse.locZ !== layer.z) boundaryFailure = true;
                                    }
                                    continue;
                                }
                                if (nodes.length >= 16000000) throw Object.assign(Error('polygon_layer_state_limit'), { reason: 'limit_reached' });
                                nodes.push({ cx, cy, z: layer.z, x: point.locX, y: point.locY, out: [], outCosts: [], in: [], inCosts: [], boundaryPoint: true });
                                if (!byCell.has(cellKey)) byCell.set(cellKey, []);
                                const nodeIndex = nodes.length - 1;
                                byCell.get(cellKey).push(nodeIndex);
                                boundaryNodesByZ.set(layer.z, nodeIndex);
                                stats.admittedLayers++;
                                admitted++;
                            }
                            if (Number.isFinite(point.expectedZ) && !matchedExpected) boundaryFailure = true;
                        }
                        if (!admitted || boundaryFailure) stats.unresolvedBoundaryFragments++;
                    }
                    continue;
                }
                const values = Surface.layers(center.locX, center.locY, budget);
                stats.decodedLayers += values.length;
                if (!values.length) {
                    stats.noSurfaceCells++;
                    if (!hasLayerData(center)) excluded.waterOrUnavailable++;
                    continue;
                }
                let admitted = 0;
                const seenZ = new Set();
                for (const layer of values) {
                    if (!layer.nswe) { stats.blockedLayers++; continue; }
                    if (!admission.layer(layer.z, layer.nswe)) { stats.outOfZLayers++; continue; }
                    const exclusion = excludePoint?.({ locX: center.locX, locY: center.locY, locZ: layer.z });
                    if (exclusion) {
                        if (exclusion === 'dungeon') excluded.dungeonCells++;
                        else if (exclusion === 'raid') excluded.raidCells++;
                        continue;
                    }
                    const cellKey = `${cx}:${cy}`;
                    if (seenZ.has(layer.z)) {
                        if (!ambiguousCells.has(cellKey)) { ambiguousCells.add(cellKey); stats.ambiguousLayerCells++; }
                        continue;
                    }
                    seenZ.add(layer.z);
                    if (nodes.length >= 16000000) throw Object.assign(Error('polygon_layer_state_limit'), { reason: 'limit_reached' });
                    const node = { cx, cy, z: layer.z, x: center.locX, y: center.locY, out: [], outCosts: [], in: [], inCosts: [] };
                    nodes.push(node);
                    if (!byCell.has(cellKey)) byCell.set(cellKey, []);
                    byCell.get(cellKey).push(nodes.length - 1);
                    admitted++;
                    stats.admittedLayers++;
                }
                if (!admitted) stats.noSurfaceCells++;
            }
        }
        for (const points of boundaryPointCandidates.values()) for (const point of points) {
            const normalized = Surface.supported(point, budget);
            if (!normalized || !pointInside(normalized)) { stats.unresolvedAuthoredPoints++; continue; }
            if (excludePoint?.(normalized)) continue;
            const cellNodes = byCell.get(`${normalized.locX >> 4}:${normalized.locY >> 4}`) || [];
            const representative = cellNodes.map(index => nodes[index]).find(node => node.z === normalized.locZ);
            if (!representative) { stats.unresolvedAuthoredPoints++; continue; }
            const centre = { locX: representative.x, locY: representative.y, locZ: representative.z };
            budget.transition(2);
            const forward = Geo.walkSegment(centre, normalized, true, nativeBudget);
            const reverse = Geo.walkSegment(normalized, centre, true, nativeBudget);
            if (!segmentInsidePolygon(centre, normalized, bounds) || !forward || !reverse
                || forward.locZ !== normalized.locZ || reverse.locZ !== centre.locZ) stats.unresolvedAuthoredPoints++;
        }
        if (nodes.length > 16000000) throw Object.assign(Error('polygon_layer_state_limit'), { reason: 'limit_reached' });
        for (let from = 0; from < nodes.length; from++) {
            if ((from & 127) === 0) budget.poll();
            const source = nodes[from];
            const sourcePoint = { locX: source.x, locY: source.y, locZ: source.z };
            for (const [dx, dy] of DIRECTIONS) {
                budget.transition();
                stats.transitions++;
                const neighbors = byCell.get(`${source.cx + dx}:${source.cy + dy}`);
                if (!neighbors) continue;
                const targetX = ((source.cx + dx) << 4) + 8, targetY = ((source.cy + dy) << 4) + 8;
                for (const to of neighbors) {
                    const target = nodes[to];
                    if (Math.abs(target.z - source.z) > 64) continue;
                    const targetPoint = { locX: target.x === undefined ? targetX : target.x,
                        locY: target.y === undefined ? targetY : target.y, locZ: target.z };
                    if (!segmentInsidePolygon(sourcePoint, targetPoint, bounds)) continue;
                    const result = Geo.walkSegment(sourcePoint, targetPoint, true, nativeBudget);
                    if (!result || result.locZ !== target.z) continue;
                    const cost = Math.hypot(target.x - source.x, target.y - source.y, target.z - source.z);
                    source.out.push(to); source.outCosts.push(cost);
                    target.in.push(from); target.inCosts.push(cost);
                }
            }
        }
        const rawComponents = stronglyConnected(nodes, () => budget.poll());
        const components = [], patches = [], spans = [], componentByNode = new Int32Array(nodes.length);
        componentByNode.fill(-1);
        for (const [index, component] of rawComponents.entries()) {
            if (components.length >= Format.LIMITS.components) throw Object.assign(Error('component_count_limit'), { reason: 'limit_reached' });
            const first = nodes[component[0]];
            const digest = createHash('sha256').update(`${fingerprint}\0${first.cx},${first.cy},${first.z}`).digest('hex').slice(0, 16);
            const componentId = `${areaId}/${spawnId}/${digest}`;
            component.forEach(node => { componentByNode[node] = index; });
            const local = patchComponent(component, nodes, componentId, { poll: () => budget.poll(),
                expand: () => budget.localExpand(), refine: () => budget.refine() });
            const entryAnchorIds = [];
            const componentRecord = { id: componentId, areaId, spawnId, nodeCount: component.length,
                nativeBoundary: nativeBoundary(component, nodes, Geo, Surface, budget),
                entryAnchorIds, patchIds: local.patches.map(patch => patch.id), status: local.supported ? 'supported' : 'unresolved',
                reason: local.reason };
            components.push(componentRecord);
            stats.localRefinementVisits += local.refinementVisits;
            if (!local.patches.length) continue;
            const encoded = encodeSpans(areaId, spawnId, nodes, local.patches, componentId);
            const startIndex = spans.length;
            spans.push(...encoded);
            for (const patch of local.patches) {
                stats.localPatches++;
                stats.maxPatchNodes = Math.max(stats.maxPatchNodes, patch.nodeCount);
                const record = { id: patch.id, componentId, anchor: patch.anchor, nodeCount: patch.nodeCount,
                    maxPathDistance: patch.maxPathDistance, maxXYRadius: patch.maxXYRadius,
                    membershipSpanIndices: [] };
                patches.push(record);
                record.membershipSpanIndices = encoded.flatMap((span, index) => span.patchIds.includes(patch.id)
                    ? [startIndex + index] : []);
            }
        }
        // The condensation links preserve direction; SCC identity never merges
        // floors or overlaps, and an isolated component remains explicit.
        const condensation = new Set();
        for (let from = 0; from < nodes.length; from++) for (const to of nodes[from].out) {
            const a = componentByNode[from], b = componentByNode[to];
            if (a !== b) condensation.add(`${a}:${b}`);
        }
        for (const value of condensation) {
            const [from, to] = value.split(':').map(Number);
            components[from].outgoingComponentIds ||= [];
            components[from].outgoingComponentIds.push(components[to].id);
        }
        for (const component of components) component.outgoingComponentIds?.sort();
        stats.components = components.length;
        stats.durationMs = Math.round(performance.now() - startedAt);
        const incomplete = nodes.length === 0 || stats.unresolvedBoundaryFragments > 0 || stats.unresolvedAuthoredPoints > 0
            || stats.ambiguousLayerCells > 0
            || components.some(component => component.status !== 'supported');
        return { status: incomplete ? 'unresolved' : 'supported', reason: incomplete
            ? (stats.unresolvedBoundaryFragments || stats.unresolvedAuthoredPoints ? 'boundary_fragment_unresolved'
                : stats.ambiguousLayerCells ? 'ambiguous_layer'
                : components.find(component => component.status !== 'supported')?.reason || 'no_admitted_surface') : null,
            nodes, components, patches, spans, stats, excluded, condensation: [...condensation].map(value => value.split(':').map(Number)) };
    } catch (error) {
        if (error?.global || error?.code === 'JOURNEY_BUILD_LIMIT') throw error;
        const reason = error?.reason;
        if (!['limit_reached', 'anchor_limit', 'boundary_fragment_unresolved', 'ambiguous_layer'].includes(reason)) throw error;
        stats.durationMs = Math.round(performance.now() - startedAt);
        return { status: 'unresolved', reason, nodes: [], components: [], patches: [], spans: [], stats, excluded,
            diagnostic: String(error.message || error).slice(0, 300) };
    }
}

module.exports = { decomposePolygon, nativeAdmissionClosure, pointInPolygon, stronglyConnected };
});
