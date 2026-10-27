const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const Geo = invoke('GameServer/Geodata/GeodataEngine');

const VERSION = 2;
const MAX_BYTES = 64 * 1024 * 1024;
const CAPACITY = Object.freeze({ definitions: 8192, pools: 4096, fixed: 32768, references: 65536,
    trusted: 16384, memberships: 262144, pairs: 262144 });
const REASONS = new Set(['invalid_coordinate', 'invalid_bounds', 'surface_unavailable', 'surface_blocked',
    'height_mismatch', 'local_exit_missing', 'sampling_miss_or_absence', 'root_unavailable',
    'connectivity_unknown', 'budget_exhausted', 'no_layer_in_z_interval', 'inadequate_pool']);
const digest = value => createHash('sha256').update(value).digest('hex');
const defaultPath = () => path.resolve(__dirname, '../../..', process.env.L2NODE_RUNTIME_DIR || 'tmp', 'cache/spawn-placement.json');
const integer = value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
const xyz = value => Array.isArray(value) && value.length === 3 && value.every(integer);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

function snapshot(expected, anchors, poll) {
    const files = sourceFiles();
    const stamps = files.map(stamp);
    const hash = createHash('sha256').update(JSON.stringify([VERSION, expected.signature, anchors]));
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (const file of files) {
        poll();
        const content = createHash('sha256');
        const fd = fs.openSync(file, 'r');
        try {
            let count;
            while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) {
                content.update(buffer.subarray(0, count));
                poll();
            }
        } finally { fs.closeSync(fd); }
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

function validate(data, expected, poolSize) {
    if (!data || !Array.isArray(data.pools) || data.pools.length !== expected.keys.length || data.pools.length > CAPACITY.pools
        || !Array.isArray(data.trusted) || data.trusted.length > CAPACITY.trusted
        || !Array.isArray(data.fixed) || data.fixed.length !== expected.fixed.length || data.fixed.length > CAPACITY.fixed
        || !Array.isArray(data.references) || data.references.length > CAPACITY.references
        || !Array.isArray(data.definitions) || data.definitions.length > CAPACITY.definitions
        || !same(data.definitions, expected.definitions) || !same(data.references, expected.references)) throw new Error('invalid coverage table');
    if (!data.trusted.every(xyz) || data.trusted.length < expected.initialTrusted.length
        || !same(data.trusted.slice(0, expected.initialTrusted.length), expected.initialTrusted)) throw new Error('invalid trusted coordinates');
    const keys = new Set(expected.keys);
    const pools = new Map(), states = new Map();
    const validReason = reason => reason === null || REASONS.has(reason);
    for (const entry of data.pools) {
        if (!Array.isArray(entry) || entry.length !== 3) throw new Error('invalid pool entry');
        const [key, values, state] = entry;
        if (!keys.delete(key) || !Array.isArray(values) || values.length % 3 || values.length > poolSize * 3 || !values.every(integer)
            || !state || !validReason(state.reason) || typeof state.adequate !== 'boolean'
            || !Number.isInteger(state.scanned) || state.scanned < 0 || state.scanned > 262144
            || typeof state.complete !== 'boolean' || !(state.limit === null || (typeof state.limit === 'string' && state.limit.length <= 80))
            || !Number.isInteger(state.eligible) || state.eligible < 0 || state.eligible > 16000000
            || !Number.isInteger(state.unavailableCells) || state.unavailableCells < 0 || state.unavailableCells > 16000000
            || (state.adequate ? (!values.length || state.reason !== null) : state.reason === null)
            || (state.reason === 'budget_exhausted' && state.limit === null)
            || (state.reason === 'inadequate_pool' && !values.length)
            || (state.reason === 'no_layer_in_z_interval' && (!state.complete || state.eligible || state.unavailableCells || values.length))
            || (state.reason === 'sampling_miss_or_absence' && (state.complete || state.eligible || values.length))
            || !expected.validatePool(key, values, state)) throw new Error('invalid pool coordinates or state');
        const unique = new Set();
        for (let i = 0; i < values.length; i += 3) unique.add(values.slice(i, i + 3).join(':'));
        if (unique.size !== values.length / 3) throw new Error('duplicate pool coordinate');
        pools.set(key, Int32Array.from(values));
        states.set(key, state);
    }
    const localReasons = new Set(['invalid_coordinate', 'surface_unavailable', 'surface_blocked', 'height_mismatch', 'local_exit_missing', 'budget_exhausted']);
    for (const [index, row] of data.fixed.entries()) {
        // Fixed identity/order and references are supplied by the fingerprinted
        // inventory. Height delta/limit retain failure evidence without a warm audit.
        if (!Array.isArray(row) || row.length !== 7) throw new Error('invalid fixed proof');
        const [local, normalized, global, witness, reason, delta, limit] = row;
        if (!(local === 'supported' || localReasons.has(local)) || !(normalized === null || xyz(normalized))
            || !['proven', 'unknown', 'invalid'].includes(global) || !validReason(reason)
            || !(witness === null || (Number.isInteger(witness) && witness >= 0 && witness < data.trusted.length))
            || (global === 'proven' && (local !== 'supported' || !normalized || witness === null || reason !== null))
            || !(delta === null || (Number.isInteger(delta) && delta >= 0))
            || !(limit === null || (typeof limit === 'string' && limit.length <= 80))
            || (normalized && (normalized[0] !== expected.fixed[index][0] || normalized[1] !== expected.fixed[index][1]
                || Math.abs(normalized[2] - expected.fixed[index][2]) > 64))
            || (global !== 'proven' && (witness !== null || reason === null))
            || (local === 'supported' && (!normalized || global === 'invalid'))
            || (local === 'height_mismatch' && !(delta > 64))
            || (local === 'local_exit_missing' && !normalized)
            || (local === 'budget_exhausted' && (global !== 'unknown' || reason !== 'budget_exhausted'))
            || (local !== 'supported' && local !== 'budget_exhausted' && (global !== 'invalid' || reason !== local))
            || (global === 'unknown' && !['root_unavailable', 'connectivity_unknown', 'budget_exhausted'].includes(reason))
            || (local !== 'supported' && global === 'proven')) throw new Error('inconsistent fixed proof');
    }
    return { pools, states, fixed: data.fixed, trusted: data.trusted.map(([locX, locY, locZ]) => ({ locX, locY, locZ })) };
}

// All random and fixed proofs share one identity. Empty/unknown results remain
// cacheable but are not evidence of readiness; v1 never supplies fixed coverage.
function open(expected, anchors, poolSize, { cachePath = defaultPath(), rebuild = false, poll = () => {} } = {}) {
    let inputs;
    try { inputs = snapshot(expected, anchors, poll); }
    catch (error) {
        if (error.code === 'SPAWN_BUDGET') throw error;
        utils.infoWarn('SpawnPlacement', 'disk cache disabled: %s', error.message);
        return { cached: null, fingerprint: null, save() { return false; } };
    }
    let cached = null;
    if (!rebuild) {
        try {
            poll();
            if (fs.statSync(cachePath).size > MAX_BYTES) throw new Error('cache exceeds size limit');
            const envelope = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (envelope.version === VERSION && envelope.fingerprint === inputs.fingerprint) {
                if (typeof envelope.payload !== 'string' || digest(envelope.payload) !== envelope.checksum) throw new Error('payload checksum mismatch');
                cached = validate(JSON.parse(envelope.payload), expected, poolSize);
            }
            poll();
            if (!inputs.unchanged()) throw new Error('inputs changed while loading cache');
            if (!cached) utils.infoSuccess('SpawnPlacement', 'disk cache is outdated; rebuilding');
        } catch (error) {
            if (error.code === 'SPAWN_BUDGET') throw error;
            cached = null;
            if (error.code === 'ENOENT') utils.infoSuccess('SpawnPlacement', 'disk cache missing; rebuilding');
            else utils.infoWarn('SpawnPlacement', 'disk cache rejected: %s; rebuilding', error.message);
        }
    }
    return {
        cached, fingerprint: inputs.fingerprint,
        save(pools, states, fixed, trusted) {
            const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
            let created = false;
            try {
                poll();
                if (!inputs.unchanged()) throw new Error('inputs changed during preparation');
                const data = { pools: [...pools].map(([key, points]) => [key, [...points], states.get(key)]), fixed,
                    trusted: trusted.map(point => [point.locX, point.locY, point.locZ]), definitions: expected.definitions, references: expected.references };
                validate(data, expected, poolSize);
                const payload = JSON.stringify(data);
                const text = JSON.stringify({ version: VERSION, fingerprint: inputs.fingerprint, checksum: digest(payload), payload });
                if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('cache exceeds size limit');
                poll();
                fs.mkdirSync(path.dirname(cachePath), { recursive: true });
                const fd = fs.openSync(temporary, 'wx', 0o600);
                created = true;
                try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
                finally { fs.closeSync(fd); }
                poll();
                if (!inputs.unchanged()) throw new Error('inputs changed before publication');
                fs.renameSync(temporary, cachePath);
                created = false;
                utils.infoSuccess('SpawnPlacement', 'saved disk cache (%d pools, %d fixed proofs)', pools.size, fixed.length);
                return true;
            } catch (error) {
                if (error.code === 'SPAWN_BUDGET') throw error;
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

module.exports = { open, CAPACITY };
