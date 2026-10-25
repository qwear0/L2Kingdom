const ClassProgression = require('../ClassProgression');
const SkillRanks = require('../Skills/SkillRankIndex');
const MIXED_CLASSES = new Set([7, 22, 35]);

// These are catalog tiers, not gear selected by a level/price percentile.
const EQUIPMENT = {
    high: {
        heavy: [353, 380, 2412, 607, 2428], // Half Plate / Plate
        light: [396, 2412, 607, 2427], // Salamander Skin (full body)
        robe: [438, 2412, 2451, 2428], // Sage's Rag (full body)
        sword: 2499, blunt: 159, caster: 189, dagger: 225, bow: 280,
        fist: 262, pole: 297, greatsword: 124, dual: 2548,
        shield: 2494, necklace: 914, ring: 882, earring: 851
    },
    mid: {
        heavy: [349, 378, 47, 63, 553], // Compound Scale
        light: [394, 416, 47, 2446, 2422], // Reinforced Leather
        robe: [436, 469, 47, 2447, 2423], // Knowledge
        sword: 127, blunt: 88, caster: 186, dagger: 223, bow: 278,
        fist: 260, pole: 293, greatsword: 70, dual: 2525,
        shield: 629, necklace: 912, ring: 880, earring: 849
    }
};

const SUPPLIES = Object.freeze([
    { itemId: 1061, appliesTo: 'all', starterCount: 100, restockMin: 10, restockTarget: 40, priority: 1 },
    { itemId: 1540, appliesTo: 'all', starterCount: 10, restockMin: 2, restockTarget: 5, priority: 2 },
    { itemId: 1831, appliesTo: 'all', starterCount: 20, restockMin: 2, restockTarget: 10, priority: 4 },
    { itemId: 1833, appliesTo: 'all', starterCount: 20, restockMin: 2, restockTarget: 10, priority: 4 },
    { itemId: 1062, appliesTo: 'all', starterCount: 20, restockMin: 2, restockTarget: 10, priority: 4 },
    { itemId: 736, appliesTo: 'all', starterCount: 20, restockMin: 1, restockTarget: 5, priority: 3 },
    { itemId: 737, appliesTo: 'all', starterCount: 10, restockMin: 0, restockTarget: 2, priority: 5 },
    { itemId: 735, appliesTo: 'physical', starterCount: 20, restockMin: 2, restockTarget: 10, priority: 4 },
    { itemId: 6035, appliesTo: 'caster', starterCount: 20, restockMin: 2, restockTarget: 10, priority: 4 },
    { itemId: 1463, appliesTo: 'physical', starterCount: 5000, restockMin: 200, restockTarget: 2000, priority: 2 },
    { itemId: 3948, appliesTo: 'caster', starterCount: 5000, restockMin: 100, restockTarget: 1000, priority: 2 },
    { itemId: 1341, appliesTo: 'bow', starterCount: 5000, restockMin: 100, restockTarget: 1000, priority: 1 }
].map(Object.freeze));

// Upgraded variants and blessed scrolls are paid shop stock only, not
// starter rewards or automatic standard-restock targets.
const SHOP_ONLY_ITEM_IDS = Object.freeze([1539, 1832, 1834, 1375, 6036, 1538, 3936]);

function loadout(classId, preference = null) {
    const id = Number(classId);
    if (preference != null && (!MIXED_CLASSES.has(id) || !['bow', 'dagger'].includes(preference))) throw Error('invalid_loadout');
    const Roles = invoke('GameServer/Bot/AI/BotRoles');
    const Compatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
    const role = Roles.inferRole(id);
    const profile = Compatibility.profileFor(role, id);
    const caster = [10, 25, 38, 49].includes(ClassProgression.lineage(id)[0]);
    const kind = preference || (MIXED_CLASSES.has(id) ? (id === 22 ? 'bow' : 'dagger')
        : profile.armorStyle === 'robe' ? 'caster' : ({ 'Weapon.Sword': 'sword', 'Weapon.Blunt': 'blunt', 'Weapon.Knife': 'dagger',
            'Weapon.Bow': 'bow', 'Weapon.DualFist': 'fist', 'Weapon.Fist': 'fist', 'Weapon.Pole': 'pole',
            'Weapon.GreatSword': 'greatsword', 'Weapon.Dual': 'dual' })[profile.preferredWeaponKinds[0]]);
    if (!kind) throw Error('unsupported_starter_class');
    return { role, caster, kind, armorStyle: profile.armorStyle, shield: profile.shield && !['bow','fist','pole','greatsword','dual'].includes(kind) };
}

function skillsFor(classId) {
    const Data = invoke('GameServer/DataCache');
    const result = new Map();
    for (const ancestor of ClassProgression.lineage(classId)) {
        const tree = ClassProgression.firstClassRow(Data.skillTree, ancestor, 'strict');
        if (!tree) throw Error(`missing_starter_skill_tree:${ancestor}`);
        for (const skill of tree.skills || []) {
            const eligible = skill.levels.filter(rank => Number(rank.pLevel) <= 20).sort((a,b) => a.level - b.level).pop();
            if (!eligible) continue;
            const definition = Data.skills.find(row => Number(row.selfId) === Number(skill.selfId));
            const rank = SkillRanks.findOrLastEligible(definition?.levels || [], eligible.level);
            if (!definition || !rank) throw Error(`missing_starter_skill:${skill.selfId}`);
            const previous = result.get(Number(skill.selfId));
            if (!previous || previous.level < rank.level) result.set(Number(skill.selfId), {
                selfId: Number(skill.selfId), name: definition.template.name,
                level: Number(rank.level), passive: definition.template.passive === true
            });
        }
    }
    return [...result.values()];
}

function reagentsFor(learnedSkills) {
    const Data = invoke('GameServer/DataCache');
    const costs = new Map();
    const retain = (itemId, count) => {
        if ([1458, 1785, 3031].includes(Number(itemId)) && Number(count) > 0)
            costs.set(Number(itemId), Math.max(costs.get(Number(itemId)) || 0, Number(count)));
    };
    for (const learned of learnedSkills) {
        const definition = Data.skills.find(row => Number(row.selfId) === Number(learned.selfId));
        const rank = SkillRanks.findOrLastEligible(definition?.levels || [], learned.level);
        if (!rank) throw Error(`missing_reagent_skill:${learned.selfId}`);
        // These are Skill.fetchItemConsume*'s authored rank fields, including
        // a summon lifecycle's later payments, not a class-wide ore bundle.
        retain(rank.itemId, rank.itemCount);
        retain(rank.itemIdOT, Number(rank.itemCountOT || 0) * Number(rank.itemConsumeSteps || 1));
    }
    return [...costs].map(([itemId, cost]) => ({ itemId, appliesTo: 'learnedSkill', starterCount: cost * 5,
        restockMin: cost, restockTarget: cost * 5, priority: 1 }));
}

function prepare(classId, tier, preference = null) {
    const Data = invoke('GameServer/DataCache');
    const kit = EQUIPMENT[tier], profile = loadout(classId, preference);
    if (!kit) throw Error('invalid_starter_tier');
    const item = (selfId, amount = 1, equipped = false, pairedSlot = null) => {
        const row = Data.items.find(entry => Number(entry.selfId) === Number(selfId));
        if (!row || (equipped && row.etc?.rank !== 'd')) throw Error(`invalid_starter_item:${selfId}`);
        return { selfId, name: row.template.name, amount, equipped, slot: pairedSlot ?? Number(row.etc?.slot || 0), stackable: row.etc?.stackable === true };
    };
    const weapon = item(kit[profile.kind], 1, true);
    const items = [weapon, ...kit[profile.armorStyle].map(id => item(id, 1, true)),
        item(kit.necklace,1,true), item(kit.ring,1,true,4), item(kit.ring,1,true,5),
        item(kit.earring,1,true,1), item(kit.earring,1,true,2)];
    if (profile.shield && weapon.slot !== 14) items.push(item(kit.shield,1,true));
    for (const supply of SUPPLIES) {
        if (supply.appliesTo === 'all' || supply.appliesTo === (profile.caster ? 'caster' : 'physical')
            || supply.appliesTo === profile.kind) items.push(item(supply.itemId, supply.starterCount));
    }
    const skills = skillsFor(classId);
    for (const reagent of reagentsFor(skills)) items.push(item(reagent.itemId, reagent.starterCount));
    items.push(item(57, tier === 'high' ? 1000000 : 100000));
    return { classId: Number(classId), items, skills, exp: Number(Data.experience[19]) };
}
module.exports = { prepare, loadout, skillsFor, reagentsFor, SUPPLIES, SHOP_ONLY_ITEM_IDS, MIXED_CLASSES };
