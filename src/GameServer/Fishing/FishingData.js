const data = require('../../../data/Fishing/basic.json');
const fishByKey = new Map();
const ranksBySkill = new Map();

for (const fish of data.fishes) {
    const key = `${fish.level}:${fish.group}`;
    if (fishByKey.has(key) || fish.itemId < 6411 || fish.itemId > 6518
        || !(fish.hp > 0) || !(fish.duration > 0) || !(fish.checkTime > 0)) throw Error('invalid_basic_fishing_fish');
    fishByKey.set(key, Object.freeze(fish));
}
for (const rank of data.training) {
    let ranks = ranksBySkill.get(rank.skillId);
    if (!ranks) ranksBySkill.set(rank.skillId, ranks = new Map());
    if (ranks.has(rank.level) || ![1312, 1313, 1314, 1315].includes(rank.skillId)
        || !(rank.playerLevel > 0) || !(rank.adena > 0)) throw Error('invalid_basic_fishing_training');
    ranks.set(rank.level, Object.freeze(rank));
}
if (fishByKey.size !== 108 || data.training.length !== 79) throw Error('incomplete_basic_fishing_data');
Object.freeze(data.rod);

const isCatch = id => Number.isInteger(id) && id >= 6411 && id <= 6518;
const isSkill = id => id === 1312 || id === 1313 || id === 1314;
const isRod = item => Number(item?.fetchSelfId?.() ?? item?.selfId) === data.rod.itemId
    || (item?.fetchKind?.() ?? item?.kind) === 'Weapon.FishingRod';
const isLure = item => Number(item?.fetchSelfId?.() ?? item?.selfId) === data.lureId;
const isPair = (rod, lure) => Number(rod) === data.rod.itemId && Number(lure) === data.lureId;
const rank = (skillId, level) => ranksBySkill.get(skillId)?.get(level) || null;

function select(expertise) {
    const check = Math.floor(Math.random() * 100);
    const level = expertise <= 0 ? 1 : Math.max(1, Math.min(27,
        expertise + (check <= 50 ? 0 : check <= 85 ? -1 : 1)));
    const groupRoll = Math.floor(Math.random() * 100);
    const group = groupRoll <= 54 ? 1 : groupRoll <= 74 ? 0 : groupRoll <= 94 ? 2 : 3;
    const fish = fishByKey.get(`${level}:${group}`);
    if (!fish) throw Error('missing_basic_fishing_fish');
    return fish;
}

module.exports = { rod: data.rod, lureId: data.lureId, shotId: data.shotId,
    skillIds: Object.freeze([1312, 1313, 1314, 1315]), isCatch, isSkill, isRod, isLure, isPair, rank, select };
