// Explicit mainland destinations, using authored spawn polygons rather than
// town-distance/name matching. P3 must also constrain spots and targets to
// these zones; menu eligibility alone is not a combat-safety decision.
const AREAS = Object.freeze([
    { id: 'ruins_of_agony', name: 'Ruins of Agony', spawnIds: ['gludio_t18_21_015', 't18_21_028', 'gludio_t18_21_030'] },
    { id: 'ruins_of_despair', name: 'Ruins of Despair', spawnIds: ['gludio_t19_22_062', 'gludio_t19_22_063', 'gludio_t19_22_064'] },
    { id: 'abandoned_camp', name: 'Abandoned Camp', spawnIds: ['gludio_t18_22_019', 'gludio_t18_22_020', 'gludio_t18_22_030', 'gludio_t18_22_031', 'gludio_t18_22_032'] },
    { id: 'langk_lizardmen', name: 'Langk Lizardmen (Gludin)', spawnIds: ['gludio_t18_24_004', 'gludio_t18_24_005', 'gludio_t18_24_006', 'gludio_t18_24_007', 'gludio_t18_24_008'] },
    { id: 'wasteland', name: 'Wasteland', spawnIds: ['w19_23_018', 'w19_23_019', 'w19_23_028', 'w19_23_035', 'w19_23_043'] }
].map(area => Object.freeze({ ...area, spawnIds: Object.freeze(area.spawnIds) })));

function list() {
    const Data = invoke('GameServer/DataCache');
    const templates = new Map(Data.npcs.map(row => [Number(row.selfId), row]));
    return AREAS.map(area => {
        const zones = area.spawnIds.map(id => Data.npcSpawns.find(zone => zone.selfId === id));
        if (zones.some(zone => !zone?.bounds?.length)) throw Error('gather_area_data_missing');
        const levels = zones.flatMap(zone => zone.spawns.map(spawn => templates.get(Number(spawn.selfId))))
            .filter(row => row?.template?.kind === 'Monster').map(row => Number(row.template.level)).filter(Number.isFinite);
        if (!levels.length) throw Error('gather_area_data_missing');
        return { ...area, zones, minLevel: Math.min(...levels), maxLevel: Math.max(...levels) };
    });
}
function find(id) { return list().find(area => area.id === id) || null; }
function suitable(area, level) {
    return !!area && Number.isFinite(Number(level)) && area.minLevel <= Number(level) + 3 && area.maxLevel >= Number(level) - 7;
}
module.exports = { list, find, suitable };
