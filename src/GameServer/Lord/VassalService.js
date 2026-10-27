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
    async issueOrder(session, { characterId, revision, order, areaId = null }) {
        await this.init();
        const Access = require('./CastellanAccess');
        const Areas = require('./GatherAreas');
        const actor = Access.requireContact(session), ownerId = Number(actor.fetchId());
        const row = this.find(characterId);
        if (!this.isLord(ownerId) || !row || row.ownerCharacterId !== ownerId) throw Error('not_owned_vassal');
        if (!Number.isSafeInteger(revision) || row.orderRevision !== revision) throw Error('vassal_order_changed');
        if (!['gather', 'return', 'service'].includes(order) || order !== 'gather' && areaId !== null) throw Error('invalid_vassal_order');
        const character = (await Database.fetchOwnedVassalCharacters()).find(entry => Number(entry.id) === row.characterId);
        const validate = () => {
            Access.requireContact(session, actor);
            const bot = invoke('GameServer/Bot/BotManager').sessions.find(entry => Number(entry.actor?.fetchId()) === row.characterId);
            if (bot?.mcpControl && !bot.mcpControl.preempt('owner_duty_order')) throw Error('vassal_busy');
            if (bot?.vassalAdmission || bot?.vassalOperation || bot?.vassalReceipt || bot?.pendingActorTeleport || bot?.hotBackgroundPartyId) throw Error('vassal_busy');
            if (order === 'gather' && !Areas.suitable(Areas.find(areaId), bot?.actor?.fetchLevel() ?? character?.level)) throw Error('unsuitable_gather_area');
        };
        validate();
        const bot = invoke('GameServer/Bot/BotManager').sessions.find(entry => Number(entry.actor?.fetchId()) === row.characterId);
        const updated = await Database.updateVassalDuty({ characterId: row.characterId, ownerCharacterId: ownerId,
            revision, order, areaId, gatherResumePending: () => order === 'gather' && bot?.partyCompanion === true,
            accountId: session.accountId, beforeWrite: validate });
        if (!updated) throw Error('vassal_order_changed');
        const value = publish(updated);
        if (bot) {
            require('../Bot/AI/VassalOrders').invalidate(bot);
            if (order === 'gather' && bot.partyCompanion) bot.plan = 'following';
            if (order !== 'gather' && bot.partyCompanion && bot.followPlayerSession)
                invoke('GameServer/Bot/AI/PartyCompanionService').detach(bot.followPlayerSession, bot, { source: 'vassal_order' });
            invoke('GameServer/Bot/BotAI').wakeup(bot, { urgent: true });
        }
        return value;
    },
    async resumeMarker(row, pending, beforeWrite = null) {
        const updated = await Database.updateVassalDuty({ characterId: row.characterId, ownerCharacterId: row.ownerCharacterId,
            revision: row.orderRevision, order: row.order, areaId: row.areaId, gatherResumePending: pending, beforeWrite });
        return updated ? publish(updated) : null;
    },
    async replaceNonGatherOrder(ownerId, characterId, revision, order) {
        if (!['return', 'service'].includes(order) || !this.owns(ownerId, characterId)) throw Error('invalid_vassal_order');
        const row = await Database.updateVassalDuty({ characterId, ownerCharacterId: ownerId, revision, order });
        return row ? publish(row) : null;
    }
};
module.exports = Service;
