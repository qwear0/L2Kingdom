#!/usr/bin/env node
'use strict';

// Reproduce the reviewed block selection, not a new generation or installation.
// Input/output hashes pin the exact correction; an updated pack needs a new review.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const usage = 'node scripts/prepare-oren-geodata.js --base <original-22_18.l2j> --candidate <cruma-22_18.l2j> --output <new-scratch-file>';
const digest = buffer => createHash('sha256').update(buffer).digest('hex');

function readInput(file, expected, label) {
    if (fs.statSync(file).size !== expected.bytes) throw new Error(`${label}: unexpected file size`);
    const buffer = fs.readFileSync(file);
    if (digest(buffer) !== expected.sha256) throw new Error(`${label}: SHA-256 does not match the correction recipe`);
    return buffer;
}

function main() {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') {
        console.info(usage);
        return;
    }
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
        const name = args[i];
        if (!['--base', '--candidate', '--output'].includes(name) || !args[i + 1]
            || args[i + 1].startsWith('--') || options[name]) throw new Error(usage);
        options[name] = path.resolve(args[i + 1]);
    }
    if (!options['--base'] || !options['--candidate'] || !options['--output']) throw new Error(usage);

    // Resolve the existing parent before writing, so a symlink cannot redirect
    // this preparation command into installed geodata or another live location.
    const parent = fs.realpathSync(path.dirname(options['--output']));
    const allowedRoots = [path.join(root, 'tmp'), '/tmp/L2Kingdom']
        .filter(directory => fs.existsSync(directory)).map(directory => fs.realpathSync(directory));
    if (!allowedRoots.some(directory => parent === directory || parent.startsWith(directory + path.sep))) {
        throw new Error('Output parent must exist below repository tmp/ or /tmp/L2Kingdom/');
    }
    const outputPath = path.join(parent, path.basename(options['--output']));
    if (fs.existsSync(outputPath)) throw new Error('Output already exists; choose a new scratch file');

    const recipe = JSON.parse(fs.readFileSync(path.join(root, 'data/GeodataCorrections/22_18-oren.json'), 'utf8'));
    if (recipe.version !== 1 || recipe.region !== '22_18' || !Array.isArray(recipe.blockRanges)) {
        throw new Error('Unsupported Oren correction recipe');
    }
    const selected = new Uint8Array(65536);
    let last = -1, count = 0;
    for (const range of recipe.blockRanges) {
        if (!Array.isArray(range) || range.length !== 2) throw new Error('Invalid block range');
        const [first, end] = range;
        if (!Number.isInteger(first) || !Number.isInteger(end) || first <= last || first < 0 || end < first || end >= selected.length) {
            throw new Error('Block ranges must be sorted, disjoint and inside the region');
        }
        selected.fill(1, first, end + 1);
        count += end - first + 1;
        last = end;
    }
    if (!count || count !== recipe.selectedBlocks) throw new Error('Selected block count does not match the recipe');
    const buffers = [readInput(options['--base'], recipe.base, 'Base'),
        readInput(options['--candidate'], recipe.candidate, 'Candidate')];

    // Reuse the server's format indexing without Geo.init(), data/world/database
    // initialization, listeners, cache publication or installed-file writes.
    require('../src/Global');
    const Geo = invoke('GameServer/Geodata/GeodataEngine');
    const indices = buffers.map(buffer => Geo.buildOffsetIndex(buffer));
    const parts = [];
    for (let block = 0; block < selected.length; block++) {
        const source = selected[block];
        const end = block + 1 < selected.length ? indices[source][block + 1] : buffers[source].length;
        parts.push(buffers[source].subarray(indices[source][block], end));
    }
    const output = Buffer.concat(parts);
    const sha256 = digest(output);
    if (output.length !== recipe.output.bytes || sha256 !== recipe.output.sha256) {
        throw new Error('Assembled output does not match the reviewed correction');
    }
    fs.writeFileSync(outputPath, output, { flag: 'wx' });
    console.info(JSON.stringify({ output: outputPath, bytes: output.length, sha256,
        selectedBlocks: count, installation: 'not_performed' }));
}

try { main(); }
catch (error) {
    console.error(`Oren geodata preparation failed: ${error.message}`);
    process.exitCode = 1;
}
