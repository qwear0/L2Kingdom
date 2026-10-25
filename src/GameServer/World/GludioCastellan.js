// Reuse a stock C4 service appearance; only the server-side identity is new.
const { npcId, loc } = require('../Lord/CastellanAccess');
const template = structuredClone(require('./GiranMammon').npcs[0]);
template.selfId = npcId;
template.template = { ...template.template, displayId: 8126, name: 'Castellan', title: 'Lord and Vassals' };
const spawns = [{
    selfId: 'gludio_castellan',
    bounds: [{ locX: loc.locX, locY: loc.locY, minZ: loc.locZ - 200, maxZ: loc.locZ + 200 }],
    spawns: [{ selfId: npcId, name: template.template.name, coords: [{ ...loc, head: 49152 }], total: 1, respawn: 60, bias: 0 }]
}];
module.exports = { npcId, loc, npcs: [template], spawns };
