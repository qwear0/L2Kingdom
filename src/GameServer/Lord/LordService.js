const { randomUUID, randomBytes } = require('node:crypto');
const Database = invoke('Database');
const ClassProgression = require('../ClassProgression');
const Kits = require('./StarterKits');
const Registry = require('./VassalService');
const Access = require('./CastellanAccess');

function publishReward(session, actor, result) {
    if (session.actor !== actor) return { ...result, publicationPending: true };
    const Backpack = invoke('GameServer/Actor/Backpack');
    const paperdoll = Array.from({ length: 16 }, () => ({}));
    for (const item of result.items.filter(row => row.equipped)) {
        paperdoll[item.slot] = { id: item.id, selfId: item.selfId };
        if (item.slot === 15) paperdoll[10] = paperdoll[15];
    }
    const oldBackpack = actor.backpack;
    actor.backpack = new Backpack({ items: result.items, paperdoll });
    actor.backpack.onInventoryChange = oldBackpack.onInventoryChange;
    actor.backpack.inventoryRevision = Math.max(Number(oldBackpack.inventoryRevision || 0), Number(actor.backpack.inventoryRevision || 0)) + 1;
    actor.backpack.equipmentRevision = Number(oldBackpack.equipmentRevision || 0) + 1;
    actor.setClassId(result.character.classId);
    actor.setLevel(result.character.level);
    actor.setExpSp(result.character.exp, result.character.sp);
    actor.skillset.populateSnapshot(result.skills.map(row => ({ ...row, passive: Boolean(row.passive) })));
    invoke('GameServer/Actor/Generics/CalculateStats')(session, actor);
    if (!result.replayed) actor.fillupVitals();
    invoke('GameServer/Persistence/CharacterWriteQueue').vitals(actor.fetchId(), actor.fetchHp(), actor.fetchMaxHp(), actor.fetchMp(), actor.fetchMaxMp());
    const Response = invoke('GameServer/Network/Response');
    session.dataSendToMe(Response.itemsList(actor.backpack.fetchItems()));
    session.dataSendToMe(Response.skillsList(actor.skillset.fetchSkills()));
    session.dataSendToMe(Response.userInfo(actor));
    session.dataSendToMe(Response.statusUpdate(actor.fetchId(), require('../ClassTransfer').statusParams(actor)));
    session.dataSendToOthers(Response.charInfo(actor), actor);
    return result;
}

async function publishClan(session, actor, result) {
    const Clans = invoke('GameServer/Clan/ClanService');
    if (session.actor !== actor) return { ...result, publicationPending: true };
    actor.setClanId(result.clanId);
    actor.setClanPrivileges(Clans.rules.CP_ALL);
    await Clans.reload();
    if (session.actor !== actor || Number(actor.fetchClanId()) !== Number(result.clanId)) return { ...result, publicationPending: true };
    const clan = Clans.findById(result.clanId);
    const member = clan?.members.find(row => Number(row.id) === Number(actor.fetchId()));
    if (!member) throw Error('committed_clan_member_missing');
    actor.setClanId(clan.id);
    actor.setClanPrivileges(member.clanPrivileges);
    actor.setClanJoinExpiryTime(0);
    actor.setClanCreateExpiryTime(0);
    session.dataSendToMe(invoke('GameServer/Network/Response').joinPledge(clan.id));
    Clans.publishCommittedRoster(clan.id);
    return result;
}

// A committed result normally stays successful if packet/cache publication
// fails: reopening reloads its receipt, never replacement rewards. Shutdown
// must instead reject publication failure before capturing stale live state.
async function afterCommit(result, publish) {
    try { return await publish(); }
    catch (error) {
        utils.infoWarn('Lord', 'committed operation requires publication reload: %s', error.message);
        if (require('../GameplayLifecycle').stopping) throw error;
        return { ...result, publicationPending: true, publicationError: error.message };
    }
}

const Service = {
    async enroll(session, { firstClassId, loadoutPreference = null } = {}) {
        await Registry.init();
        const actor = Access.requireContact(session), sourceClassId = Number(actor.fetchClassId());
        let prepared = null;
        if (!Registry.isLord(actor.fetchId())) {
            const target = ClassProgression.firstProfMap[sourceClassId] ? Number(firstClassId) : sourceClassId;
            if (ClassProgression.firstProfMap[sourceClassId] && !ClassProgression.firstProfMap[sourceClassId].includes(target)) throw Error('invalid_first_profession');
            prepared = { ...Kits.prepare(target, 'high', loadoutPreference), sourceClassId, sourceLevel: actor.fetchLevel() };
        }
        const result = await Database.grantLord({ characterId: actor.fetchId(), accountId: session.accountId, prepared, beforeWrite: Access.fence(session) });
        return afterCommit(result, async () => {
            Registry.publishLord(actor.fetchId());
            const published = publishReward(session, actor, result);
            if (session.actor === actor) await invoke('GameServer/Shortcuts').refreshSkills(session, actor);
            await invoke('GameServer/Clan/ClanService').reload();
            invoke('GameServer/Clan/ClanService').publishCommittedRoster(result.character.clanId);
            return published;
        });
    },
    async ensureClan(session, name) {
        await Registry.init();
        const actor = Access.requireContact(session);
        const result = await Database.ensureLordClan({ characterId: actor.fetchId(), accountId: session.accountId, name, beforeWrite: Access.fence(session) });
        return afterCommit(result, () => publishClan(session, actor, result));
    },
    issueCreationConfirmation(session, { race, sex, baseClassId, firstClassId, loadoutPreference = null } = {}) {
        const actor = Access.requireContact(session);
        const Data = invoke('GameServer/DataCache');
        const base = Data.classTemplates.find(row => Number(row.classId) === Number(baseClassId));
        if (!Registry.isLord(actor.fetchId()) || !base || Number(base.template.race) !== Number(race)
            || ![0,1].includes(Number(sex)) || !ClassProgression.firstProfMap[Number(baseClassId)]?.includes(Number(firstClassId))) throw Error('invalid_vassal_selection');
        Kits.loadout(Number(firstClassId), loadoutPreference);
        const confirmation = Object.freeze({ id: randomUUID(), ownerCharacterId: actor.fetchId(), expiresAt: Date.now() + 10 * 60 * 1000,
            race: Number(race), sex: Number(sex), classId: Number(firstClassId), loadoutPreference });
        session.vassalCreationConfirmation = confirmation;
        return confirmation;
    },
    async confirmCreation(session, requestId) {
        await Registry.init();
        const actor = Access.requireContact(session), beforeWrite = Access.fence(session);
        const confirmation = session.vassalCreationConfirmation;
        let prepared = null;
        const knownReceipt = Registry.roster(actor.fetchId()).some(row => row.creationRequestId === requestId);
        if (!knownReceipt && confirmation?.id === requestId && confirmation.ownerCharacterId === actor.fetchId()) {
            const Data = invoke('GameServer/DataCache');
            const info = Data.classTemplates.find(row => Number(row.classId) === confirmation.classId);
            const username = `bot_vassal_${randomUUID()}`;
            const Names = invoke('GameServer/Bot/Population/BotNameGenerator');
            const name = await invoke('GameServer/Bot/BotManager').resolveCharacterName(Names.nameFor(randomBytes(4).readUInt32LE(0), { classId: confirmation.classId }));
            const Formulas = invoke('GameServer/Formulas');
            prepared = { ...Kits.prepare(confirmation.classId, 'mid', confirmation.loadoutPreference),
                username, password: randomBytes(32).toString('hex'), name, race: confirmation.race, sex: confirmation.sex,
                loadoutPreference: confirmation.loadoutPreference, ...Access.loc,
                maxHp: Formulas.calcHp(20, confirmation.classId, info.base.con),
                maxMp: Formulas.calcMp(20, [10,25,38,49].includes(ClassProgression.lineage(confirmation.classId)[0]) ? 1 : 0, 1, info.base.men) };
        }
        const result = await Database.createOwnedVassal({ ownerCharacterId: actor.fetchId(), accountId: session.accountId,
            requestId, expiresAt: prepared ? confirmation.expiresAt : 0, prepared, beforeWrite });
        return afterCommit(result, async () => {
            Registry.publish(result.vassal);
            await invoke('GameServer/Clan/ClanService').reload();
            const bot = await invoke('GameServer/Bot/BotManager').restoreOwnedVassal(result.character, { created: !result.replayed });
            if (!bot) throw Error('committed_vassal_not_published');
            invoke('GameServer/Clan/ClanService').publishCommittedRoster(result.vassal.boundClanId);
            return result;
        });
    }
};
module.exports = Service;
