require('../src/GameServer/Geodata/JourneyGeometryIdentity.js').define(module, require, function (module, exports, require, __filename, __dirname) {
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const Inputs = require('../src/GameServer/Bot/Travel/JourneyRouteInputs');
const Builder = require('../src/GameServer/Bot/Travel/JourneyRouteBuilder');

function parseArgs(argv) {
    const values = { requirementIds: [], waypointIds: [], connectionIds: [] };
    const singleton = new Set(['--scope', '--source', '--geodata', '--output', '--artifact-root']);
    const repeated = new Map([['--requirement-id', 'requirementIds'], ['--waypoint-id', 'waypointIds'],
        ['--connection-id', 'connectionIds']]);
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        if (flag === '--help') return { help: true };
        const key = repeated.get(flag) || flag.slice(2);
        if (!singleton.has(flag) && !repeated.has(flag)) throw new Error(`unknown_option:${flag}`);
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`missing_value:${flag}`);
        if (repeated.has(flag)) values[key].push(value);
        else if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`duplicate_option:${flag}`);
        else values[key] = value;
    }
    if (!values.scope || !['slice', 'full'].includes(values.scope)) throw new Error('scope_required:slice|full');
    if (!values['artifact-root']) throw new Error('artifact_root_required');
    return values;
}
function usage() {
    return 'node scripts/generate-journey-routes.js --scope slice|full [--requirement-id ID ...] '
        + '[--waypoint-id ID ...] [--connection-id ID ...] [--source FILE] [--geodata DIR] '
        + '[--output FILE] --artifact-root DIR';
}
function teleporterAdapter(root) {
    const fsSync = require('node:fs');
    const jsonSchema = require('jsonschema');
    const dataPath = path.join(root, 'data/Teleports/gatekeepers.json');
    const schemaPath = path.join(root, 'data/Teleports/.schema.json');
    const data = JSON.parse(fsSync.readFileSync(dataPath, 'utf8'));
    const schema = JSON.parse(fsSync.readFileSync(schemaPath, 'utf8'));
    jsonSchema.validate(data, schema, { throwFirst: true });
    const lists = Object.create(null);
    for (const row of data.gatekeepers) lists[row.npcId] = row.routes.map(route => [route.destinationId, route.label]);
    return { lists };
}
function installOfflineInvoke(root, dataCache, gatekeepers) {
    const resolveGameModule = name => path.join(root, 'src', `${name}.js`);
    global.invoke = name => {
        switch (name) {
        case 'GameServer/DataCache': return dataCache;
        case 'GameServer/World/C4GatekeeperTeleports': return gatekeepers;
        case 'GameServer/Geodata/GeodataEngine':
        case 'GameServer/World/TownRespawn':
        case 'GameServer/World/C4SevenSignsDungeonTeleports':
            return require(resolveGameModule(name));
        case 'GameServer/World/Generics/NpcShopBuyLists':
            return require(resolveGameModule('GameServer/World/Generics/NpcShopBuyLists'));
        case 'GameServer/Geodata/VirtualObstacles/index':
            return require(path.join(root, 'src/GameServer/Geodata/VirtualObstacles'));
        case 'GameServer/Bot/Population/PopulationConfig': return { developerDiagnostics: false };
        default: throw new Error(`offline_generator_refuses_module:${name}`);
        }
    };
}
async function loadNative(root, geodataDir, regionKeys, registered, budget) {
    const gatekeepers = teleporterAdapter(root);
    const dataCache = { npcs: registered.templates, npcSpawns: registered.spawnDefinitions, items: [] };
    installOfflineInvoke(root, dataCache, gatekeepers);
    const Geo = require(path.join(root, 'src/GameServer/Geodata/GeodataEngine'));
    const VirtualObstacles = require(path.join(root, 'src/GameServer/Geodata/VirtualObstacles'));
    VirtualObstacles.init();
    let totalBytes = 0;
    for (const region of regionKeys) {
        budget.poll();
        const file = path.join(geodataDir, `${region}.l2j`);
        const key = region;
        Geo.missing[key] = true;
        try {
            const buffer = await fs.readFile(file);
            totalBytes += buffer.length;
            if (totalBytes > 512 * 1024 * 1024) throw new Error('offline_geodata_buffer_limit');
            Geo.regions[key] = buffer;
            Geo[`index_${key}`] = Geo.buildOffsetIndex(buffer);
            delete Geo.missing[key];
            Geo.recordRegionIdentity(key, buffer);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            Geo.recordRegionIdentity(key, null);
        }
    }
    const Surface = require(path.join(root, 'src/GameServer/Geodata/SpawnSurface'));
    const GatherAreas = require(path.join(root, 'src/GameServer/Lord/GatherAreas'));
    const TownGateCatalog = require(path.join(root, 'src/GameServer/Bot/AI/TownGateCatalog'));
    const TownRespawn = require(path.join(root, 'src/GameServer/World/TownRespawn'));
    const WorldAreaCatalog = require(path.join(root, 'src/GameServer/World/WorldAreaCatalog'));
    const RaidBossBalance = require(path.join(root, 'src/GameServer/RaidBoss/RaidBossBalance'));
    const TownServices = require(path.join(root, 'src/GameServer/Bot/Economy/TownServiceCatalog'));
    const serviceRows = TownServices.rows();
    return { Geo, Surface, GatherAreas, TownGateCatalog, TownRespawn, WorldAreaCatalog,
        RaidBossBalance, serviceRows, totalGeoBytes: totalBytes };
}
async function writeJsonAtomic(file, value) {
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    let created = false;
    try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        created = true;
        try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, file);
        created = false;
    } finally {
        if (created) {
            try { await fs.unlink(temporary); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
}
async function main(argv) {
    const startedAt = performance.now(), budget = new Builder.BuildBudget();
    const args = parseArgs(argv);
    if (args.help) { process.stdout.write(`${usage()}\n`); return; }
    const sourceFile = path.resolve(ROOT, args.source || Inputs.DEFAULT_SOURCE);
    const geodataDir = path.resolve(args.geodata || process.env.L2NODE_GEODATA_DIR || path.join(ROOT, 'data/Geodata'));
    const outputFile = path.resolve(args.output || Inputs.DEFAULT_FILE);
    const artifactRoot = path.resolve(args['artifact-root']);
    const selected = await Inputs.readAuthored(sourceFile);
    const registered = await Inputs.loadRegisteredSources(ROOT);
    const scope = Inputs.selectScope(selected.input, { kind: args.scope,
        requirementIds: args.requirementIds, waypointIds: args.waypointIds, connectionIds: args.connectionIds });
    const geometry = Inputs.selectedGeometry(selected.input, scope, registered);
    budget.poll();
    const world = await loadNative(ROOT, geodataDir, geometry.regions, registered, budget);
    const result = await Builder.build({ sourceFile, geodataDir, outputFile, scope: args.scope,
        requirementIds: args.requirementIds, waypointIds: args.waypointIds, connectionIds: args.connectionIds,
        input: selected.input, registered, world, artifactRoot, budget });
    const summary = { ...result.summary, elapsedMs: Math.round(performance.now() - startedAt),
        entireProcessPeakRssBytes: process.resourceUsage().maxRSS * 1024,
        outputBytes: result.summary.outputFile ? (await fs.stat(result.summary.outputFile)).size : null,
        diagnosticBytes: result.summary.diagnosticFile ? (await fs.stat(result.summary.diagnosticFile)).size : null,
        selectedRequirements: scope.requirementIds, selectedWaypoints: scope.waypointIds,
        selectedConnections: scope.connectionIds, geodataDir };
    await writeJsonAtomic(path.join(artifactRoot, 'journey-routes-build-summary.json'), summary);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.status !== 'ready') process.exitCode = 1;
}

if (require.main === module) {
    main(process.argv.slice(2)).catch(async error => {
        const detail = { status: 'failed', reason: String(error.code || error.reason || 'build_failed'),
            diagnostic: String(error.message || error).slice(0, 1000) };
        try {
            const args = parseArgs(process.argv.slice(2));
            if (args['artifact-root']) await writeJsonAtomic(path.join(path.resolve(args['artifact-root']),
                'journey-routes-build-failure.json'), detail);
        } catch (reportError) {
            detail.failureReportWrite = String(reportError.message || reportError).slice(0, 300);
        }
        process.stderr.write(`${JSON.stringify(detail)}\n`);
        process.exitCode = 1;
    });
}

module.exports = { main, parseArgs, usage, loadNative };
});
