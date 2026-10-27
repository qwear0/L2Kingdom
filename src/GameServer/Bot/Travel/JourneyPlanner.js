const TravelRoutes = require('./TravelRoutes');
const TownRespawn = require('../../World/TownRespawn');
const Karma = require('../../Karma');

const ENTRY_LIMIT = 3;
const ROUTE_PROBE_LIMIT = 6;
const KEEPER_ARRIVAL = Object.freeze({ xy: 96, z: 128 });
const DEFERRED_CODES = new Set(['QUEUE_FULL', 'PATH_PREEMPTED', 'PATH_TIMEOUT', 'PATH_BUDGET',
    'PATH_NODE_LIMIT', 'WORKER_UNAVAILABLE', 'WORKER_EXIT', 'POOL_SHUTDOWN', 'GEODATA_MISSING']);
const PAID_HOP_THRESHOLD = 50000;
const MIN_SAVING_MS = 30000;
const MIN_SAVING_RATIO = 0.2;
const NEAR_BEST_RATIO = 0.2;
// Native SoE skill 2013 and TeleportTo publication timing; interaction is the
// midpoint of TownTransitPolicy's 700–1599 ms dwell. These are ETA estimates,
// not permission to skip live casting/contact/arrival checks.
const RECALL_CAST_MS = 20000;
const TELEPORT_MS = 1000;
const INTERACTION_MS = 1150;
const SCROLL_OF_ESCAPE = 736;
const MODES = new Set(['walk', 'gatekeeper', 'recall']);

function pointOf(value) {
    if (!value || !['locX', 'locY', 'locZ'].every(key => Number.isFinite(value[key]))) {
        throw new TypeError('Journey points require finite locX, locY and locZ');
    }
    return Object.freeze({ locX: value.locX, locY: value.locY, locZ: value.locZ });
}

function distance(from, to) {
    return Math.hypot(from.locX - to.locX, from.locY - to.locY, from.locZ - to.locZ);
}

function landingKey(point) {
    return `${point.locX}:${point.locY}:${point.locZ}`;
}

function compareKey(left, right) {
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function nonnegative(value, name, allowInfinity = false) {
    if ((!Number.isFinite(value) && !(allowInfinity && value === Infinity)) || value < 0) {
        throw new TypeError(`${name} must be nonnegative${allowInfinity ? ' or Infinity' : ' and finite'}`);
    }
}

function compileSources(rows) {
    const seen = new Set();
    const sources = [];
    for (const row of rows) {
        const npcId = Number(row.npcSelfId);
        const townKey = TravelRoutes.GATEKEEPER_TOWNS[npcId];
        if (!townKey) continue;
        const point = pointOf(row);
        const key = `${npcId}:${landingKey(point)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push(Object.freeze({ key, npcId, townKey, name: row.name, ...point }));
    }
    return sources.sort(compareKey);
}

function compileRoutes(entry, byNpc) {
    const result = [];
    for (const route of TravelRoutes.exitRoutes(entry.townKey)) {
        if (route.steps[0].npcId !== entry.npcId) continue;
        const sources = [entry];
        const transferWalks = [];
        let requiredAdena = 0;
        let paid = 0;
        for (let index = 0; index < route.steps.length; index++) {
            const step = route.steps[index];
            if (index > 0) {
                const previous = route.steps[index - 1];
                const choices = byNpc.get(step.npcId) || [];
                let closest = null;
                let bestDistance = Infinity;
                for (const source of choices) {
                    const measured = distance(previous, source);
                    if (measured < bestDistance) {
                        closest = source;
                        bestDistance = measured;
                    }
                }
                if (!closest) break;
                sources.push(closest);
                transferWalks.push(Object.freeze({ from: pointOf(previous), to: pointOf(closest), arrival: KEEPER_ARRIVAL }));
            }
            if (step.fee > 0) {
                // The threshold applies BEFORE each debit, not to the remainder.
                // This is the exact minimum starting wallet for this hop list.
                requiredAdena = Math.max(requiredAdena, paid + PAID_HOP_THRESHOLD, paid + step.fee);
            }
            paid += step.fee;
        }
        if (sources.length !== route.steps.length) continue;
        const exit = route.steps[route.steps.length - 1];
        result.push(Object.freeze({
            route, sources: Object.freeze(sources), transferWalks: Object.freeze(transferWalks), requiredAdena,
            exit, exitKey: landingKey(exit)
        }));
    }
    return Object.freeze(result);
}

// Construct ONCE after authored service rows are loaded, using
// TownServiceCatalog.rows(ROLES.GATEKEEPER), never targetFromRow/live actors.
// Static candidates are shared; per-goal selection requests injected walk
// costs asynchronously. No live-world scans or gameplay effects belong here.
function create(gatekeeperRows) {
    const sources = compileSources(gatekeeperRows);
    const byNpc = new Map();
    for (const source of sources) {
        if (!byNpc.has(source.npcId)) byNpc.set(source.npcId, []);
        byNpc.get(source.npcId).push(source);
    }
    const entries = sources.map(source => Object.freeze({ source, routes: compileRoutes(source, byNpc) }));

    async function plan({ from, to, speed, adena, remainingFare = Infinity, karma = 0, scrollCount = 0,
        allowedModes = ['walk', 'gatekeeper', 'recall'], arrival = { xy: 96, z: 128 }, exclusions = {} }, measureWalk) {
        if (typeof measureWalk !== 'function') throw new TypeError('Journey planning requires measured walking costs');
        from = pointOf(from);
        to = pointOf(to);
        if (!Number.isFinite(speed) || speed <= 0) throw new TypeError('Journey speed must be positive and finite');
        nonnegative(adena, 'Adena');
        nonnegative(remainingFare, 'Remaining fare', true);
        nonnegative(scrollCount, 'Scroll count');
        nonnegative(karma, 'Karma');
        nonnegative(arrival.xy, 'XY arrival tolerance');
        nonnegative(arrival.z, 'Z arrival tolerance');
        arrival = Object.freeze({ xy: arrival.xy, z: arrival.z });
        const modes = new Set(allowedModes);
        for (const mode of modes) if (!MODES.has(mode)) throw new TypeError(`Unknown journey mode: ${mode}`);
        const excluded = {
            entries: new Set(exclusions.entries || []),
            sources: new Set(exclusions.sources || []),
            edges: new Set(exclusions.edges || []),
            exits: new Set(exclusions.exits || [])
        };
        const walk = (first, second, tolerance = arrival) => ({ from: first, to: second, arrival: tolerance });
        const lowerBound = segment => Math.max(0, distance(segment.from, segment.to)
            - Math.hypot(segment.arrival.xy, segment.arrival.z)) / speed * 1000;
        const candidate = (values, walks, fixedMs = 0) => ({ ...values, walks, fixedMs,
            lowerBoundMs: fixedMs + walks.reduce((total, segment) => total + lowerBound(segment), 0) });
        const candidates = [];
        const direct = modes.has('walk') && !exclusions.directWalk
            ? candidate({ key: '0:walk', mode: 'walk', fee: 0, hops: 0, landing: from }, [walk(from, to)])
            : null;
        const transportAllowed = !Karma.closesTowns(karma);
        const recall = transportAllowed && modes.has('recall') && scrollCount >= 1 && !exclusions.recall
            ? pointOf(TownRespawn.getRespawnCoords(from.locX, from.locY, from.locZ)) : null;
        const recallMs = RECALL_CAST_MS + TELEPORT_MS;
        if (recall && !excluded.exits.has(landingKey(recall))) {
            candidates.push(candidate({ key: '1:recall', mode: 'recall_walk', fee: 0, hops: 0,
                landing: recall, recall }, [walk(recall, to)], recallMs));
        }

        function addTransport(origin, selectedEntries, recallLanding = null) {
            for (const entry of selectedEntries) {
                for (const compiled of entry.routes) {
                    const { route, sources: hopSources, exit } = compiled;
                    if (route.fee > remainingFare || compiled.requiredAdena > adena
                        || excluded.exits.has(compiled.exitKey)
                        || hopSources.some(source => excluded.sources.has(source.key))
                        || route.steps.some(step => excluded.edges.has(step.key))) continue;
                    candidates.push(candidate({ key: `${recallLanding ? '3' : '2'}:${entry.source.key}:${route.key}`,
                        mode: recallLanding ? 'recall_gatekeeper' : 'gatekeeper', fee: route.fee,
                        hops: route.hops, landing: exit, compiled, recall: recallLanding },
                    [walk(origin, entry.source, KEEPER_ARRIVAL), ...compiled.transferWalks, walk(exit, to)],
                    (recallLanding ? recallMs : 0) + route.hops * (TELEPORT_MS + INTERACTION_MS)));
                }
            }
        }

        if (transportAllowed && modes.has('gatekeeper')) {
            const available = entries.filter(entry => !excluded.entries.has(entry.source.key)
                && !excluded.sources.has(entry.source.key));
            const nearest = (origin, choices) => [...choices].sort((left, right) =>
                distance(origin, left.source) - distance(origin, right.source) || compareKey(left.source, right.source))
                .slice(0, ENTRY_LIMIT);
            addTransport(from, nearest(from, available));
            if (recall) {
                const townKey = TravelRoutes.townKey(TravelRoutes.landingTown(from));
                addTransport(recall, nearest(recall, available.filter(entry => entry.source.townKey === townKey)), recall);
            }
        }
        if (!direct && !candidates.length) return { status: 'blocked', reason: 'no_permitted_route', legs: [] };
        const verified = [], walkCosts = new Map();
        let deferred = null, directMs = null, fastest = Infinity, probed = direct ? 1 : 0;
        async function measure(option) {
            let etaMs = option.fixedMs;
            try {
                for (const segment of option.walks) {
                    const key = [segment.from.locX, segment.from.locY, segment.from.locZ,
                        segment.to.locX, segment.to.locY, segment.to.locZ, segment.arrival.xy, segment.arrival.z].join(':');
                    if (!walkCosts.has(key)) walkCosts.set(key, measureWalk(segment.from, segment.to, segment.arrival));
                    const length = await walkCosts.get(key);
                    if (length === null) return null;
                    if (!Number.isFinite(length) || length < 0) throw Error('journey_path_cost_invalid');
                    etaMs += length / speed * 1000;
                }
                return { ...option, etaMs };
            } catch (error) {
                if (!DEFERRED_CODES.has(error.code)) throw error;
                deferred ||= error.code;
                return null;
            }
        }
        if (direct) {
            const measured = await measure(direct);
            if (measured) {
                verified.push(measured);
                fastest = directMs = measured.etaMs;
            } else if (deferred) {
                // A work limit is not disconnected terrain. This lower bound
                // may conservatively prove savings, but never becomes an ETA
                // or an executable route without a complete measured walk.
                directMs = direct.lowerBoundMs;
            }
        }
        const savesEnough = (option, etaMs) => !option.fee || directMs === null
            || directMs - etaMs >= MIN_SAVING_MS && etaMs <= directMs * (1 - MIN_SAVING_RATIO);
        candidates.sort((a, b) => a.lowerBoundMs - b.lowerBoundMs || a.fee - b.fee || compareKey(a, b));
        for (const option of candidates) {
            // Once there is a usable route, cap alternatives rather than
            // probing the whole network. Without one, keep looking for a
            // verified fallback; unknown work never becomes a fake route.
            if ((probed >= ROUTE_PROBE_LIMIT && verified.length) || option.lowerBoundMs > fastest * (1 + NEAR_BEST_RATIO)) break;
            if (!savesEnough(option, option.lowerBoundMs)) continue;
            probed++;
            const measured = await measure(option);
            if (!measured || !savesEnough(option, measured.etaMs)) continue;
            verified.push(measured);
            fastest = Math.min(fastest, measured.etaMs);
        }
        if (!verified.length) return deferred
            ? { status: 'waiting', reason: deferred === 'GEODATA_MISSING' ? 'geodata_missing' : 'route_estimate_deferred', legs: [] }
            : { status: 'blocked', reason: 'no_permitted_route', legs: [] };
        const selected = verified.filter(option => option.etaMs <= fastest * (1 + NEAR_BEST_RATIO))
            .sort((left, right) => left.fee - right.fee || left.hops - right.hops || compareKey(left, right))[0];

        // Only the selected itinerary becomes executable legs. A gatekeeper
        // leg owns its approach: inter-hop walking is NOT a separate walk leg.
        const legs = [];
        if (selected.recall) legs.push({ type: 'recall', itemId: SCROLL_OF_ESCAPE,
            castMs: RECALL_CAST_MS, landingHint: selected.recall, replanOnArrival: true });
        if (selected.compiled) {
            selected.compiled.route.steps.forEach((step, index) => {
                legs.push({ type: 'gatekeeper', source: selected.compiled.sources[index], edgeKey: step.key,
                    npcId: step.npcId, destinationId: step.destinationId, label: step.label,
                    fee: step.fee, landing: pointOf(step) });
            });
        }
        legs.push({ type: 'walk', target: to, arrival,
            accessKey: selected.mode === 'walk' ? 'direct' : landingKey(selected.landing) });
        return { status: 'planned', key: selected.key, mode: selected.mode,
            fee: selected.fee, hops: selected.hops, etaMs: selected.etaMs, legs };
    }

    return Object.freeze({ plan });
}

module.exports = { create };
