const Layout = require('./FortressDefenseData');
const Loadouts = require('./FortressLoadouts');
const Attackers = require('./FortressAttackers');
const Squad = invoke('GameServer/Bot/FortressSquad');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Response = invoke('GameServer/Network/Response');
const ClassProgression = invoke('GameServer/ClassProgression');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const InventoryLimits = require('../Inventory/InventoryLimits');

function escape(text) {
    return String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function actorAvailable(session, actor = session?.actor) {
    return actor && session.actor === actor && invoke('GameServer/World/World').user.sessions.includes(session)
        && actor.fetchIsOnline() && !actor.state.fetchDead()
        && actor.fetchHp() > 0 && !actor.state.fetchCombats() && !actor.state.fetchHits()
        && !actor.state.fetchCasts() && !actor.fetchPrivateStore?.()
        && !session.activeTrade && !session.trade && !session.pendingActorTeleport;
}
async function manager(session) {
    const active = session?.activeNpcTalk;
    const actor = session?.actor;
    if (!actorAvailable(session, actor) || Number(active?.selfId) !== Layout.MANAGER_ID) throw new Error('Speak to Tamutak while alive and out of combat.');
    const npc = await invoke('GameServer/World/World').fetchNpc(active.objectId).catch(() => null);
    if (session.activeNpcTalk !== active || !actorAvailable(session, actor) || !npc || Number(npc.fetchSelfId()) !== Layout.MANAGER_ID
        || Math.hypot(actor.fetchLocX() - npc.fetchLocX(), actor.fetchLocY() - npc.fetchLocY()) > 300
        || Math.abs(actor.fetchLocZ() - npc.fetchLocZ()) > 400) throw new Error('Move closer to Tamutak.');
    return npc;
}
function capacity(actor, entries) {
    const backpack = actor.backpack;
    const extraSlots = entries.filter(entry => !entry.stackable || !backpack.fetchItemFromSelfId(entry.selfId)).length;
    const mass = entries.reduce((total, entry) => total + Number(ItemTemplateIndex.findStrictRequired(DataCache.items, entry.selfId).template.mass || 0) * entry.amount, 0);
    if (backpack.fetchItems().length + extraSlots > InventoryLimits.forActor(actor)) throw new Error('Make room in your inventory before claiming the equipment.');
    if (backpack.fetchTotalLoad() + mass > actor.fetchMaxLoad()) throw new Error('Your inventory is too heavy for the equipment kit.');
}
function publishRows(actor, rows, replace = false) {
    if (replace) actor.backpack.items = [];
    for (const row of rows) {
        const existing = actor.backpack.fetchItems().find(item => item.fetchId() === row.id);
        if (existing) existing.setAmount(row.amount);
        else actor.backpack.insertItem(row.id, row.selfId, { ...row });
    }
    actor.backpack.inventoryRevision = Number(actor.backpack.inventoryRevision || 0) + 1;
}
function page(session, body) {
    session.dataSendToMe(Response.npcHtml(session.activeNpcTalk?.objectId || 0, `<html><body>${body}<br><a action="bypass -h fortress-defense menu">Back</a></body></html>`));
    session.dataSendToMe(Response.actionFailed());
}
function menu(session, message = '') {
    const attack = Attackers.status();
    let html = utils.parseRawFile('data/Html/7495.html');
    html = html.replace('<!-- STATUS -->', `${escape(message)}<br>Squad: ${escape(Squad.status())}.<br>Attack: ${escape(attack.state)}, ${attack.releasedGroups}/15 groups, ${attack.releasedMobs}/75 attackers.${attack.failedGroup ? `<br>Technical failure in group ${attack.failedGroup}; no replay until restart.` : ''}<br>`);
    session.dataSendToMe(Response.npcHtml(session.activeNpcTalk?.objectId || 0, html));
    session.dataSendToMe(Response.actionFailed());
}
async function preparationMenu(session) {
    const actor = session.actor;
    const claimed = await Database.hasFortressPreparation(actor.fetchId());
    if (session.actor !== actor) return;
    if (claimed) {
        page(session, 'This character has already received the lifetime preparation kit and 10,000,000 Adena. Further supplies are sold in the shop.');
        return;
    }
    const professions = ClassProgression.firstProfMap[actor.fetchClassId()];
    if (professions) {
        const links = professions.map(id => {
            const name = DataCache.classTemplates.find(row => Number(row.classId) === id)?.template?.class || String(id);
            return `<a action="bypass -h fortress-defense profession ${id}">${escape(name)}</a><br>`;
        }).join('');
        page(session, `Choose your legal first profession. Your level will be raised to at least 20; higher levels are preserved.<br>${links}`);
    } else {
        const links = Loadouts.choices(actor.fetchClassId()).map(choice => `<a action="bypass -h fortress-defense claim ${choice}">${escape(Loadouts.WEAPONS[choice].name)} kit + 10,000,000 Adena</a><br>`).join('');
        page(session, `Choose one complete high-D equipment kit with 5,000 D-grade soulshots or blessed spiritshots for its weapon. Equipment is added unequipped without removing your current items. This claim is permanent, not renewed by server restart.<br>${links || 'No kit is available for this profession.'}`);
    }
}

async function prepare(session, operation, value) {
    if (session.fortressPreparationPending) return;
    const actor = session.actor;
    session.fortressPreparationPending = true;
    try {
        await invoke('GameServer/Quest/QuestService').mutate(session, async () => {
            await manager(session);
            if (await Database.hasFortressPreparation(actor.fetchId())) throw new Error('Preparation has already been claimed by this character.');
            if (session.actor !== actor) throw new Error('Character changed during preparation.');
            if (operation === 'profession') {
                const ClassTransfer = invoke('GameServer/ClassTransfer');
                if (!ClassTransfer.eligibility(actor, Number(value), { firstProfessionOnly: true }).ok) throw new Error('This first profession is not available for your character.');
            } else if (ClassProgression.firstProfMap[actor.fetchClassId()] || !Loadouts.choices(actor.fetchClassId()).includes(value)) {
                throw new Error('Choose your first profession and an appropriate equipment kit.');
            }
            if (actor.fetchLevel() < 20) await invoke('GameServer/World/Generics/NpcBypasses/AdminSetLevel').setOwnLevel(session, 20);
            await manager(session);
            if (session.actor !== actor) throw new Error('Character changed during preparation.');
            if (operation === 'profession') {
                const result = await invoke('GameServer/ClassTransfer').transfer(session, Number(value), { firstProfessionOnly: true });
                if (!result.ok) throw new Error('Profession change failed. Speak to Tamutak again.');
                return;
            }
            const entries = Loadouts.kit(actor.fetchClassId(), value, { adena: 10000000 });
            capacity(actor, entries);
            try {
                await Database.claimFortressPreparation(actor.fetchId(), entries, () => {
                    if (!actorAvailable(session, actor) || WriteQueue.hasPending(actor.fetchId())) throw new Error('Character or inventory changed. Wait briefly and try again.');
                    capacity(actor, entries);
                    return actor.backpack.fetchItems().map(item => [item.fetchId(), item.fetchSelfId(), item.fetchAmount(), item.fetchEquipped() ? 1 : 0])
                        .sort((a, b) => a[0] - b[0]);
                }, rows => publishRows(actor, rows));
            } catch (error) {
                if (!error.fortressClaimCommitted) throw error;
                utils.infoWarn('Fortress', 'committed preparation requires inventory reload: %s', error.cause?.message || error.message);
                try {
                    const rows = await Database.fetchItems(actor.fetchId(), 'fortress_claim_reconcile');
                    if (session.actor !== actor) throw new Error('Character disconnected');
                    publishRows(actor, rows, true);
                } catch (reloadError) {
                    utils.infoWarn('Fortress', 'preparation reload failed: %s', reloadError.message);
                    throw new Error('Your preparation is saved. Reconnect to reload the equipment and Adena; do not claim again.');
                }
            }
            session.dataSendToMe(Response.itemsList(actor.backpack.fetchItems()));
            session.dataSendToMe(Response.userInfo(actor));
        });
    } finally {
        session.fortressPreparationPending = false;
    }
    if (session.actor === actor) await preparationMenu(session);
}

module.exports = {
    START: Layout.START,
    MANAGER_ID: Layout.MANAGER_ID,
    async init() {
        if (invoke('GameServer/Bot/Population/PopulationConfig').enabled !== false) throw new Error('Fortress defense requires BotPopulation.enabled=false; remove BOT_POPULATION_ENABLED/local.ini overrides.');
        if (invoke('GameServer/Progression/ProgressionCap').clampLevel(20) < 20) throw new Error('Fortress preparation requires a progression cap of at least level 20.');
        for (const profile of Squad.PROFILES) Loadouts.kit(profile.classId, profile.choice, { equipped: true, consumables: true });
        await Squad.init();
    },
    menu,
    async handle(session, parts) {
        const actor = session.actor;
        try {
            await manager(session);
            const operation = parts[1] || 'menu';
            if (operation === 'prepare') return await preparationMenu(session);
            if (operation === 'profession' || operation === 'claim') return await prepare(session, operation, parts[2]);
            if (operation === 'shop') return invoke('GameServer/World/Generics/NpcBypasses/BuyShop')(session, ['buy-shop', 'npc']);
            if (operation === 'summon') {
                const message = await Squad.summon(session);
                if (session.actor === actor) menu(session, message);
                return;
            }
            if (operation === 'start') {
                const pending = Attackers.start();
                menu(session, 'Checking all approach paths. The gates open at attack start; the first group cannot spawn before the 30-second exit delay...');
                const message = await pending;
                if (session.actor === actor) menu(session, message);
                return;
            }
            menu(session);
        } catch (error) {
            utils.infoWarn('Fortress', 'manager action failed: %s', error.message);
            if (session.actor === actor && actor?.fetchIsOnline?.()) page(session, escape(error.message));
        }
    },
    async stop() {
        const results = await Promise.allSettled([Attackers.stop(), Squad.stop()]);
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Fortress shutdown was incomplete');
    }
};
