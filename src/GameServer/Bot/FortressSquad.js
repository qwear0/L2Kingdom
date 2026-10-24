const { randomBytes, randomInt } = require('crypto');
const Database = invoke('Database');
const Layout = require('../World/FortressDefenseData');
const Loadouts = require('../World/FortressLoadouts');

const PROFILES = [
    { name: 'Aurelia', race: 0, sex: 1, classId: 15, choice: 'cleric' },
    { name: 'Brann', race: 0, sex: 0, classId: 4, choice: 'sword' },
    { name: 'Cedric', race: 0, sex: 0, classId: 7, choice: 'bow' },
    { name: 'Nyra', race: 2, sex: 1, classId: 39, choice: 'staff' },
    { name: 'Elowen', race: 1, sex: 1, classId: 26, choice: 'staff' }
];
const accounts = new Map();
let state = 'initializing';
let stopped = false;
let inFlight = null;

function mayActivate(username, profile) {
    const owned = accounts.get(username);
    return !stopped && !!owned && owned.ownerId === Number(profile.fortressOwnerId)
        && !profile.prepareOnly && ['summoning', 'summoned'].includes(state);
}

function ownsSession(session) {
    const owned = accounts.get(session?.accountId);
    return !!owned && owned.ownerId === Number(session.fortressOwnerId)
        && owned.characterId === Number(session.actor?.fetchId?.());
}

async function equip(characterId, profile) {
    const owned = accounts.get(profile.username);
    if (!owned || !mayActivate(profile.username, profile)) throw new Error('Squad provisioning is no longer active');
    owned.characterId = characterId;
    const items = Loadouts.kit(profile.classId, profile.choice, { equipped: true, consumables: true, adena: 100000 });
    await Promise.all(items.map(item => Database.setItem(characterId, item)));
}

function dispose(session) {
    if (!session?.actor) return;
    const actor = session.actor;
    const errors = [];
    const attempt = work => { try { work(); } catch (error) { errors.push(error); } };
    // One failed subsystem must not leave a published actor or a live AI tick
    // behind. Keep durable ownership when cleanup is incomplete for startup.
    session.aiActive = false;
    attempt(() => invoke('GameServer/Bot/AI/PartyCompanionService').clearCompanion(session));
    attempt(() => invoke('GameServer/Bot/BotAI').stop(session));
    attempt(() => actor.attack?.abortCast?.(session, actor));
    try { actor.destructor(); }
    catch (error) {
        errors.push(error);
        attempt(() => actor.attack.destructor());
        attempt(() => actor.automation.destructor(actor));
    }
    attempt(() => actor.setIsOnline(false));
    attempt(() => invoke('GameServer/World/World').removeUser(session));
    attempt(() => session.dataSendToOthers(invoke('GameServer/Network/Response').deleteOb(actor.fetchId()), actor));
    const Manager = invoke('GameServer/Bot/BotManager');
    Manager.sessions = Manager.sessions.filter(candidate => candidate !== session);
    session.actor = null;
    if (errors.length) {
        const error = new AggregateError(errors, 'Temporary squad actor cleanup was incomplete');
        error.fortressCleanupIncomplete = true;
        throw error;
    }
}

async function create(owner, positions) {
    const created = [];
    try {
        for (let index = 0; index < PROFILES.length; index++) {
            if (stopped) throw new Error('Server is shutting down');
            const username = `bot_frd_${randomBytes(4).toString('hex')}`;
            const owned = { ownerId: owner, characterId: null };
            await Database.createFortressSquadAccount(username, randomBytes(24).toString('hex'), owner);
            accounts.set(username, owned);
            const profile = { ...PROFILES[index], ...positions[index], username,
                fortressOwnerId: owner, level: 20, face: randomInt(3),
                // C4 male hair A-E, female A-G; both use face A-C/color A-D.
                hair: randomInt(PROFILES[index].sex === 1 ? 7 : 5), hairColor: randomInt(4),
                plan: 'fortress_wait', fullNewbieBlessing: false, readyOnActivation: true };
            const session = await invoke('GameServer/Bot/BotManager').provisionAndSpawn(profile, index);
            if (!session?.actor) throw new Error('Squad actor was not created');
            created.push(session);
        }
        if (stopped) throw new Error('Server is shutting down');
        state = 'summoned';
        return 'Five defenders are ready. Select each one and use the normal party invitation.';
    } catch (error) {
        // The shared gate stays consumed even when only part of the squad
        // was published. Never replay uncertain provisioning in this process.
        state = 'failed';
        const errors = [error];
        for (const session of created) {
            try { dispose(session); } catch (cleanupError) { errors.push(cleanupError); }
        }
        const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
        for (const owned of accounts.values()) if (owned.characterId) {
            try { await WriteQueue.flushCharacter(owned.characterId); } catch (flushError) { errors.push(flushError); }
        }
        if (errors.length === 1 && !error.fortressCleanupIncomplete) {
            try {
                await Database.cleanupFortressSquadAccounts([...accounts.keys()]);
                accounts.clear();
            } catch (cleanupError) { errors.push(cleanupError); }
        }
        if (errors.length > 1) throw new AggregateError(errors, 'Squad summon failed; incomplete cleanup is retained until restart', { cause: error });
        throw error;
    }
}

module.exports = {
    PROFILES, mayActivate, ownsSession, equip, dispose,
    status: () => state,
    async init() {
        await Database.cleanupFortressSquadAccounts();
        state = 'unused';
    },
    summon(session) {
        if (state !== 'unused' || stopped) return Promise.resolve('The shared squad summon has already been used or is unavailable until server restart.');
        state = 'summoning';
        let positions;
        try {
            const Geo = invoke('GameServer/Geodata/GeodataEngine');
            positions = Layout.SQUAD_POSITIONS.map(point => {
                const locZ = Geo.getHeight(point.locX, point.locY, point.locZ);
                if (!Geo.hasGeo(point.locX, point.locY) || Math.abs(locZ - point.locZ) > 64) throw new Error('Squad waiting positions require valid fortress geodata. No defenders were created.');
                return { ...point, locZ };
            });
            for (const profile of PROFILES) Loadouts.kit(profile.classId, profile.choice, { equipped: true, consumables: true });
        } catch (error) {
            state = 'unused';
            return Promise.reject(error);
        }
        inFlight = create(Number(session.actor.fetchId()), positions);
        return inFlight;
    },
    async stop() {
        stopped = true;
        if (inFlight) await inFlight.catch(error => utils.infoWarn('Fortress', 'squad shutdown: %s', error.message));
        const errors = [];
        for (const session of [...invoke('GameServer/Bot/BotManager').sessions]) if (ownsSession(session)) {
            try { dispose(session); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Squad shutdown was incomplete');
    }
};
