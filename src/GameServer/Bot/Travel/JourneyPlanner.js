const TravelRoutes = require('./TravelRoutes');
const TownRespawn = require('../../World/TownRespawn');
const Karma = require('../../Karma');

const ENTRY_LIMIT = 3;
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
        let transferDistance = 0;
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
                transferDistance += bestDistance;
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
            route, sources: Object.freeze(sources), transferDistance, requiredAdena,
            exit, exitKey: landingKey(exit)
        }));
    }
    return Object.freeze(result);
}

// Construct ONCE after authored service rows are loaded, using
// TownServiceCatalog.rows(ROLES.GATEKEEPER), never targetFromRow/live actors.
// The returned planner is immutable static data plus pure per-goal selection;
// no world scans, geodata, timers, inventory effects or session mutation.
function create(gatekeeperRows) {
    const sources = compileSources(gatekeeperRows);
    const byNpc = new Map();
    for (const source of sources) {
        if (!byNpc.has(source.npcId)) byNpc.set(source.npcId, []);
        byNpc.get(source.npcId).push(source);
    }
    const entries = sources.map(source => Object.freeze({ source, routes: compileRoutes(source, byNpc) }));

    function plan({ from, to, speed, adena, remainingFare = Infinity, karma = 0, scrollCount = 0,
        allowedModes = ['walk', 'gatekeeper', 'recall'], arrival = { xy: 96, z: 128 }, exclusions = {} }) {
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
        const walkingMs = (first, second) => distance(first, second) / speed * 1000;
        const candidates = [];
        const direct = modes.has('walk') && !exclusions.directWalk
            ? { key: '0:walk', mode: 'walk', fee: 0, hops: 0, etaMs: walkingMs(from, to), landing: from }
            : null;
        if (direct) candidates.push(direct);
        const transportAllowed = !Karma.closesTowns(karma);
        const recall = transportAllowed && modes.has('recall') && scrollCount >= 1 && !exclusions.recall
            ? pointOf(TownRespawn.getRespawnCoords(from.locX, from.locY, from.locZ)) : null;
        const recallMs = RECALL_CAST_MS + TELEPORT_MS;
        if (recall && !excluded.exits.has(landingKey(recall))) {
            candidates.push({ key: '1:recall', mode: 'recall_walk', fee: 0, hops: 0,
                etaMs: recallMs + walkingMs(recall, to), landing: recall, recall });
        }

        function addTransport(origin, selectedEntries, recallLanding = null) {
            for (const entry of selectedEntries) {
                const approachMs = walkingMs(origin, entry.source);
                for (const compiled of entry.routes) {
                    const { route, sources: hopSources, exit } = compiled;
                    if (route.fee > remainingFare || compiled.requiredAdena > adena
                        || excluded.exits.has(compiled.exitKey)
                        || hopSources.some(source => excluded.sources.has(source.key))
                        || route.steps.some(step => excluded.edges.has(step.key))) continue;
                    const etaMs = (recallLanding ? recallMs : 0) + approachMs
                        + compiled.transferDistance / speed * 1000
                        + route.hops * (TELEPORT_MS + INTERACTION_MS) + walkingMs(exit, to);
                    if (route.fee > 0 && direct && (direct.etaMs - etaMs < MIN_SAVING_MS
                        || etaMs > direct.etaMs * (1 - MIN_SAVING_RATIO))) continue;
                    candidates.push({ key: `${recallLanding ? '3' : '2'}:${entry.source.key}:${route.key}`,
                        mode: recallLanding ? 'recall_gatekeeper' : 'gatekeeper', fee: route.fee,
                        hops: route.hops, etaMs, landing: exit, compiled, recall: recallLanding });
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
        if (!candidates.length) return { status: 'blocked', reason: 'no_permitted_route', legs: [] };
        const fastest = Math.min(...candidates.map(candidate => candidate.etaMs));
        const selected = candidates.filter(candidate => candidate.etaMs <= fastest * (1 + NEAR_BEST_RATIO))
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
