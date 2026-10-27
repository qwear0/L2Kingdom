const Geo = invoke('GameServer/Geodata/GeodataEngine');

const MAX_STEP = 64;

// Spawn admission must distinguish an actual surface from the movement API's
// permissive missing-geodata fallback, and must see every floor, not just the
// layer nearest a territory's upper Z bound.
function decodeLayers(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    const rx = (x >> 15) + 20;
    const ry = (y >> 15) + 18;
    const key = `${rx}_${ry}`;
    const buffer = Geo.getRegionBuffer(rx, ry);
    if (!buffer || Geo.checkVirtualObstacles(x, y, key)) return [];
    const index = Geo[`index_${key}`];
    if (!index) return [];
    const localX = x - ((rx - 20) << 15);
    const localY = y - ((ry - 18) << 15);
    const block = ((localX >> 7) * 256) + (localY >> 7);
    const offset = index[block];
    if (!Number.isInteger(offset) || offset < 0 || (block > 0 && offset === 0) || offset + 3 > buffer.length) return [];
    const type = buffer.readUInt8(offset);
    if (type === 0) return [{ z: buffer.readInt16LE(offset + 1), nswe: 15 }];
    const cell = (((localX >> 4) & 7) * 8) + ((localY >> 4) & 7);
    let start = offset + 1;
    let count = 1;
    if (type === 1) start += cell * 2;
    else if (type === 2) {
        for (let i = 0; i < cell; i++) {
            if (start >= buffer.length) return [];
            start += 1 + buffer.readUInt8(start) * 2;
        }
        if (start >= buffer.length) return [];
        count = buffer.readUInt8(start++);
    } else return [];
    if (start + count * 2 > buffer.length) return [];
    const result = [];
    for (let i = 0; i < count; i++) {
        const value = buffer.readInt16LE(start + i * 2);
        result.push({ z: ((value & 0xFFF0) << 16) >> 17, nswe: value & 15 });
    }
    return result;
}

function layers(x, y, budget) {
    // Reserve the format's maximum 255 layers before decoding an untrusted cell.
    budget?.beforeLayers();
    const result = decodeLayers(x, y);
    budget?.decoded(result.length);
    return result;
}

function cell(x, y, z, budget) {
    if (!Number.isFinite(z)) return null;
    let closest = null;
    for (const layer of layers(x, y, budget)) {
        if (!closest || Math.abs(layer.z - z) < Math.abs(closest.z - z)) closest = layer;
    }
    return closest && closest.nswe && Math.abs(closest.z - z) <= MAX_STEP ? closest : null;
}

function supported(point, budget) {
    if (!point) return null;
    const surface = cell(point.locX, point.locY, point.locZ, budget);
    return surface ? { locX: point.locX, locY: point.locY, locZ: surface.z } : null;
}

// This proves connectivity, not a motion interpolation: diagonal steps must
// have a valid cardinal route, with reciprocal NSWE and real data at each cell.
// A successful result without a destination Z follows the source floor.
function walk(from, to, budget) {
    budget?.walk();
    if (!from || !to || ![from.locX, from.locY, from.locZ, to.locX, to.locY].every(Number.isFinite)) return null;
    let transitions = 0;
    let cx = from.locX >> 4, cy = from.locY >> 4;
    const ex = to.locX >> 4, ey = to.locY >> 4;
    let current = cell(from.locX, from.locY, from.locZ, budget);
    if (!current) return null;
    const steps = Math.max(Math.abs(ex - cx), Math.abs(ey - cy));
    const dx = steps ? (ex - cx) / steps : 0;
    const dy = steps ? (ey - cy) / steps : 0;
    let fx = cx, fy = cy;
    const cross = (source, x, y, sx, sy) => {
        budget?.transition(++transitions);
        const bit = sx ? (sx > 0 ? 1 : 2) : (sy > 0 ? 4 : 8);
        const opposite = sx ? (sx > 0 ? 2 : 1) : (sy > 0 ? 8 : 4);
        if (!(source.nswe & bit)) return null;
        const target = cell((x << 4) + 8, (y << 4) + 8, source.z, budget);
        return target && (target.nswe & opposite) ? target : null;
    };
    for (let i = 0; i < steps; i++) {
        fx += dx;
        fy += dy;
        const nx = Math.round(fx), ny = Math.round(fy);
        const sx = nx - cx, sy = ny - cy;
        if (sx && sy) {
            const horizontal = cross(current, nx, cy, sx, 0);
            const vertical = cross(current, cx, ny, 0, sy);
            current = (horizontal && cross(horizontal, nx, ny, 0, sy))
                || (vertical && cross(vertical, nx, ny, sx, 0));
        } else current = cross(current, nx, ny, sx, sy);
        if (!current) return null;
        cx = nx;
        cy = ny;
    }
    if (Number.isFinite(to.locZ) && current.z !== to.locZ) return null;
    return { locX: to.locX, locY: to.locY, locZ: current.z };
}

function reachable(from, to, maxNodes, budget, skipDirect = false) {
    if (!skipDirect && walk(from, to, budget)) return true;
    budget?.search(maxNodes + 1);
    const route = Geo.findPath(from.locX, from.locY, from.locZ,
        to.locX, to.locY, to.locZ, maxNodes, { debug: false, checkBudget: budget && (() => budget.poll()) });
    budget?.poll();
    if (!route?.length) return false;
    let previous = from;
    for (const point of route) {
        if (!walk(previous, point, budget)) return false;
        previous = point;
    }
    return !!walk(previous, to, budget);
}

module.exports = { layers, supported, walk, reachable };
