const Database = invoke('Database');
const Kits = require('./StarterKits');
const lords = new Map(), vassals = new Map();
let ready = null;
function publish(row) {
    const value = Object.freeze({ ...row, characterId: Number(row.characterId), ownerCharacterId: Number(row.ownerCharacterId),
        gatherResumePending: Boolean(row.gatherResumePending), orderRevision: Number(row.orderRevision) });
    const previous = vassals.get(value.characterId);
    if (previous && previous.orderRevision > value.orderRevision) return previous;
    vassals.set(value.characterId, value);
    return value;
}
const Service = {
    init() {
        if (!ready) ready = Promise.all([Database.fetchLordRegistry(), Database.fetchVassalRegistry()]).then(([owners, rows]) => {
            lords.clear(); vassals.clear();
            for (const owner of owners) lords.set(Number(owner.characterId), Object.freeze({ ...owner }));
            rows.forEach(publish);
        }).catch(error => { ready = null; throw error; });
        return ready;
    },
    publish,
    publishLord(characterId) { lords.set(Number(characterId), Object.freeze({ characterId: Number(characterId) })); },
    isLord(characterId) { return lords.has(Number(characterId)); },
    find(characterId) { return vassals.get(Number(characterId)) || null; },
    owns(ownerId, characterId) { return this.find(characterId)?.ownerCharacterId === Number(ownerId); },
    roster(ownerId) { return [...vassals.values()].filter(row => row.ownerCharacterId === Number(ownerId)); },
    loadout(characterId, classId) {
        const preference = Kits.MIXED_CLASSES.has(Number(classId)) ? this.find(characterId)?.loadoutPreference || null : null;
        return Kits.loadout(classId, preference);
    },
    current(characterId, revision) { return this.find(characterId)?.orderRevision === Number(revision); },
    async replaceNonGatherOrder(ownerId, characterId, revision, order) {
        if (!['return', 'service'].includes(order) || !this.owns(ownerId, characterId)) throw Error('invalid_vassal_order');
        const row = await Database.updateVassalDuty({ characterId, ownerCharacterId: ownerId, revision, order });
        return row ? publish(row) : null;
    }
};
module.exports = Service;
