require('./Global');

const { acquireDatabaseAccess } = require('../scripts/database-access');
const releaseDatabaseAccess = acquireDatabaseAccess(require('path').resolve(
    __dirname, '..', options.default.Database?.path || 'tmp/nodel2.sqlite'
));
process.once('exit', releaseDatabaseAccess);

const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');
LangfuseTracing.init();

// User imports
const AuthSession = invoke('AuthenticationServer/Session');
const GameSession = invoke('GameServer/Session');
const World       = invoke('GameServer/World/World');
const DataCache   = invoke('GameServer/DataCache');
const Database    = invoke('Database');
const Server      = invoke('Server');
const BotManager  = invoke('GameServer/Bot/BotManager');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const DevConsole = invoke('GameServer/DevConsole');
const WorldObserver = invoke('WorldObserver/WorldObserverServer');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const ClanService = invoke('GameServer/Clan/ClanService');
const CharacterWriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const PathfindingWorkerPool = invoke('GameServer/Geodata/PathfindingWorkerPool');

const generation = process.env.L2NODE_MANAGED_GENERATION;
const managed = Boolean(generation && process.send);
const listeners = [];
let startupFailed = false;
function report(message) {
    if (process.send && process.connected) process.send({ ...message, v: 1, generation }, () => {});
}
function exitWithOutcome(outcome) {
    const code = outcome === 'clean' ? 0 : 1;
    const timer = setTimeout(() => process.exit(code), 200);
    if (process.send && process.connected) process.send({ v: 1, generation, type: 'shutdown-result', outcome }, () => { clearTimeout(timer); process.exit(code); });
    else process.exit(code);
}
let shuttingDown = false;
let initialization = Promise.resolve();
require('./WorldObserver/SettingsRuntime').install(() => shuttingDown);
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    utils.infoWarn('DB', 'flushing buffered character state before %s', signal);
    const forceExit = setTimeout(() => exitWithOutcome('timed_out'), 15000);
    let failed = startupFailed;
    const cleanupFailure = step => () => {
        failed = true;
        utils.infoWarn('Shutdown', '%s cleanup reported failure', step);
    };
    for (const listener of listeners) listener.listener.close();
    WorldObserver.server?.close();
    forceExit.unref?.();
    // Each step logs its own failure and the next steps still run, so the
    // database is always closed.
    (async () => {
        // Do not close persistence underneath an awaited bootstrap step. The
        // same shutdown deadline bounds bootstrap and subsequent cleanup.
        await initialization;
        try { await invoke('GameServer/Bot/Population/PopulationService').stop(); }
        catch (error) { failed = true; utils.infoWarn('ColdWorker', 'cold simulation drain failed: %s', error.message); }
        try { await CharacterWriteQueue.flushAll(); }
        catch (error) { failed = true; utils.infoWarn('DB', 'final buffered flush failed: %s', error.message); }
        try { await PathfindingWorkerPool.shutdown({ onCleanupFailure: cleanupFailure('pathfinding') }); }
        catch (error) { failed = true; utils.infoWarn('Pathfinding', 'pathfinding worker shutdown failed: %s', error.message); }
        try { await invoke('GameServer/Clan/ClanPlanningCoordinator').shutdown(); }
        catch (error) { failed = true; utils.infoWarn('ClanPlan', 'clan planning worker shutdown failed: %s', error.message); }
        try { await LangfuseTracing.shutdown({ onCleanupFailure: cleanupFailure('tracing') }); }
        catch (error) { failed = true; utils.infoWarn('Langfuse', 'tracing shutdown failed: %s', error.message); }
        try {
            const result = await invoke('GameServer/Social/InteractionMemoryRuntime').events.drain();
            if (!result.drained) { failed = true; utils.infoWarn('InteractionMemory', 'shutdown left %d unwritten episodes', result.pending); }
        } catch (error) { failed = true; utils.infoWarn('InteractionMemory', 'shutdown drain failed: %s', error.message); }
        try { await Database.close({ onCleanupFailure: cleanupFailure('database/history/checkpoint') }); }
        catch (error) { failed = true; utils.infoWarn('DB', 'graceful SQLite close failed: %s', error.message); }
    })().catch(() => { failed = true; }).finally(() => { clearTimeout(forceExit); exitWithOutcome(failed || startupFailed ? 'failed' : 'clean'); });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('message', (message) => {
    if (message?.v === 1 && message.generation === generation && message.type === 'shutdown') shutdown(message.reason || 'IPC');
});
if (process.send) process.on('disconnect', () => shutdown('owning_ipc_lost'));
function startupFailure(error) {
    startupFailed = true;
    utils.infoWarn('Startup', 'required initialization failed: %s', error.message);
    report({ type: 'startup-failed' });
    shutdown('startup_failed');
}

console.info('\n\
    + ================================== \n\
    # Server Name: ......... NodeL2      \n\
    # Build Revision: ...... %s          \n\
    # Chronicle: ........... C4 [656]    \n\
    # Build date: .......... %s          \n\
    # NodeJS version: ...... %s          \n\
    + ================================== \n\
', utils.buildNumber(), utils.currentDate(), utils.nodeVersion());
console.info(
    'Progress   :: preset %s | exp x%s | sp x%s | adena x%s | drop x%s | spoil x%s',
    ProgressionRates.profile().preset,
    ProgressionRates.profile().exp,
    ProgressionRates.profile().sp,
    ProgressionRates.profile().adena,
    ProgressionRates.profile().drop,
    ProgressionRates.profile().spoil
);

// Startup procedure, init `World` & `Data`, then `AuthServer`, finally `GameServer`
Database.init(() => {
    DataCache.init();
    // Owned-only startup does not start the autonomous clan planner.
    if (!invoke('GameServer/Bot/Population/PopulationConfig').ownedOnly) invoke('GameServer/Clan/ClanPlanningCoordinator').start();
    const stackableItemIds = (DataCache.items || [])
        .filter((item) => item.etc?.stackable === true)
        .map((item) => Number(item.selfId));
    initialization = Database.compactStackableInventory(stackableItemIds, 'compact-stackable-inventory-v3').then((result) => {
        if (!result.skipped && result.rowsRemoved > 0) {
            utils.infoSuccess('DB', 'compacted stackable inventory groups=%d rows=%d', result.groups, result.rowsRemoved);
            return Database.reclaimUnusedSpace();
        }
        return { reclaimed: false, reason: result.skipped ? 'compaction_already_complete' : 'no_rows_removed' };
    }).catch((error) => {
        utils.infoWarn('DB', 'failed to compact or reclaim stackable inventory: %s', error.message);
        return { reclaimed: false, reason: 'maintenance_failed' };
    }).then((result) => {
        if (result.reclaimed) {
            utils.infoSuccess('DB', 'reclaimed unused SQLite space pages=%d bytes=%d', result.freePages, result.reclaimedBytes);
        }
    }).then(() => shuttingDown ? undefined : ClanService.init()).then(async () => {
        if (shuttingDown) return;
        GeodataEngine.init();
        await World.init();
        if (shuttingDown) return;
        await invoke('GameServer/ClanHall/Runtime').start();
        if (shuttingDown) return;
        const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
        await AfkTrade.init();
        if (shuttingDown) return;
        // Every bot's persona before any bot decides (BotPersona.of).
        await invoke('GameServer/Bot/AI/BotPersona').loadAll().then((count) => {
            utils.infoSuccess('BotPersona', 'loaded %d personas', count);
        }).catch((error) => utils.infoWarn('BotPersona', 'persona load failed: %s', error.message));

        invoke('GameServer/Knowledge/RecipeCatalog').warmup();
        invoke('GameServer/World/Generics/NativeKnowledgeBase').warmup();

        if (shuttingDown) return;
        listeners.push(new Server('AuthServer', options.default.AuthServer, socket => new AuthSession(socket)),
            new Server('GameServer', options.default.GameServer, socket => new GameSession(socket)));
        for (const listener of listeners) listener.onListenError = startupFailure;
        await Promise.all(listeners.map(listener => listener.ready));
        await BotManager.init();
        if (shuttingDown) return;
        WorldObserver.onListenError = startupFailure;
        const observer = await WorldObserver.init(managed ? { hostname: '127.0.0.1', port: 0 } : undefined);
        if (shuttingDown) return;
        DevConsole.init();
        report({ type: 'ready', listeners: { auth: true, game: true }, observer: observer ? 'ready' : 'disabled', port: observer?.port });
        if (!invoke('GameServer/Bot/Population/PopulationConfig').ownedOnly && process.env.L2NODE_HOT_LOAD_TEST === '1') {
            invoke('GameServer/Bot/LoadTest/HotBotLoadTest').start();
        }
    }).catch(startupFailure);
});
