const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const Geo = invoke('GameServer/Geodata/GeodataEngine');

const VERSION = 1;
const MAX_BYTES = 64 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const defaultPath = () => path.resolve(__dirname, '../../..', process.env.L2NODE_RUNTIME_DIR || 'tmp', 'cache/spawn-placement.json');

function sourceFiles() {
    const geoDir = Geo.getGeodataDir();
    const obstaclesDir = path.join(__dirname, 'VirtualObstacles');
    return [
        ...['SpawnPlacement.js', 'SpawnSurface.js', 'GeodataEngine.js', 'SpawnPlacementCache.js'].map(name => path.join(__dirname, name)),
        ...fs.readdirSync(obstaclesDir).filter(name => name.endsWith('.js')).sort().map(name => path.join(obstaclesDir, name)),
        ...fs.readdirSync(geoDir).filter(name => /^-?\d+_-?\d+\.l2j$/.test(name)).sort().map(name => path.resolve(geoDir, name))
    ];
}

function stamp(file) {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function snapshot(keys, anchors) {
    const files = sourceFiles();
    const stamps = files.map(stamp);
    const hash = createHash('sha256').update(JSON.stringify([VERSION, keys, anchors]));
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (const file of files) {
        const content = createHash('sha256');
        const fd = fs.openSync(file, 'r');
        try {
            let count;
            while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) content.update(buffer.subarray(0, count));
        } finally {
            fs.closeSync(fd);
        }
        const sum = content.digest('hex');
        const loaded = Geo.regions[path.basename(file, '.l2j')];
        if (file.endsWith('.l2j') && loaded && digest(loaded) !== sum) throw new Error(`loaded geodata differs from disk: ${path.basename(file)}`);
        hash.update(JSON.stringify([file, sum]));
    }
    const unchanged = () => {
        const current = sourceFiles();
        return current.length === files.length && current.every((file, i) => file === files[i] && stamp(file) === stamps[i]);
    };
    if (!unchanged()) throw new Error('inputs changed while fingerprinting');
    return { fingerprint: hash.digest('hex'), unchanged };
}

function decode(text, fingerprint, keys, poolSize) {
    const envelope = JSON.parse(text);
    if (envelope.version !== VERSION || envelope.fingerprint !== fingerprint) return null;
    if (typeof envelope.payload !== 'string' || digest(envelope.payload) !== envelope.checksum) throw new Error('payload checksum mismatch');
    const data = JSON.parse(envelope.payload);
    const expected = new Set(keys);
    if (!Array.isArray(data.pools) || data.pools.length !== expected.size || !Array.isArray(data.trusted)) throw new Error('invalid cache structure');
    const pools = new Map();
    for (const entry of data.pools) {
        if (!Array.isArray(entry) || entry.length !== 2) throw new Error('invalid pool entry');
        const [key, values] = entry;
        if (!expected.delete(key) || !Array.isArray(values) || values.length % 3 || values.length > poolSize * 3
            || !values.every(value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)) throw new Error('invalid pool coordinates');
        pools.set(key, Int32Array.from(values));
    }
    if (!data.trusted.every(point => point && [point.locX, point.locY, point.locZ].every(Number.isFinite))) throw new Error('invalid trusted points');
    return { pools, trusted: data.trusted };
}

// Pools share proofs across territories, so invalidation is deliberately global.
// Hash contents (not just mtimes), including absent/present region names; a cached
// empty pool means "not proven", never proof that the territory is unreachable.
function open(keys, anchors, poolSize, { cachePath = defaultPath(), rebuild = false } = {}) {
    let inputs;
    try {
        inputs = snapshot(keys, anchors);
    } catch (error) {
        utils.infoWarn('SpawnPlacement', 'disk cache disabled: %s', error.message);
        return { cached: null, save() { return false; } };
    }
    let cached = null;
    if (!rebuild) {
        try {
            if (fs.statSync(cachePath).size > MAX_BYTES) throw new Error('cache exceeds size limit');
            cached = decode(fs.readFileSync(cachePath, 'utf8'), inputs.fingerprint, keys, poolSize);
            if (!inputs.unchanged()) throw new Error('inputs changed while loading cache');
            if (!cached) utils.infoSuccess('SpawnPlacement', 'disk cache is outdated; rebuilding');
        } catch (error) {
            cached = null;
            if (error.code === 'ENOENT') utils.infoSuccess('SpawnPlacement', 'disk cache missing; rebuilding');
            else utils.infoWarn('SpawnPlacement', 'disk cache rejected: %s; rebuilding', error.message);
        }
    }
    return {
        cached,
        save(pools, trusted) {
            const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
            let created = false;
            try {
                if (!inputs.unchanged()) throw new Error('inputs changed during preparation');
                const payload = JSON.stringify({ pools: [...pools].map(([key, points]) => [key, [...points]]), trusted });
                const text = JSON.stringify({ version: VERSION, fingerprint: inputs.fingerprint, checksum: digest(payload), payload });
                if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('cache exceeds size limit');
                fs.mkdirSync(path.dirname(cachePath), { recursive: true });
                const fd = fs.openSync(temporary, 'wx', 0o600);
                created = true;
                try {
                    fs.writeFileSync(fd, text);
                    fs.fsyncSync(fd);
                } finally {
                    fs.closeSync(fd);
                }
                fs.renameSync(temporary, cachePath);
                created = false;
                utils.infoSuccess('SpawnPlacement', 'saved disk cache (%d pools)', pools.size);
                return true;
            } catch (error) {
                utils.infoWarn('SpawnPlacement', 'disk cache not saved: %s', error.message);
                return false;
            } finally {
                if (created) {
                    try { fs.unlinkSync(temporary); }
                    catch (error) { utils.infoWarn('SpawnPlacement', 'cache temporary cleanup failed: %s', error.message); }
                }
            }
        }
    };
}

module.exports = { open };
