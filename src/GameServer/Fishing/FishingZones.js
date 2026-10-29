const data = require('../../../data/Fishing/zones.json');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const CELL = 4096;

function index(zones, polygon) {
    const cells = new Map();
    for (const source of zones) {
        if (!source.nodes?.length || !Number.isFinite(source.minZ) || !Number.isFinite(source.maxZ))
            throw Error('invalid_fishing_zone');
        const zone = { ...source, polygon,
            minX: Math.min(...source.nodes.map(n => n[0])), maxX: Math.max(...source.nodes.map(n => n[0])),
            minY: Math.min(...source.nodes.map(n => n[1])), maxY: Math.max(...source.nodes.map(n => n[1])) };
        zone.nodes.forEach(Object.freeze);
        Object.freeze(zone.nodes);
        Object.freeze(zone);
        for (let x = Math.floor(zone.minX / CELL); x <= Math.floor(zone.maxX / CELL); x++) {
            for (let y = Math.floor(zone.minY / CELL); y <= Math.floor(zone.maxY / CELL); y++) {
                const key = `${x}:${y}`;
                if (!cells.has(key)) cells.set(key, []);
                cells.get(key).push(zone);
            }
        }
    }
    return cells;
}

const fishing = index(data.fishing, true);
const water = index(data.water, false);
const EMPTY = Object.freeze([]);
const candidates = (cells, x, y) => cells.get(`${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`) || EMPTY;

function contains(zone, x, y) {
    if (x < zone.minX || x > zone.maxX || y < zone.minY || y > zone.maxY) return false;
    if (!zone.polygon) return true;
    let inside = false;
    const nodes = zone.nodes;
    for (let i = 0, j = nodes.length - 1; i < nodes.length; j = i++) {
        const [xi, yi] = nodes[i], [xj, yj] = nodes[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function findHook(actor) {
    const x = actor.fetchLocX(), y = actor.fetchLocY(), z = actor.fetchLocZ();
    if (![x, y, z, actor.fetchHead()].every(Number.isFinite) || !Geo.hasGeo(x, y)) return null;
    if (candidates(water, x, y).some(zone => contains(zone, x, y) && z >= zone.minZ && z <= zone.maxZ)) return null;
    const angle = actor.fetchHead() * Math.PI * 2 / 65536;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const first = 90 + Math.floor(Math.random() * 161);
    const distances = [first];
    for (let d = 250; d >= 90; d--) if (d !== first) distances.push(d);
    for (const distance of distances) {
        const hookX = Math.trunc(x + cos * distance), hookY = Math.trunc(y + sin * distance);
        if (!Geo.hasGeo(hookX, hookY)
            || !candidates(fishing, hookX, hookY).some(zone => contains(zone, hookX, hookY))) continue;
        for (const zone of candidates(water, hookX, hookY)) {
            if (!contains(zone, hookX, hookY)) continue;
            const hookZ = zone.maxZ;
            if (!candidates(fishing, hookX, hookY).some(area => contains(area, hookX, hookY)
                && hookZ >= area.minZ && hookZ <= area.maxZ)) continue;
            if (Geo.getHeight(hookX, hookY, hookZ) > hookZ || Geo.getHeight(hookX, hookY, z) > hookZ) continue;
            // Native LOS is permissive without geodata. Fishing must not turn
            // that navigation fallback into evidence of valid water/shore.
            const steps = Math.ceil(distance / 16);
            let covered = true;
            for (let i = 1; i < steps; i++) {
                if (!Geo.hasGeo(x + (hookX - x) * i / steps, y + (hookY - y) * i / steps)) {
                    covered = false;
                    break;
                }
            }
            if (covered && Geo.hasLineOfSight(x, y, z, hookX, hookY, hookZ))
                return { locX: hookX, locY: hookY, locZ: hookZ };
        }
    }
    return null;
}

module.exports = { findHook };
