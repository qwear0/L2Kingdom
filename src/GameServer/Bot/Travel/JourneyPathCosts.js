const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const WorkerPool = invoke('GameServer/Geodata/PathfindingWorkerPool');

const CACHE_LIMIT = 512;
const CACHE_TTL_MS = 120000;
const NEGATIVE_TTL_MS = 10000;
const services = new WeakMap();

// Exact XYZ/tolerances prevent a nearby wall or another floor from borrowing
// a successful estimate. Cache lengths, not actor speed, wallets or paths.
class JourneyPathCosts {
    constructor(pool) {
        this.pool = pool;
        this.cache = new Map();
        this.pending = new Map();
        this.sequence = 0;
    }

    measure(from, to, arrival, owner) {
        if (owner.cancelled) return Promise.reject(Object.assign(Error('journey estimate cancelled'), { code: 'STALE_PATH' }));
        const revision = Geodata.navigationRevision || 0;
        const key = [revision, from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ, arrival.xy, arrival.z].join(':');
        const cached = this.cache.get(key);
        if (cached?.until > Date.now()) return Promise.resolve(cached.distance);
        if (cached) this.cache.delete(key);
        let group = this.pending.get(key);
        if (!group) {
            group = { key, workerKey: `journey-estimate:${++this.sequence}`, owners: new Set() };
            this.pending.set(key, group);
            group.promise = this.pool.request({
                startX: from.locX, startY: from.locY, startZ: from.locZ,
                endX: to.locX, endY: to.locY, endZ: to.locZ,
                goalRadius: arrival.xy, goalZTolerance: arrival.z,
                maxNodes: 120000, heuristicWeight: 1.25,
                journeyEstimate: true, navigationRevision: revision
            }, { key: group.workerKey, priority: -10, timeoutMs: 5000 }).then(distance => {
                if (revision !== (Geodata.navigationRevision || 0)) {
                    throw Object.assign(Error('journey navigation changed'), { code: 'STALE_PATH' });
                }
                if (distance !== null && (!Number.isFinite(distance) || distance < 0)) throw Error('journey_path_cost_invalid');
                if (this.pending.get(key) === group) {
                    while (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
                    this.cache.set(key, { distance, until: Date.now() + (distance === null ? NEGATIVE_TTL_MS : CACHE_TTL_MS) });
                }
                return distance;
            }).finally(() => {
                if (this.pending.get(key) === group) this.pending.delete(key);
            });
        }
        group.owners.add(owner);
        owner.group = group;
        return group.promise.finally(() => {
            group.owners.delete(owner);
            if (owner.group === group) owner.group = null;
        });
    }

    cancel(owner) {
        owner.cancelled = true;
        const group = owner.group;
        owner.group = null;
        if (!group) return;
        group.owners.delete(owner);
        if (!group.owners.size && this.pending.get(group.key) === group) {
            this.pending.delete(group.key);
            this.pool.cancel(group.workerKey);
        }
    }
}

function forPool(pool = WorkerPool) {
    if (!services.has(pool)) services.set(pool, new JourneyPathCosts(pool));
    return services.get(pool);
}

module.exports = { forPool };
