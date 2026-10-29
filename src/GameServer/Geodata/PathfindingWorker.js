require('../../Global');

const { parentPort, workerData, threadId } = require('worker_threads');
const { randomUUID } = require('crypto');
const workerIdentity = Object.freeze({ instanceId: randomUUID(), threadId, startedAt: Date.now(),
    nodeVersion: process.versions.node, build: null, buildSource: 'not_recorded_no_disk_inference' });
invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics = workerData?.developerDiagnostics === true;
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const TownPathCorridor = invoke('GameServer/Geodata/TownPathCorridor');

GeodataEngine.init();
let navigationRevision = null;

function journeyDistance(request, checkBudget) {
    const from = { locX: request.startX, locY: request.startY, locZ: request.startZ };
    const to = { locX: request.endX, locY: request.endY, locZ: request.endZ };
    const distance = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY, a.locZ - b.locZ);
    const requireGeodata = (a, b) => {
        // Missing regions are permissive in ordinary movement. They cannot
        // establish a connected route for a fare/ETA decision. Check every
        // crossed region, including tiny corner crossings between samples.
        const cuts = [0, 1];
        for (const axis of ['locX', 'locY']) {
            const delta = b[axis] - a[axis];
            if (!delta) continue;
            for (let edge = (Math.floor(Math.min(a[axis], b[axis]) / 32768) + 1) * 32768;
                edge < Math.max(a[axis], b[axis]); edge += 32768) cuts.push((edge - a[axis]) / delta);
        }
        cuts.sort((a, b) => a - b);
        for (let i = 0; i < cuts.length; i++) {
            const t = i ? (cuts[i - 1] + cuts[i]) / 2 : cuts[i];
            const x = a.locX + (b.locX - a.locX) * t, y = a.locY + (b.locY - a.locY) * t;
            GeodataEngine.getHeight(x, y, a.locZ);
            if (!GeodataEngine.hasGeo(x, y)) throw Object.assign(Error('journey geodata missing'), { code: 'GEODATA_MISSING' });
        }
        GeodataEngine.getHeight(b.locX, b.locY, b.locZ);
        if (!GeodataEngine.hasGeo(b.locX, b.locY)) throw Object.assign(Error('journey geodata missing'), { code: 'GEODATA_MISSING' });
    };
    requireGeodata(from, from);
    requireGeodata(to, to);
    checkBudget();
    if (Math.hypot(from.locX - to.locX, from.locY - to.locY) <= request.goalRadius
        && Math.abs(from.locZ - to.locZ) <= request.goalZTolerance) return 0;
    const direct = GeodataEngine.walkSegment(from, to);
    if (direct) {
        requireGeodata(from, direct);
        checkBudget();
        return distance(from, direct);
    }
    const path = GeodataEngine.findPath(from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ,
        request.maxNodes, { debug: false, goalRadius: request.goalRadius, goalZTolerance: request.goalZTolerance,
            heuristicWeight: request.heuristicWeight, requireComplete: true, fastSmoothing: true, checkBudget });
    if (!path?.length) return null;
    let total = 0, previous = from;
    for (const point of path) {
        checkBudget();
        requireGeodata(previous, point);
        if (!GeodataEngine.walkSegment(previous, point)) return null;
        total += distance(previous, point);
        previous = point;
    }
    checkBudget();
    return total;
}

parentPort.on('message', (message) => {
    if (!message || message.type !== 'path') return;
    const { id, request } = message;
    if (request.townCorridor || request.journeyEstimate) {
        if (navigationRevision !== null && navigationRevision !== request.navigationRevision) GeodataEngine.init();
        navigationRevision = request.navigationRevision;
    }
    const search = request.evidence === true ? { stopReason: 'NOT_STARTED', searchComplete: null,
        nodesExpanded: null, maxNodes: request.maxNodes, goalReached: null, missingGeodata: null } : null;
    const timed = !!search || request.townCorridor || request.journeyEstimate || workerData?.developerDiagnostics === true;
    const startedAt = timed ? performance.now() : null;
    const cancelFlag = message.cancelBuffer ? new Int32Array(message.cancelBuffer) : null;
    const checkBudget = () => {
        const cancelled = cancelFlag && Atomics.load(cancelFlag, 0) !== 0;
        if (cancelled || ((request.townCorridor || request.journeyEstimate) && performance.now() - startedAt > 150)) {
            throw Object.assign(new Error(cancelled ? 'path cancelled' : 'path work budget exceeded'), {
                code: cancelled ? 'STALE_PATH' : 'PATH_BUDGET'
            });
        }
    };
    try {
        checkBudget();
        const path = request.journeyEstimate ? journeyDistance(request, checkBudget) : GeodataEngine.findPath(
            request.startX,
            request.startY,
            request.startZ,
            request.endX,
            request.endY,
            request.endZ,
            request.maxNodes,
            {
                debug: false,
                goalRadius: request.goalRadius,
                goalZTolerance: request.goalZTolerance,
                heuristicWeight: request.heuristicWeight,
                evidence: search,
                checkBudget
            }
        );
        const result = request.townCorridor ? TownPathCorridor.build(path, checkBudget) : path;
        parentPort.postMessage({ id, ok: true, path: result, workerMs: timed ? performance.now() - startedAt : null,
            ...(search ? { evidence: { search, worker: workerIdentity, navigation: GeodataEngine.inputIdentity() } } : {}) });
    } catch (error) {
        parentPort.postMessage({
            id,
            ok: false,
            code: error?.code,
            workerMs: timed ? performance.now() - startedAt : null,
            error: error?.message || String(error),
            ...(search ? { evidence: { search: { ...search, stopReason: error?.code || 'PATH_WORKER_ERROR' },
                worker: workerIdentity, navigation: GeodataEngine.inputIdentity() } } : {})
        });
    }
});
