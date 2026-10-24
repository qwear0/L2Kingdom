const DataCache = invoke('GameServer/DataCache');
const ClassProgression = invoke('GameServer/ClassProgression');
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');

const WEAPONS = {
    sword: { id: 2499, name: 'Elven Long Sword', armor: 'heavy' },
    blunt: { id: 159, name: 'Bonebreaker', armor: 'heavy' },
    pole: { id: 297, name: 'Glaive', armor: 'heavy' },
    fists: { id: 262, name: 'Scallop Jamadhr', armor: 'light' },
    dagger: { id: 225, name: 'Mithril Dagger', armor: 'light' },
    bow: { id: 280, name: 'Light Crossbow', armor: 'light' },
    staff: { id: 188, name: 'Ghost Staff', armor: 'robe' },
    cleric: { id: 189, name: 'Staff of Life', armor: 'robe' }
};
const ARMOR = { heavy: [353, 380], light: [396], robe: [438] };
const FIRST_OPTIONS = {
    1: ['sword', 'pole'], 4: ['sword', 'blunt'], 7: ['bow', 'dagger'],
    11: ['staff'], 15: ['cleric'], 19: ['sword'], 22: ['bow', 'dagger'],
    26: ['staff'], 29: ['cleric'], 32: ['sword'], 35: ['bow', 'dagger'],
    39: ['staff'], 42: ['cleric'], 45: ['blunt', 'pole'], 47: ['fists'],
    50: ['cleric'], 54: ['blunt', 'pole'], 56: ['blunt', 'pole']
};

function choices(classId) {
    const lineage = ClassProgression.lineage(classId);
    const second = lineage[2];
    if ([9, 24, 37].includes(second)) return ['bow'];
    if ([8, 23, 36].includes(second)) return ['dagger'];
    if (second === 3) return ['pole'];
    return FIRST_OPTIONS[lineage[1]] || [];
}

function item(selfId, extra = {}) {
    const source = ItemTemplateIndex.findStrictRequired(DataCache.items, selfId);
    return { selfId, name: source.template.name, amount: 1, slot: Number(source.etc?.slot || 0),
        stackable: source.etc?.stackable === true, ...extra };
}

function kit(classId, choice, { equipped = false, consumables = false, adena = 0 } = {}) {
    if (!choices(classId).includes(choice)) throw new Error('Choose a kit available for your profession.');
    const weapon = WEAPONS[choice];
    const result = [item(weapon.id), ...ARMOR[weapon.armor].map(id => item(id)),
        ...[2412, 61, 1125, 914].map(id => item(id)),
        item(851, { slot: 1 }), item(851, { slot: 2 }),
        item(882, { slot: 4 }), item(882, { slot: 5 })];
    if (result[0].slot === 7) result.push(item(630));
    result.forEach(entry => {
        const source = ItemTemplateIndex.findStrictRequired(DataCache.items, entry.selfId);
        if (String(source.etc?.rank).toLowerCase() !== 'd') throw new Error(`Invalid fortress D-grade item ${entry.selfId}`);
        entry.equipped = equipped;
    });
    if (consumables) {
        result.push(item(weapon.armor === 'robe' ? 3948 : 1463, { amount: weapon.armor === 'robe' ? 2000 : 3000 }),
            item(1061, { amount: 30 }), item(728, { amount: 20 }),
            item(734, { amount: 10 }), item(735, { amount: 10 }), item(6036, { amount: 10 }),
            item(1832, { amount: 10 }), item(1834, { amount: 10 }),
            item(736, { amount: 3 }), item(737, { amount: 3 }));
        if (choice === 'bow') result.push(item(1341, { amount: 1000 }));
    }
    if (adena) result.push(item(57, { amount: adena }));
    return result;
}

module.exports = { WEAPONS, choices, kit };
