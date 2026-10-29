require('../Geodata/JourneyGeometryIdentity.js').define(module, require, function (module, exports, require, __filename, __dirname) {
// Explicit mainland destinations, using authored spawn polygons rather than
// town-distance/name matching. Both travel destinations and offensive targets
// stay in these zones; menu eligibility alone is not a combat-safety decision.
const AREAS = Object.freeze([
    // gludio_t18_21_009 has duplicate definitions with off-core bounds; neither
    // row establishes Agony territory, so keep that ID out of this allowlist.
    { id: 'ruins_of_agony', name: 'Ruins of Agony', spawnIds: [
        'gludio_t18_21_008', 'gludio_t18_21_014', 'gludio_t18_21_015', 'gludio_t18_21_016',
        'gludio_t18_21_021', 'gludio_t18_21_022', 'gludio_t18_21_023', 'gludio_t18_21_024',
        'gludio_t18_21_025', 'gludio_t18_21_026', 'gludio_t18_21_027', 't18_21_028',
        'gludio_t18_21_029', 'gludio_t18_21_030', 'gludio_t18_21_031', 'gludio_t18_21_032',
        'gludio_t18_21_033', 'gludio_t18_21_034'] },
    { id: 'ruins_of_despair', name: 'Ruins of Despair', spawnIds: ['gludio_t19_22_060', 'gludio_t19_22_061',
        'gludio_t19_22_062', 'gludio_t19_22_063', 'gludio_t19_22_064', 'gludio_t19_22_065',
        'gludio_t19_22_066', 'gludio_t19_22_067', 'gludio_t19_22_068'] },
    { id: 'abandoned_camp', name: 'Abandoned Camp', spawnIds: [
        'gludio_t18_22_018', 'gludio_t18_22_019', 'gludio_t18_22_020',
        'gludio_t18_22_027', 'gludio_t18_22_028', 'gludio_t18_22_029', 'gludio_t18_22_030',
        'gludio_t18_22_031', 'gludio_t18_22_032', 'gludio_t18_22_033', 'gludio_t18_22_034',
        'gludio_t18_022_035', 'gludio_t18_22_036', 'gludio_t18_22_037', 'glduio_t18_22_038',
        'gludio_t18_22_039', 'gludio_t18_22_040', 'gludio_t18_22_041', 'gludio_t18_22_042',
        'gludio_t18_22_043', 'gludio_t18_22_044', 'gludio_t18_22_045', 'gludio_t18_22_046',
        'gludio_t18_22_047', 'gludio_t18_22_048', 'gludio_t18_22_049', 'gludio_t18_22_050',
        'gludio_t18_22_051', 'gludio_t18_22_052', 'glduio_t18_22_053', 'gludio_t18_22_054',
        'gludio_t18_22_055', 'gludio_t18_22_056', 'gludio_t18_22_057', 'gludio_t18_22_058',
        'gludio_t18_22_059', 'gludio_t18_22_060'] },
    { id: 'langk_lizardmen', name: 'Langk Lizardmen (Gludin)', spawnIds: [
        'gludio_t18_24_001', 'gludio_t18_24_002', 'gludio_t18_24_003', 'gludio_t18_24_004',
        'gludio_t18_24_005', 'gludio_t18_24_006', 'gludio_t18_24_007', 'gludio_t18_24_008',
        'gludio_t18_24_009', 'gludio_t18_24_010', 'gludio_t18_24_011', 'gludio_t18_24_011_02',
        'gludio_t18_24_012', 'gludio_t18_24_013', 'gludio_t18_24_014', 'gludio_t18_24_015',
        'gludio_t18_24_016', 'gludio_t18_24_020', 'gludio_t18_24_021', 'gludio_t18_24_022',
        'gludio_t18_24_023', 'gludio_t18_24_024', 'gludio_t18_24_025', 'gludio_t18_24_026',
        'gludio_t18_24_027', 'gludio_t18_24_028'] },
    { id: 'wasteland', name: 'Wasteland', spawnIds: [
        'w18_23_001', 'w18_23_002', 'w18_23_003', 'w18_23_004', 'w18_23_005',
        'w18_23_006', 'w18_23_007', 'w18_23_008', 'w18_23_009', 'w18_23_010',
        'w18_23_011', 'w18_23_012', 'w18_23_013', 'w18_23_014', 'w18_23_015',
        'w18_23_016', 'w18_23_017', 'w18_23_018', 'w18_23_019', 'w18_23_020',
        'w18_23_021', 'w18_23_022', 'w18_23_023', 'w18_23_024', 'w18_23_025',
        'w18_23_026', 'w18_23_027', 'w18_23_028', 'w18_23_029', 'w18_23_030',
        'w18_23_031', 'w18_23_032', 'w18_23_033',
        'w19_23_001', 'w19_23_002', 'w19_23_003', 'w19_23_004', 'w19_23_005',
        'w19_23_006', 'w19_23_007', 'w19_23_008', 'w19_23_009', 'w19_23_010',
        'w19_23_011', 'w19_23_012', 'w19_23_013', 'w19_23_014', 'w19_23_015',
        'w19_23_016', 'w19_23_017', 'w19_23_018', 'w19_23_019', 'w19_23_020',
        'w19_23_021', 'w19_23_022', 'w19_23_023', 'w19_23_024', 'w19_23_025',
        'w19_23_026', 'w19_23_027', 'w19_23_028', 'w19_23_029', 'w19_23_030',
        'w19_23_031', 'w19_23_032', 'w19_23_033', 'w19_23_034', 'w19_23_035',
        'w19_23_036', 'w19_23_037', 'w19_23_038', 'w19_23_039', 'w19_23_040',
        'w19_23_041', 'w19_23_042', 'w19_23_043',
        'w19_24_001', 'w19_24_002', 'w19_24_003', 'w19_24_004', 'w19_24_005',
        'w19_24_006', 'w19_24_007', 'w19_24_008', 'w19_24_009', 'w19_24_010',
        'w19_24_011', 'w19_24_012', 'w19_24_013', 'w19_24_014', 'w19_24_015',
        'w19_24_016', 'w19_24_017', 'w19_24_018', 'w19_24_019', 'w19_24_020',
        'w19_24_021', 'w19_24_022', 'w19_24_023'] }
].map(area => Object.freeze({ ...area, spawnIds: Object.freeze(area.spawnIds) })));

let cached = null;
// DataCache resources are static for an array's lifetime; replacements rebuild
// the catalog. Publish only a fully validated result, never actor/target state.
function catalog() {
    const Data = invoke('GameServer/DataCache');
    if (!Array.isArray(Data.npcs) || !Array.isArray(Data.npcSpawns)) throw Error('gather_area_data_missing');
    if (cached?.npcs === Data.npcs && cached.npcSpawns === Data.npcSpawns) return cached;
    const ids = AREAS.flatMap(area => area.spawnIds), selected = new Set(ids);
    if (selected.size !== ids.length) throw Error('gather_area_data_ambiguous');
    const zonesById = new Map();
    for (const zone of Data.npcSpawns) {
        if (!selected.has(zone.selfId)) continue;
        if (zonesById.has(zone.selfId)) throw Error('gather_area_data_ambiguous');
        zonesById.set(zone.selfId, zone);
    }
    const templates = new Map();
    for (const row of Data.npcs) {
        const id = Number(row.selfId);
        // Unrelated datapack duplicates must not reject this catalog, but a
        // referenced duplicate must never silently pick one definition.
        templates.set(id, templates.has(id) ? null : row);
    }
    const areas = Object.freeze(AREAS.map(area => {
        let minLevel = Infinity, maxLevel = -Infinity;
        const zones = area.spawnIds.map(id => {
            const zone = zonesById.get(id);
            if (!Array.isArray(zone?.bounds) || zone.bounds.length < 3
                || zone.bounds.some(p => ![p.locX, p.locY, p.minZ, p.maxZ].every(Number.isFinite) || p.minZ > p.maxZ)
                || !Array.isArray(zone.spawns) || !zone.spawns.length) throw Error('gather_area_data_missing');
            let hasMonster = false;
            for (const spawn of zone.spawns) {
                const id = Number(spawn.selfId), row = templates.get(id);
                if (templates.has(id) && row === null) throw Error('gather_area_data_ambiguous');
                if (!row?.template) throw Error('gather_area_data_missing');
                if (row.template.kind !== 'Monster') continue;
                const level = Number(row.template.level);
                if (!Number.isFinite(level) || level <= 0) throw Error('gather_area_data_missing');
                minLevel = Math.min(minLevel, level);
                maxLevel = Math.max(maxLevel, level);
                hasMonster = true;
            }
            if (!hasMonster) throw Error('gather_area_data_missing');
            return zone;
        });
        return Object.freeze({ ...area, zones: Object.freeze(zones), minLevel, maxLevel });
    }));
    cached = { npcs: Data.npcs, npcSpawns: Data.npcSpawns, areas, byId: new Map(areas.map(area => [area.id, area])) };
    return cached;
}
function list() { return catalog().areas; }
function find(id) { return catalog().byId.get(id) || null; }
function pointOf(actor) {
    return { locX: Number(actor.fetchLocX?.() ?? actor.locX), locY: Number(actor.fetchLocY?.() ?? actor.locY),
        locZ: Number(actor.fetchLocZ?.() ?? actor.locZ) };
}
function containsZone(zone, value) {
    const p = pointOf(value), bounds = zone.bounds;
    if (!bounds?.length || !Object.values(p).every(Number.isFinite)
        || p.locZ < Math.min(...bounds.map(v => v.minZ)) || p.locZ > Math.max(...bounds.map(v => v.maxZ))) return false;
    let inside = false;
    for (let i = 0, j = bounds.length - 1; i < bounds.length; j = i++) {
        const a = bounds[i], b = bounds[j];
        if ((a.locY > p.locY) !== (b.locY > p.locY)
            && p.locX < (b.locX - a.locX) * (p.locY - a.locY) / (b.locY - a.locY) + a.locX) inside = !inside;
    }
    return inside;
}
function contains(area, value) { return !!area?.zones.some(zone => containsZone(zone, value)); }
function suitable(area, level) {
    return !!area && Number.isFinite(Number(level)) && area.minLevel <= Number(level) + 3 && area.maxLevel >= Number(level) - 7;
}
module.exports = { list, find, suitable, contains, containsZone, pointOf };
});
