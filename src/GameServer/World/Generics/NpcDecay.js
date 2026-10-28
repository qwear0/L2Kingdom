const NpcVisibility = invoke('GameServer/World/NpcVisibility');

const DEFAULT_REAPER_INTERVAL_MS = 1000;
const MAX_SWEEP_FAILURES = 3;
const registries = new WeakMap();

function registryFor(world) {
    const container = world?.npc;
    if (!container?.spawns) return null;
    let registry = registries.get(container);
    if (!registry) {
        // Recover pre-existing deadlines once per NPC container. Steady-state
        // sweeps must visit only registered corpses, never the live world.
        const pending = new Set(container.spawns.filter((npc) => (
            npc?.corpseDecayState !== 'removed' && Number(npc?.corpseDecayAt || 0) > 0
        )));
        registry = { pending, retired: false };
        registries.set(container, registry);
    }
    return registry;
}

function logWarning(message, error) {
    const detail = error?.message || error || 'unknown error';
    if (typeof utils?.infoWarn === 'function') {
        utils.infoWarn('NpcDecay', `${message}: ${detail}`);
    }
}

function clearTimer(npc) {
    if (!npc?.corpseDecayTimer) return;
    clearTimeout(npc.corpseDecayTimer);
    npc.corpseDecayTimer = undefined;
}

function forget(container, npc) {
    registries.get(container)?.pending.delete(npc);
    npc.corpseDecayState = 'removed';
    npc.corpseDecayAt = 0;
    npc.corpseDecaySession = null;
    npc.corpseDecaySweepFailures = 0;
    clearTimer(npc);
}

function numericDelay(delayMs) {
    const value = Number(delayMs);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function schedule(world, sourceSession, npc, delayMs) {
    if (!world?.npc?.spawns || !npc?.fetchId) return false;
    if (npc.corpseDecayState === 'removed') return false;
    const container = world.npc;
    const registry = registryFor(world);
    if (registry.retired) return false;

    clearTimer(npc);
    const delay = numericDelay(delayMs);
    npc.corpseDecayState = 'scheduled';
    npc.corpseDecaySession = sourceSession || null;
    npc.corpseDecayAt = Date.now() + delay;
    npc.corpseDecaySweepFailures = 0;
    registry.pending.add(npc);
    const timer = setTimeout(() => {
        // A queued callback must not act after early removal, rescheduling or
        // world replacement, even when object IDs are reused in the new world.
        if (world.npc !== container || registry.retired || npc.corpseDecayTimer !== timer) return;
        try {
            decay(world, npc);
        }
        catch (error) {
            // Leave the scheduled state intact so the reaper can retry an
            // unexpected failure on the next pass.
            logWarning('timer failed', error);
        }
    }, delay);
    npc.corpseDecayTimer = timer;
    // A corpse timer must never keep a test process or a graceful server
    // shutdown alive on its own. The reaper remains the durable fallback.
    npc.corpseDecayTimer.unref?.();
    return true;
}

function decay(world, npc, sourceSession = npc?.corpseDecaySession) {
    if (!world?.npc?.spawns || !npc?.fetchId) return false;
    if (npc.corpseDecayState === 'removed' || registries.get(world.npc)?.retired) return false;

    let npcId;
    try {
        npcId = npc.fetchId();
    }
    catch (error) {
        logWarning('failed to read NPC id during decay', error);
        return false;
    }
    forget(world.npc, npc);

    // Remove the server object first. Packet delivery is best effort and may
    // fail for a disconnected client; it must not leave a corpse in the grid.
    try {
        if (world.removeNpcFromGrid) world.removeNpcFromGrid(npc);
    }
    catch (error) {
        // Grid maintenance is useful but must not prevent the client deletion
        // packet or strand the corpse in the known-object view.
        logWarning(`grid removal failed for NPC ${npcId}`, error);
    }
    const spawnIndex = world.npc.spawns.indexOf(npc);
    if (spawnIndex >= 0) {
        world.npc.spawns.splice(spawnIndex, 1);
    } else {
        world.npc.spawns = world.npc.spawns.filter((entry) => {
            try {
                return entry?.fetchId?.() !== npcId;
            }
            catch (error) {
                logWarning('failed to read a neighboring NPC id during decay', error);
                return true;
            }
        });
    }
    if (!world.removeNpcFromGrid) {
        try {
            world.indexSpawnsInGrid?.();
        } catch (error) {
            logWarning(`grid rebuild failed for NPC ${npcId}`, error);
        }
    }

    try {
        NpcVisibility.deleteKnownNpc(world, sourceSession, npcId);
    }
    catch (error) {
        logWarning(`failed to notify deletion for NPC ${npcId}`, error);
    }

    return true;
}

function decayMany(world, npcs) {
    if (!world?.npc?.spawns || !Array.isArray(npcs) || npcs.length === 0 || registries.get(world.npc)?.retired) return 0;

    const removed = new Set();
    const notifications = [];
    npcs.forEach((npc) => {
        if (!npc?.fetchId || npc.corpseDecayState === 'removed' || removed.has(npc)) return;
        try {
            const npcId = npc.fetchId();
            removed.add(npc);
            notifications.push({ npcId, sourceSession: npc.corpseDecaySession });
            forget(world.npc, npc);
        }
        catch (error) {
            logWarning('failed to prepare NPC for batch decay', error);
        }
    });
    if (removed.size === 0) return 0;

    if (world.removeNpcFromGrid) {
        removed.forEach((npc) => {
            try {
                world.removeNpcFromGrid(npc);
            } catch (error) {
                logWarning('grid removal failed during batch decay', error);
            }
        });
    }
    world.npc.spawns = world.npc.spawns.filter((entry) => !removed.has(entry));
    if (!world.removeNpcFromGrid) {
        try {
            world.indexSpawnsInGrid?.();
        } catch (error) {
            logWarning('grid rebuild failed during batch decay', error);
        }
    }

    notifications.forEach(({ npcId, sourceSession }) => {
        try {
            NpcVisibility.deleteKnownNpc(world, sourceSession, npcId);
        }
        catch (error) {
            logWarning(`failed to notify deletion for NPC ${npcId}`, error);
        }
    });
    return removed.size;
}

function discardUnremovableNpc(world, npc, attempts) {
    if (!world?.npc?.spawns || !npc) return false;

    const previousLength = world.npc.spawns.length;
    try {
        world.removeNpcFromGrid?.(npc);
    } catch (error) {
        logWarning('grid removal failed while discarding an unremovable NPC', error);
    }
    const index = world.npc.spawns.indexOf(npc);
    if (index >= 0) world.npc.spawns.splice(index, 1);
    if (!world.removeNpcFromGrid) {
        try {
            world.indexSpawnsInGrid?.();
        } catch (error) {
            logWarning('grid rebuild failed while discarding an unremovable NPC', error);
        }
    }
    forget(world.npc, npc);

    logWarning(`discarded unremovable corpse after ${attempts} failed attempts`, 'NPC id unavailable');
    return world.npc.spawns.length < previousLength;
}

function sweepExpired(world, now = Date.now()) {
    const registry = registryFor(world);
    if (!registry || registry.retired) return 0;

    let removed = 0;
    registry.pending.forEach((npc) => {
        let failed = false;
        try {
            if (
                npc?.corpseDecayState !== 'removed' &&
                Number(npc?.corpseDecayAt || 0) > 0 &&
                Number(npc.corpseDecayAt) <= Number(now)
            ) {
                if (decay(world, npc)) removed += 1;
                else failed = true;
            }
        }
        catch (error) {
            // One malformed corpse must not block every later corpse in the
            // same sweep. Keep it scheduled for a future retry.
            logWarning('individual sweep failed', error);
            failed = true;
        }

        if (failed) {
            const attempts = Number(npc?.corpseDecaySweepFailures || 0) + 1;
            npc.corpseDecaySweepFailures = attempts;
            if (attempts >= MAX_SWEEP_FAILURES && discardUnremovableNpc(world, npc, attempts)) {
                removed += 1;
            }
        }
    });
    return removed;
}

function start(world, intervalMs = DEFAULT_REAPER_INTERVAL_MS) {
    stop(world);
    const registry = registryFor(world);
    if (!registry || registry.retired) return null;
    const container = world.npc;

    const interval = Math.max(50, Number(intervalMs) || DEFAULT_REAPER_INTERVAL_MS);
    container.corpseDecayReaper = setInterval(() => {
        if (world.npc !== container || registry.retired) return;
        try {
            sweepExpired(world);
        }
        catch (error) {
            // One malformed NPC must not stop future corpse cleanup.
            logWarning('reaper failed', error);
        }
    }, interval);
    world.npc.corpseDecayReaper.unref?.();
    return world.npc.corpseDecayReaper;
}

function stop(world) {
    if (!world?.npc?.corpseDecayReaper) return;
    clearInterval(world.npc.corpseDecayReaper);
    world.npc.corpseDecayReaper = undefined;
}

// Stop/start on one container retains pending work. Only world retirement
// releases corpse timers and source sessions; late callbacks remain fenced.
function dispose(world) {
    stop(world);
    const registry = registryFor(world);
    if (!registry) return;
    registry.retired = true;
    registry.pending.forEach((npc) => forget(world.npc, npc));
}

module.exports = {
    schedule,
    decay,
    decayMany,
    sweepExpired,
    start,
    stop,
    dispose
};
