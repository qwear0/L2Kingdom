'use strict';

function busyReasons(session) {
    const reasons = [];
    for (const [name, held] of [
        ['vassal_admission', session.vassalAdmission], ['vassal_operation', session.vassalOperation],
        ['vassal_publication', session.vassalReceipt], ['teleport', session.pendingActorTeleport],
        ['trade', session.trade || session.activeTrade || session.activeNegotiation || session.botTrade],
        ['multisell', session.multiSellPending], ['journey_payment_uncertain', session.journey?.paymentUncertain]
    ]) if (held) reasons.push(name);
    return reasons;
}
function snapshot(record, identity) {
    const { session, actor } = record;
    const owner = require('../../Lord/VassalService').find(record.id);
    return { ...identity, sampledAt: Date.now(), view: 'server_diagnostic',
        control: { attachmentMode: 'read_only', ...require('./Authority').view(session), aiActive: session.aiActive === true,
            plan: typeof session.plan === 'string' ? session.plan.slice(0, 100) : null,
            busyReasons: busyReasons(session) },
        self: { characterId: record.id, ownerCharacterId: owner.ownerCharacterId,
            name: actor.fetchName(), classId: actor.fetchClassId(), level: actor.fetchLevel(),
            position: { x: actor.fetchLocX(), y: actor.fetchLocY(), z: actor.fetchLocZ(), heading: actor.fetchHead() },
            hp: actor.fetchHp(), maxHp: actor.fetchMaxHp(), mp: actor.fetchMp(), maxMp: actor.fetchMaxMp(),
            cp: actor.fetchCp(), maxCp: actor.fetchMaxCp(), dead: actor.state.fetchDead(),
            seated: actor.state.fetchSeated(), moving: Boolean(actor.state.fetchTowards()),
            attacking: Boolean(actor.state.fetchHits()), casting: Boolean(actor.state.fetchCasts()),
            targetId: actor.fetchDestId() || null,
            inventory: { slots: actor.backpack.fetchItems().length, load: actor.fetchLoad?.() ?? null, maxLoad: actor.fetchMaxLoad(), revision: null },
            equippedWeapon: actor.backpack.paperdoll?.[actor.backpack.equipment.weapon] || actor.backpack.paperdoll?.[actor.backpack.equipment.dual] || null,
            equipmentRevision: Number.isSafeInteger(actor.backpack.equipmentRevision) ? actor.backpack.equipmentRevision : null,
            floor: null, floorSource: 'use movement diagnostics for current native geodata layer',
            summonId: actor.summon?.fetchId?.() || actor.pet?.fetchId?.() || null },
        completeness: { self: true, localScene: false, semanticEvents: Boolean(session.mcpObservation),
            omitted: ['nearby', 'inventory', 'effects', 'skills', 'quests', 'dialogue', 'party', 'summon', 'actionReceipts'],
            inventoryRevision: null, eventCursor: session.mcpObservation ? require('./Journal').cursor(session.mcpObservation) : null } };
}
module.exports = { busyReasons, snapshot };
