'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ini = require('js-ini');
const ROOT = path.resolve(__dirname, '..');
const resolve = (value) => path.resolve(ROOT, value);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function merge(base, override) {
    for (const key of Object.keys(override || {})) {
        const value = override[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (!base[key] || typeof base[key] !== 'object' || Array.isArray(base[key])) base[key] = {};
            merge(base[key], value);
        } else base[key] = value;
    }
    return base;
}

function readFile(file) {
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.nlink !== 1) throw error('Configuration must be an ordinary single-link file.', 409);
        return { raw: fs.readFileSync(file, 'utf8'), mode: stat.mode & 0o777, identity: `${stat.dev}:${stat.ino}:${stat.mode}:${stat.mtimeMs}:${stat.size}` };
    } catch (err) {
        if (err.code === 'ENOENT') return { raw: '', mode: 0o600, identity: 'absent' };
        throw err;
    }
}

function load() {
    const paths = [resolve('config/default.ini'),
        process.env.L2NODE_SHARED_CONFIG_FILE ? resolve(process.env.L2NODE_SHARED_CONFIG_FILE) : null,
        resolve(process.env.L2NODE_CONFIG_FILE || 'config/local.ini')];
    const layers = paths.map((file, index) => {
        if (!file) return { name: 'shared', data: {}, raw: '', identity: 'absent' };
        const snapshot = readFile(file);
        if (!index && snapshot.identity === 'absent') throw error('Default configuration is missing.', 503);
        return { ...snapshot, file, name: ['default', 'shared', 'local'][index], data: ini.parse(snapshot.raw) };
    });
    const effective = layers.reduce((result, layer) => merge(result, layer.data), {});
    const inherited = layers.slice(0, -1).reduce((result, layer) => merge(result, layer.data), {});
    const revision = hash(JSON.stringify(layers.map(({ file, raw, identity }) => [file, raw, identity])));
    return { effective, inherited, layers, revision, localPath: paths[2] };
}

// Only our curated scalar keys are rewritten. Ambiguous syntax must be resolved
// by its author, not normalized by serializing a private INI (which loses comments).
function editIni(raw, changes) {
    const newline = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    for (const { section, key, value } of changes) {
        let current = '', sections = 0;
        const matches = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || /^[;#]/.test(line)) continue;
            const heading = line.match(/^\[(.*)\]$/);
            if (heading) { current = heading[1].trim(); if (current === section) sections++; continue; }
            if (current !== section) continue;
            const assignment = line.match(/^([^=]+?)\s*=/);
            if (assignment?.[1].trim() === key) matches.push(i);
            else if (line.startsWith(key) && !assignment) throw error('Ambiguous local configuration syntax.', 409);
        }
        if (sections > 1 || matches.length > 1) throw error('Duplicate local configuration sections or keys; resolve them before saving.', 409);
        if (matches.length) {
            const i = matches[0];
            if (value === null) {
                const comment = lines[i].match(/\s[;#].*$/)?.[0];
                lines[i] = comment ? comment.trimStart() : '';
            } else {
                const prefix = lines[i].match(/^\s*[^=]+?\s*=\s*/)[0];
                const comment = lines[i].match(/\s[;#].*$/)?.[0] || '';
                lines[i] = `${prefix}${value}${comment}`;
            }
        } else if (value !== null) {
            let heading = lines.findIndex(line => line.trim() === `[${section}]`);
            if (heading < 0 && sections) throw error('Ambiguous local section syntax.', 409);
            if (heading < 0) { lines.push('', `[${section}]`, `${key} = ${value}`); }
            else {
                let end = heading + 1;
                while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
                lines.splice(end, 0, `${key} = ${value}`);
            }
        }
    }
    const result = lines.join(newline);
    const parsed = ini.parse(result);
    for (const { section, key, value } of changes) {
        if (value === null ? Object.hasOwn(parsed[section] || {}, key) : String(parsed[section]?.[key]) !== String(value)) {
            throw error('Configuration could not be round-tripped safely.', 409);
        }
    }
    return result.endsWith(newline) ? result : result + newline;
}

// The caller serializes its writes. This detects external changes; it cannot
// coordinate arbitrary editors in the final check/rename interval.
function atomicReplace(file, raw, mode, recheck) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stage = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.pending`);
    let fd;
    try {
        fd = fs.openSync(stage, 'wx', mode);
        fs.fchmodSync(fd, mode);
        fs.writeFileSync(fd, raw, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        recheck();
        fs.renameSync(stage, file);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(stage)) fs.unlinkSync(stage);
    }
}

module.exports = { ROOT, resolve, hash, error, merge, load, readFile, editIni, atomicReplace };
