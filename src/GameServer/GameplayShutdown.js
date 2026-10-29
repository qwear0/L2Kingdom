'use strict';

const Lifecycle = require('./GameplayLifecycle');
const QUIESCE_MS = 10000;
const SLICE_MS = 8;
const ASYNC_HOLDS = new Set([
    'vassal_admission', 'vassal_operation', 'vassal_publication', 'multisell',
    'inference', 'pvp_handoff', 'skill_training', 'craft', 'economy_commit',
    'inventory_award', 'quest_publication', 'pickup_award'
]);
const silentSession = { dataSendToMe() {}, dataSendToMeAndOthers() {} };

function roster() {
    return [...new Set([
        ...(invoke('GameServer/World/World').user?.sessions || []),
        ...invoke('GameServer/Bot/BotManager').sessions
    ])];
}

async function freeze({ stopWorld = false } = {}) {
    const World = invoke('GameServer/World/World');
    const Effects = invoke('GameServer/Effects/EffectTicker');
    const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
    let sliceAt = performance.now();
    const checkpoint = async () => {
        if (performance.now() - sliceAt < SLICE_MS) return;
        await new Promise(resolve => setImmediate(resolve));
        sliceAt = performance.now();
    };
    clearInterval(World.npcAggroTicker);
    World.npcAggroTicker = null;
    invoke('GameServer/World/DayNightSpawnManager').stop(World);
    invoke('GameServer/World/RaidBossMinionManager').stop(World);
    invoke('GameServer/World/Generics/NpcDecay').dispose(World);
    clearTimeout(World.npc?.placementRetryTimer);
    for (const entry of World.npc?.raidBossRespawnTimers?.values() || []) clearTimeout(entry.timer);
    World.npc?.raidBossRespawnTimers?.clear();

    const sessions = roster();
    for (const session of sessions) {
        const actor = session.actor;
        if (!actor) continue;
        if (session.botSession || String(session.accountId || '').startsWith('bot_'))
            invoke('GameServer/Bot/BotAI').stop(session);
        // Recall casts are interruptible; accepted teleports retain their own
        // arrival/publication tail. Do not retire actors or invalidate that hop.
        session.townEscape = undefined;
        invoke('GameServer/Bot/AI/BotSpotTravel').cancel(session, actor, 'shutdown');
        invoke('GameServer/Bot/AI/PartyCompanionService').cancelGroundPickup(session);
        actor.quiesce();
        actor.state.setCasts(false);
        actor.state.setHits(false);
        Effects.clearAll(actor);
        Restrictions.stopFear(actor);
        clearTimeout(session.pvpFlagTimer);
        session.pvpFlagTimer = undefined;
        await checkpoint();
    }
    const npcs = stopWorld ? World.npc?.spawns || [] : new Set(sessions.flatMap(session =>
        [session.actor?.summon, session.actor?.pet].filter(Boolean)));
    for (const npc of npcs) {
        Restrictions.stopFear(npc);
        npc.destructor?.(silentSession);
        await checkpoint();
    }
    return sessions;
}

function pendingReasons(session) {
    const actor = session.actor;
    if (!actor) return [];
    const reasons = invoke('GameServer/Bot/Control/Authority').busy(session)
        .filter(reason => ASYNC_HOLDS.has(reason));
    for (const [name, held] of [
        ['fishing_mutation', actor.fishingMutation],
        ['shopping_operation', session.pendingShoppingMeeting || session.shoppingOperation],
        ['world_entry', session.enterWorldReady],
        ['buff_service', session.buffServiceCasting || session.buffServicePending]
    ]) if (held) reasons.push(name);
    for (const summon of new Set([actor.summon, actor.pet].filter(Boolean))) {
        if (summon.inventoryPending || summon.evolving) reasons.push('pet_mutation');
    }
    if (session.journey?.paymentUncertain) throw Error(`shutdown_uncertain_journey:${actor.fetchId()}`);
    return reasons;
}

async function settle(sessions) {
    // Check each actor once, then poll only actors retaining an async owner.
    // Idle vassals must not cause a repeated full-roster/world scan.
    let waiting = sessions.filter(session => pendingReasons(session).length);
    while (waiting.length || Lifecycle.pending) {
        await Lifecycle.drain();
        waiting = waiting.filter(session => pendingReasons(session).length);
        if (waiting.length) await new Promise(resolve => setTimeout(resolve, 25));
    }
}

async function quiesce() {
    let timeout;
    const work = (async () => {
        const Authority = invoke('GameServer/Bot/Control/Authority');
        Authority.shutdown();
        invoke('GameServer/ClanHall/Runtime').stop();
        invoke('GameServer/AfkTrade/AfkTradeService').shutdown();
        invoke('GameServer/World/ArenaDuelService').release(null, 'shutdown');
        await invoke('GameServer/AfkTrade/TradeMeetingService').shutdown();
        // Finish admitted login/selection/packet handlers before fixing the
        // roster; sockets are paused and cannot admit replacements now.
        await Lifecycle.drain();
        const sessions = await freeze({ stopWorld: true });
        await Promise.all([settle(sessions), Authority.drainShutdown()]);
        // Accepted async publications can restore effects/regeneration or add
        // an actor. Cancel those newly installed timers before final capture.
        const finalSessions = await freeze();
        await settle(finalSessions);
        for (const session of finalSessions) {
            const actor = session.actor;
            if (!actor) continue;
            for (const pet of new Set([actor.pet, actor.summon].filter(pet => pet?.petData?.version === 1))) {
                await pet.inventoryTail;
                await invoke('GameServer/Pets/PetRuntime').persist(pet, actor);
            }
        }
        await Lifecycle.drain();
    })();
    try {
        await Promise.race([work, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(Error('gameplay_quiescence_timeout')), QUIESCE_MS);
        })]);
    } finally { clearTimeout(timeout); }
}

async function persistPlayers() {
    const World = invoke('GameServer/World/World');
    const Writes = invoke('GameServer/Persistence/CharacterWriteQueue');
    const Status = invoke('GameServer/Actor/CharacterStatus');
    const Database = invoke('Database');
    const bots = new Set(invoke('GameServer/Bot/BotManager').sessions);
    const errors = [];
    let sliceAt = performance.now();
    for (const session of [...(World.user?.sessions || [])]) {
        const actor = session.actor;
        if (!actor || !session.socket || session.botSession || bots.has(session)
            || String(session.accountId || '').startsWith('bot_')
            || session.persistenceMode === 'ephemeral' || session.arenaEphemeral
            || actor.fetchIsOnline() !== true) continue;
        const id = actor.fetchId();
        const current = () => session.actor === actor && World.registeredActorById(id)?.session === session;
        try {
            await Writes.flushCharacter(id);
            if (!current()) throw Error('shutdown_player_actor_changed');
            // Unlike the best-effort disconnect helper, this write must reject
            // shutdown on failure. Capture and admit without an intervening yield.
            await Database.updateCharacterStatus(id, Status.persistenceRecord(actor));
        } catch (error) { errors.push(new Error(`final_player_status_failed:${id}:${error.message}`, { cause: error })); }
        if (performance.now() - sliceAt >= SLICE_MS) {
            await new Promise(resolve => setImmediate(resolve));
            sliceAt = performance.now();
        }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
}

module.exports = { quiesce, persistPlayers };
