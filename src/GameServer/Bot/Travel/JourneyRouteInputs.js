'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Format = require('./JourneyRouteFormat');

const ROOT = path.resolve(__dirname, '../../../..');
const DEFAULT_SOURCE = path.join(ROOT, 'data/Bots/travel-waypoints.json');
const DEFAULT_FILE = path.resolve(ROOT, process.env.L2NODE_RUNTIME_DIR || 'tmp', 'cache/journey-routes.json');
const IDENTITY_SOURCE_VERSION = 'journey-route-input-identity-v1';
const EXPECTED_SOURCES = Object.freeze({
    gatherAreas: 'src/GameServer/Lord/GatherAreas.js',
    polygonSpawns: 'data/Npcs/Spawns/spawns.json',
    registeredResources: 'src/GameServer/DataCache.js',
    towns: 'src/GameServer/World/TownRespawn.js',
    townGates: 'src/GameServer/Bot/AI/TownGateCatalog.js',
    services: 'src/GameServer/Bot/Economy/TownServiceCatalog.js',
    castellan: 'src/GameServer/Lord/CastellanAccess.js',
    gatekeeperRoutes: 'src/GameServer/Bot/Travel/TravelRoutes.js',
    excludedDungeons: 'src/GameServer/World/WorldAreaCatalog.js',
    excludedRaids: 'src/GameServer/RaidBoss/RaidBossBalance.js'
});
const CORE_INPUTS = Object.freeze([
    'src/GameServer/DataCache.js', 'src/GameServer/Lord/GatherAreas.js',
    'src/GameServer/World/TownRespawn.js', 'src/GameServer/Bot/AI/TownGateCatalog.js',
    'src/GameServer/Bot/Economy/TownServiceCatalog.js', 'src/GameServer/Bot/Economy/TownNpcCatalog.js',
    'src/GameServer/Lord/CastellanAccess.js', 'src/GameServer/Item/ItemTemplateIndex.js',
    'src/GameServer/World/Generics/NpcShopBuyLists.js', 'src/GameServer/World/Generics/NpcShopPriceScale.js',
    'src/GameServer/Bot/Travel/TravelRoutes.js', 'src/GameServer/World/C4GatekeeperTeleports.js',
    'src/GameServer/World/WorldAreaCatalog.js', 'src/GameServer/RaidBoss/RaidBossBalance.js',
    'src/GameServer/Geodata/GeodataEngine.js', 'src/GameServer/Geodata/SpawnSurface.js',
    'src/GameServer/Geodata/SpawnPlacement.js', 'src/GameServer/Geodata/SpawnPlacementCache.js',
    'src/GameServer/Geodata/VirtualObstacles/index.js',
    'src/GameServer/Bot/Travel/JourneyRouteInputs.js', 'src/GameServer/Bot/Travel/JourneyRouteFormat.js',
    'src/GameServer/Bot/Travel/JourneyRouteComponents.js', 'src/GameServer/Bot/Travel/JourneyRouteBuilder.js',
    'src/GameServer/Bot/Travel/JourneyRouteCatalog.js', 'scripts/generate-journey-routes.js',
    'data/Teleports/gatekeepers.json', 'data/Teleports/.schema.json',
    'data/Npcs/Minions/c4_raid_bosses.json', 'data/Npcs/Spawns/spawns.json',
    'src/GameServer/World/C4LateTownGatekeepers.js', 'src/GameServer/World/GiranMammon.js',
    'src/GameServer/World/GiranCrystallizationStation.js', 'src/GameServer/World/GludioCastellan.js',
    'src/GameServer/World/C4SevenSignsDungeonTeleports.js'
]);
const IDENTITY_LIMITS = Object.freeze({ wallMs: 10000, rssBytes: 128 * 1024 * 1024, batchRecords: 4096,
    maxRegions: 64, maxGeoBytes: 512 * 1024 * 1024 });

function relative(file) {
    const full = path.resolve(file);
    if (full !== ROOT && !full.startsWith(`${ROOT}${path.sep}`)) throw new Error(`journey_input_outside_repository:${file}`);
    return path.relative(ROOT, full).split(path.sep).join('/');
}
function checkDeadline(startedAt, recordCount = 0, baselineRss = 0) {
    if (performance.now() - startedAt > IDENTITY_LIMITS.wallMs) throw new Error('journey_input_identity_wall_limit');
    if ((recordCount & 127) === 0 && process.memoryUsage.rss() - baselineRss > IDENTITY_LIMITS.rssBytes) {
        throw new Error('journey_input_identity_additional_rss_limit');
    }
}
async function readRegular(file, maxBytes, label) {
    const pathStat = await fsp.lstat(file, { bigint: true });
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error(`${label}:not_regular_file`);
    if (pathStat.size > BigInt(maxBytes)) throw new Error(`${label}:size_limit_exceeded`);
    const handle = await fsp.open(file, 'r');
    try {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino || stat.size !== pathStat.size
            || stat.size > BigInt(maxBytes)) throw new Error(`${label}:changed_while_opening`);
        const bytes = Buffer.alloc(Number(stat.size));
        let offset = 0;
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) throw new Error(`${label}:truncated_while_reading`);
            offset += bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
            throw new Error(`${label}:changed_while_reading`);
        }
        return { bytes, stat };
    } finally { await handle.close(); }
}
async function readAuthored(sourceFile = DEFAULT_SOURCE) {
    const file = path.resolve(ROOT, sourceFile);
    const { bytes } = await readRegular(file, Format.LIMITS.authoredBytes, 'journey_authored_input');
    const input = Format.parseStrictJson(bytes.toString('utf8'), relative(file));
    Format.validateAuthored(input);
    const towns = require('../../World/TownRespawn').towns;
    const townKeys = Object.keys(towns).sort(), requiredKeys = input.requiredTowns.map(row => row.townKey).sort();
    if (townKeys.length !== requiredKeys.length || townKeys.some((key, index) => key !== requiredKeys[index])) {
        throw new Error('journey_town_inventory_does_not_match_TownRespawn');
    }
    for (const row of input.requiredTowns) {
        const town = towns[row.townKey];
        const expected = { locX: town.locX, locY: town.locY, locZ: town.locZ };
        if (Format.canonicalStringify(row.seedPoint) !== Format.canonicalStringify(expected)
            || row.restartTownKey !== (town.respawnTown || row.townKey)) throw new Error(`journey_town_seed_mismatch:${row.townKey}`);
    }
    const gateCatalog = require('../AI/TownGateCatalog');
    const expectedGates = [];
    for (const row of input.requiredTowns) for (const gate of gateCatalog.gatesFor(row.name)) {
        expectedGates.push(`${row.townKey}:${gate.id}`);
    }
    const authoredGates = input.waypointSeeds.map(row => row.id).sort();
    expectedGates.sort();
    if (authoredGates.length !== expectedGates.length
        || authoredGates.some((id, index) => id !== expectedGates[index])) throw new Error('journey_gate_inventory_does_not_match_TownGateCatalog');
    const roles = ['gatekeeper', 'seller', 'generic_merchant', 'warehouse'];
    if (input.serviceSeedSelection.roles.length !== roles.length
        || roles.some(role => !input.serviceSeedSelection.roles.includes(role))) throw new Error('journey_service_role_inventory_invalid');
    return { file, input, bytes };
}
function codeArray(text, startMarker, endMarker) {
    const start = text.indexOf(startMarker);
    if (start < 0) throw new Error(`journey_resource_registration_missing:${startMarker}`);
    const end = text.indexOf(endMarker, start + startMarker.length);
    if (end < 0) throw new Error(`journey_resource_registration_unclosed:${startMarker}`);
    return text.slice(start, end);
}
function registeredJsonPaths(dataCacheText) {
    const npcsSection = codeArray(dataCacheText, 'DataCache.npcs            = applyNpcAiTypes([', '], npcAiTypes);');
    const spawnsSection = codeArray(dataCacheText, 'DataCache.npcSpawns       = [', '];');
    const extract = section => [...section.matchAll(/validateModel\(path \+ '([^']+)'\)/g)].map(match => {
        const relativePath = `data/${match[1]}.json`;
        return relative(ROOT + path.sep + relativePath);
    });
    const npcFiles = new Set(extract(npcsSection));
    const spawnFiles = new Set(extract(spawnsSection));
    spawnFiles.add('data/Npcs/Spawns/spawns.json');
    // These exports are direct registered inputs rather than validateModel calls.
    npcFiles.add('data/Pets/c4-quest-npcs.json');
    spawnFiles.add('data/Pets/c4-quest-npcs.json');
    for (const match of dataCacheText.matchAll(/require\('\.\/World\/([^']+)'\)\.(npcs|spawns)/g)) {
        const target = `src/GameServer/World/${match[1]}.js`;
        (match[2] === 'npcs' ? npcFiles : spawnFiles).add(target);
    }
    for (const match of dataCacheText.matchAll(/const (\w+)\s*=\s*invoke\('GameServer\/World\/([^']+)'\)/g)) {
        const variable = match[1], target = `src/GameServer/World/${match[2]}.js`;
        if (dataCacheText.includes(`${variable}.npcs`)) npcFiles.add(target);
        if (dataCacheText.includes(`${variable}.spawns`)) spawnFiles.add(target);
    }
    return { npcFiles: [...npcFiles].sort(), spawnFiles: [...spawnFiles].sort() };
}
async function loadRegisteredSources(root = ROOT) {
    const dataCacheFile = path.join(root, 'src/GameServer/DataCache.js');
    const dataCacheText = await fsp.readFile(dataCacheFile, 'utf8');
    const paths = registeredJsonPaths(dataCacheText);
    const templates = [], spawnDefinitions = [], fileBytes = new Map(), dynamicExports = new Map();
    const readArray = async relativePath => {
        const file = path.join(root, relativePath);
        const { bytes } = await readRegular(file, 64 * 1024 * 1024, `registered_source:${relativePath}`);
        fileBytes.set(relativePath, bytes);
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (relativePath.endsWith('.json') && Array.isArray(parsed)) return parsed;
        if (relativePath === 'data/Pets/c4-quest-npcs.json') {
            return parsed;
        }
        throw new Error(`registered_source_invalid:${relativePath}`);
    };
    const loadDynamic = async relativePath => {
        let rows = dynamicExports.get(relativePath);
        if (rows) return rows;
        const file = path.join(root, relativePath);
        const { bytes } = await readRegular(file, 2 * 1024 * 1024, `registered_module:${relativePath}`);
        fileBytes.set(relativePath, bytes);
        const exports = require(file);
        if (!exports || !Array.isArray(exports.npcs) && !Array.isArray(exports.spawns)) {
            throw new Error(`registered_module_exports_invalid:${relativePath}`);
        }
        rows = { npcs: exports.npcs || [], spawns: exports.spawns || [], exports };
        dynamicExports.set(relativePath, rows);
        return rows;
    };
    for (const relativePath of paths.npcFiles) {
        if (relativePath.endsWith('c4-quest-npcs.json')) {
            const rows = await readArray(relativePath);
            if (Array.isArray(rows.npcs)) templates.push(...rows.npcs);
        } else if (relativePath.startsWith('src/')) {
            templates.push(...(await loadDynamic(relativePath)).npcs);
        } else templates.push(...await readArray(relativePath));
    }
    for (const relativePath of paths.spawnFiles) {
        if (relativePath.endsWith('c4-quest-npcs.json')) {
            const rows = await readArray(relativePath);
            if (Array.isArray(rows.spawns)) spawnDefinitions.push(...rows.spawns);
        } else if (relativePath.startsWith('src/')) {
            spawnDefinitions.push(...(await loadDynamic(relativePath)).spawns);
        } else spawnDefinitions.push(...await readArray(relativePath));
    }
    const npcIds = new Set();
    for (const row of templates) {
        const id = Number(row?.selfId);
        if (!Number.isInteger(id) || id <= 0) continue;
        if (npcIds.has(id)) npcIds.add(`duplicate:${id}`);
        else npcIds.add(id);
    }
    return { templates, spawnDefinitions, registeredPaths: paths, fileBytes, dynamicExports, duplicateTemplateIds: npcIds };
}
function pointRegion(point) {
    return `${(point.locX >> 15) + 20}_${(point.locY >> 15) + 18}`;
}
function addPointRegion(regions, point) {
    if (point && Number.isFinite(point.locX) && Number.isFinite(point.locY)) regions.add(pointRegion(point));
}
function addRectRegions(regions, minX, maxX, minY, maxY) {
    const x0 = (minX >> 15) + 20, x1 = (maxX >> 15) + 20;
    const y0 = (minY >> 15) + 18, y1 = (maxY >> 15) + 18;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) regions.add(`${x}_${y}`);
}
function addGeometryRegions(regions, points) {
    if (!points.length) return;
    addRectRegions(regions, Math.min(...points.map(point => point.locX)), Math.max(...points.map(point => point.locX)),
        Math.min(...points.map(point => point.locY)), Math.max(...points.map(point => point.locY)));
}
function selectScope(input, scope) {
    if (!scope || !['slice', 'full'].includes(scope.kind)) throw new Error('journey_scope_must_be_explicit');
    let requirementIds = [...(scope.requirementIds || [])];
    let waypointIds = [...(scope.waypointIds || [])];
    let connectionIds = [...(scope.connectionIds || [])];
    if (scope.kind === 'full' && !requirementIds.length && !waypointIds.length && !connectionIds.length) {
        requirementIds = [...input.requiredPolygons.map(row => row.spawnId), ...input.requiredTowns.map(row => row.townKey)];
        waypointIds = input.waypoints.map(row => row.id);
        connectionIds = input.trunks.map(row => row.id);
    } else if (scope.kind === 'slice') {
        if (!waypointIds.length) waypointIds = input.waypoints.map(row => row.id);
        if (!connectionIds.length) connectionIds = input.trunks.map(row => row.id);
    }
    requirementIds.sort(); waypointIds.sort(); connectionIds.sort();
    if (scope.kind === 'slice' && requirementIds.length === 0 && waypointIds.length === 0 && connectionIds.length === 0) {
        throw new Error('journey_slice_selection_empty');
    }
    const validRequirement = new Set([...input.requiredPolygons.map(row => row.spawnId), ...input.requiredTowns.map(row => row.townKey)]);
    for (const id of requirementIds) if (!validRequirement.has(id)) throw new Error(`journey_unknown_requirement:${id}`);
    const waypointSet = new Set(input.waypoints.map(row => row.id));
    const trunkSet = new Set(input.trunks.map(row => row.id));
    for (const id of waypointIds) if (!waypointSet.has(id)) throw new Error(`journey_unknown_waypoint:${id}`);
    for (const id of connectionIds) if (!trunkSet.has(id)) throw new Error(`journey_unknown_connection:${id}`);
    if (new Set(requirementIds).size !== requirementIds.length || new Set(waypointIds).size !== waypointIds.length
        || new Set(connectionIds).size !== connectionIds.length) throw new Error('journey_scope_duplicate_selection');
    return { kind: scope.kind, requirementIds, waypointIds, connectionIds };
}
async function inferScope(sourceFile, input, explicitScope) {
    if (explicitScope) return selectScope(input, explicitScope);
    const catalogueFile = DEFAULT_FILE;
    try {
        const { bytes } = await readRegular(catalogueFile, Format.LIMITS.generatedBytes, 'journey_generated_file');
        const record = Format.parseStrictJson(bytes.toString('utf8'), relative(catalogueFile));
        return selectScope(input, record.scope);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}
function selectedGeometry(input, scope, registered) {
    const regions = new Set();
    const polygonIds = new Set(scope.requirementIds.filter(id => input.requiredPolygons.some(row => row.spawnId === id)));
    const townIds = new Set(scope.requirementIds.filter(id => input.requiredTowns.some(row => row.townKey === id)));
    const spawnRows = new Map();
    for (const source of registered.spawnDefinitions) {
        const id = String(source?.selfId || '');
        if (!polygonIds.has(id)) continue;
        if (spawnRows.has(id)) throw new Error(`journey_spawn_source_ambiguous:${id}`);
        spawnRows.set(id, source);
    }
    for (const id of polygonIds) {
        const spawn = spawnRows.get(id);
        if (!spawn) throw new Error(`journey_spawn_source_missing:${id}`);
        if (!Array.isArray(spawn.bounds) || spawn.bounds.length < 3) throw new Error(`journey_spawn_bounds_invalid:${id}`);
        addGeometryRegions(regions, spawn.bounds);
        for (const p of spawn.spawnAnchors || []) addPointRegion(regions, p);
        for (const entry of spawn.spawns || []) for (const p of entry.coords || []) addPointRegion(regions, p);
    }
    const gateCatalog = require('../AI/TownGateCatalog');
    const TownRespawn = require('../../World/TownRespawn');
    for (const town of input.requiredTowns) {
        if (!townIds.has(town.townKey)) continue;
        addPointRegion(regions, town.seedPoint);
        for (const gate of gateCatalog.gatesFor(town.name)) for (const side of ['inside', 'passage', 'outside']) addPointRegion(regions, gate[side]);
        const townPoint = TownRespawn.towns[town.townKey];
        for (const zone of registered.spawnDefinitions) for (const spawn of zone.spawns || []) {
            for (const point of spawn.coords || []) {
                if (TownRespawn.getClosestTown(point.locX, point.locY, point.locZ) !== townPoint
                    || Math.hypot(point.locX - townPoint.locX, point.locY - townPoint.locY) > 7500) continue;
                addPointRegion(regions, point);
            }
        }
    }
    for (const waypoint of input.waypoints) {
        if (scope.waypointIds.includes(waypoint.id)) addPointRegion(regions, waypoint.point);
    }
    const selectedTrunks = input.trunks.filter(trunk => scope.connectionIds.includes(trunk.id));
    const waypointById = new Map(input.waypoints.map(row => [row.id, row]));
    for (const trunk of selectedTrunks) {
        const points = [waypointById.get(trunk.from)?.point, waypointById.get(trunk.to)?.point].filter(Boolean);
        addGeometryRegions(regions, points);
        for (const regionId of trunk.transitRegionIds) {
            const region = [...input.acceptedTransitRegions, ...input.rejectedTransitRegions].find(row => row.id === regionId);
            if (region) addGeometryRegions(regions, region.polygon);
        }
    }
    if (regions.size > IDENTITY_LIMITS.maxRegions) throw new Error(`journey_region_limit_exceeded:${regions.size}`);
    return { regions: [...regions].sort((a, b) => a.localeCompare(b)), polygonIds: [...polygonIds].sort(), townIds: [...townIds].sort() };
}
async function hashFile(file, startedAt, recordIndex, baselineRss, displayPath = file) {
    let before;
    try { before = await fsp.lstat(file, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return { missing: true, size: 0, sha256: null }; throw error; }
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`journey_input_not_regular_file:${displayPath}`);
    const digest = createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
        digest.update(chunk);
        size += chunk.length;
        checkDeadline(startedAt, recordIndex + Math.ceil(size / (1024 * 1024)), baselineRss);
    }
    const after = await fsp.lstat(file, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || size !== Number(before.size)) {
        throw new Error(`journey_input_changed_while_hashing:${displayPath}`);
    }
    return { missing: false, size, sha256: digest.digest('hex') };
}
function moduleExportDigest(value, seen = new Set()) {
    if (value === null || typeof value !== 'object' && typeof value !== 'function') return Format.canonicalStringify(value);
    if (seen.has(value)) return '[cycle]';
    seen.add(value);
    if (typeof value === 'function') return `function:${value.toString()}`;
    if (Array.isArray(value)) return `[${value.map(item => moduleExportDigest(item, seen)).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${moduleExportDigest(value[key], seen)}`).join(',')}}`;
}
async function verifyCachedJsonExport(file) {
    let resolved;
    try { resolved = require.resolve(file); } catch (_) { return; }
    const loaded = require.cache[resolved];
    if (!loaded) return;
    const bytes = await fsp.readFile(file);
    let diskValue;
    try { diskValue = JSON.parse(bytes.toString('utf8')); }
    catch (_) { throw new Error(`journey_loaded_json_export_invalid:${path.basename(file)}`); }
    if (moduleExportDigest(loaded.exports) !== moduleExportDigest(diskValue)) {
        throw new Error(`journey_loaded_json_export_mismatch:${path.basename(file)}`);
    }
}
function cachedModule(file) {
    try {
        const resolved = require.resolve(file);
        return require.cache[resolved]?.exports || require(file);
    } catch (error) {
        throw new Error(`journey_registered_module_load_failed:${path.basename(file)}:${error.message}`);
    }
}
async function inputIdentity({ sourceFile = DEFAULT_SOURCE, geodataDir = process.env.L2NODE_GEODATA_DIR
    || path.join(ROOT, 'data/Geodata'), scope = null, relevantRegions = null, loadedGeo = null,
    throwOnError = false } = {}) {
    const startedAt = performance.now(), startedAtWallMs = Date.now(), baselineRss = process.memoryUsage.rss();
    try {
        const authored = await readAuthored(sourceFile);
        let expectedRecord = null, selectedScope = scope;
        if (!selectedScope) {
            try {
                const { bytes } = await readRegular(DEFAULT_FILE, Format.LIMITS.generatedBytes, 'journey_catalogue');
                expectedRecord = Format.parseStrictJson(bytes.toString('utf8'), 'journey_catalogue');
                await Format.validateRecord(expectedRecord);
                const { serviceInventory: ignoredServiceInventory, ...recordedRequirements } = expectedRecord.requirements;
                if (Format.canonicalStringify(recordedRequirements) !== Format.canonicalStringify(authored.input)) {
                    throw new Error('journey_authored_requirements_stale');
                }
                selectedScope = expectedRecord.scope;
            } catch (error) {
                if (error.code === 'ENOENT') return { status: 'disabled', reason: 'journey_catalogue_missing',
                    fingerprint: null, inputs: [], scope: null, sourceFile: authored.file };
                throw error;
            }
        }
        const selected = selectScope(authored.input, selectedScope);
        const sourceDeclaration = authored.input.sources || {};
        for (const [name, expected] of Object.entries(EXPECTED_SOURCES)) {
            if (sourceDeclaration[name] !== expected) throw new Error(`journey_source_contract_mismatch:${name}`);
        }
        const dataCacheText = await fsp.readFile(path.join(ROOT, 'src/GameServer/DataCache.js'), 'utf8');
        const registeredPaths = registeredJsonPaths(dataCacheText);
        const fileMap = new Map();
        const addFile = (id, file, displayPath = null) => fileMap.set(id, { file, displayPath });
        addFile('authored-waypoints', authored.file, relative(authored.file));
        for (const source of CORE_INPUTS) addFile(`source:${source}`, path.join(ROOT, source), source);
        const registeredFileNames = [...new Set([...registeredPaths.npcFiles, ...registeredPaths.spawnFiles])].sort();
        for (const source of registeredFileNames) addFile(`registered:${source}`, path.join(ROOT, source), source);
        const obstacleDirectory = path.join(ROOT, 'src/GameServer/Geodata/VirtualObstacles');
        const obstacleNames = (await fsp.readdir(obstacleDirectory)).filter(name => name.endsWith('.js')).sort();
        for (const name of obstacleNames) addFile(`obstacle:${name}`,
            path.join(obstacleDirectory, name), `src/GameServer/Geodata/VirtualObstacles/${name}`);

        let regions;
        if (expectedRecord) {
            regions = expectedRecord.inputs.filter(row => row.id.startsWith('geodata:'))
                .map(row => row.id.slice('geodata:'.length)).sort();
        } else if (Array.isArray(relevantRegions)) regions = [...new Set(relevantRegions)].sort();
        else {
            const registered = await loadRegisteredSources(ROOT);
            regions = selectedGeometry(authored.input, selected, registered).regions;
        }
        if (regions.length > IDENTITY_LIMITS.maxRegions
            || regions.some(key => !/^\d+_\d+$/.test(key)) || new Set(regions).size !== regions.length) {
            throw new Error('journey_relevant_region_set_invalid');
        }
        const geoRoot = path.resolve(geodataDir);
        let totalGeoBytes = 0;
        for (const key of regions) addFile(`geodata:${key}`, path.join(geoRoot, `${key}.l2j`), `geodata/${key}.l2j`);
        const actualIds = new Set(fileMap.keys());
        if (expectedRecord) {
            const expectedIds = new Set(expectedRecord.inputs.map(row => row.id));
            const expectedNonGeo = [...expectedIds].filter(id => !id.startsWith('geodata:')).sort();
            const actualNonGeo = [...actualIds].filter(id => !id.startsWith('geodata:')).sort();
            if (expectedNonGeo.length !== actualNonGeo.length
                || expectedNonGeo.some((id, index) => id !== actualNonGeo[index])) {
                throw new Error('journey_registered_input_manifest_mismatch');
            }
        }
        const inputs = [];
        let index = 0;
        for (const [id, { file, displayPath }] of [...fileMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            checkDeadline(startedAt, index, baselineRss);
            const result = await hashFile(file, startedAt, index++, baselineRss);
            if (result.missing && !id.startsWith('geodata:')) throw new Error(`journey_required_input_missing:${id}`);
            const entry = { id, path: displayPath, size: result.size, missing: result.missing };
            if (!result.missing) entry.sha256 = result.sha256;
            if (id.startsWith('registered:src/')) {
                const exports = cachedModule(file);
                entry.loadedSha256 = Format.sha256(moduleExportDigest(exports));
            } else if (id.startsWith('obstacle:')) {
                const exports = cachedModule(file);
                entry.loadedSha256 = Format.sha256(moduleExportDigest(exports));
            } else if (!id.startsWith('geodata:') && file.endsWith('.json')) {
                await verifyCachedJsonExport(file);
            }
            if (id.startsWith('geodata:') && !result.missing) {
                totalGeoBytes += result.size;
                if (totalGeoBytes > IDENTITY_LIMITS.maxGeoBytes) throw new Error('journey_geodata_buffer_limit_exceeded');
            }
            inputs.push(entry);
        }
        const geo = loadedGeo || (() => {
            const key = path.resolve(__dirname, '../../Geodata/GeodataEngine.js');
            return require.cache[key]?.exports || null;
        })();
        if (geo) for (const region of regions) {
            const loaded = geo.regions?.[region];
            const current = inputs.find(entry => entry.id === `geodata:${region}`);
            if (!loaded) continue;
            const loadedDigest = Format.sha256(loaded);
            if (current.missing || current.sha256 !== loadedDigest) throw new Error(`journey_loaded_geodata_mismatch:${region}`);
        }
        if (expectedRecord) {
            if (Format.canonicalStringify(inputs) !== Format.canonicalStringify(expectedRecord.inputs)) {
                throw new Error('journey_input_fingerprint_stale');
            }
            if (Format.canonicalStringify(selected) !== Format.canonicalStringify(expectedRecord.scope)) {
                throw new Error('journey_scope_identity_mismatch');
            }
        }
        if (inputs.length > IDENTITY_LIMITS.batchRecords * 4) throw new Error('journey_input_manifest_record_limit');
        const fingerprint = Format.sha256(Format.canonicalStringify(inputs));
        checkDeadline(startedAt, inputs.length, baselineRss);
        return { status: 'ready', fingerprint, inputs, scope: selected,
            authoredDigest: Format.sha256(Format.canonicalStringify(authored.input)),
            sourceFile: authored.file, geodataDir: geoRoot, relevantRegions: regions,
            resourceBytes: totalGeoBytes, durationMs: Math.round(performance.now() - startedAt),
            startedAtMonotonic: startedAt, startedAtWallMs, baselineRssBytes: baselineRss,
            identityVersion: IDENTITY_SOURCE_VERSION };
    } catch (error) {
        if (throwOnError) throw error;
        return { status: 'disabled', reason: `journey_input_identity_failed:${String(error.message || error).slice(0, 240)}`,
            fingerprint: null, inputs: [], scope: null, durationMs: Math.round(performance.now() - startedAt) };
    }
}

module.exports = {
    DEFAULT_FILE,
    DEFAULT_SOURCE,
    EXPECTED_SOURCES,
    IDENTITY_LIMITS,
    inputIdentity,
    loadRegisteredSources,
    readAuthored,
    registeredJsonPaths,
    selectScope,
    selectedGeometry
};
