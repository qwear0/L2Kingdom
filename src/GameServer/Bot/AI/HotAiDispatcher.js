'use strict';
const DiagnosticConfig = require('../Population/PopulationConfig');

const { performance } = require('perf_hooks');

const SAMPLE_LIMIT = 1024;
const BATCH_TASK_LIMIT = 16;
const BATCH_BUDGET_MS = 2;
const COMPACT_LIMIT = 1024;
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);
const urgentQueue = { entries: [], head: 0 };
const normalQueue = { entries: [], head: 0 };
const pending = new Map();
const waitSamples = [];
const runSamples = [];
let drainTimer = null;
let draining = false;

const counters = {
    enqueued: 0,
    started: 0,
    completed: 0,
    coalesced: 0,
    canceled: 0,
    errors: 0,
    urgent: 0,
    yields: 0,
    batches: 0,
    maxDepth: 0
};

function sample(target, value) {
    target.push(Math.max(0, Number(value) || 0));
    if (target.length > SAMPLE_LIMIT) target.shift();
}

function percentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
}

function compact(queue) {
    if (pending.size === 0 || queue.head === queue.entries.length) {
        queue.entries.length = 0;
        queue.head = 0;
    } else if (queue.head >= COMPACT_LIMIT && queue.entries.length - queue.head <= COMPACT_LIMIT) {
        // Copy at most a bounded tail, not the entire backlog on every turn.
        queue.entries = queue.entries.slice(queue.head);
        queue.head = 0;
    }
}

function nextEntry(deadline) {
    // Canceled entries and the normal copies of promoted entries consume the
    // same time budget as live work, otherwise a tombstone backlog can stall IO.
    while (performance.now() < deadline) {
        const queue = urgentQueue.head < urgentQueue.entries.length ? urgentQueue : normalQueue;
        if (queue.head === queue.entries.length) return null;
        const entry = queue.entries[queue.head++];
        if (!entry.canceled && pending.get(entry.key) === entry) return entry;
    }
    return null;
}

function scheduleDrain() {
    if (draining || drainTimer || pending.size === 0) return;
    // Real-player timers get a macrotask boundary between bounded AI batches,
    // not necessarily between actors. A single synchronous task cannot be preempted.
    drainTimer = setTimeout(drain, 0);
}

function drain() {
    drainTimer = null;
    draining = true;
    const deadline = performance.now() + BATCH_BUDGET_MS;
    DiagnosticConfig.developerDiagnostics && (counters.batches += 1);
    try {
        for (let executed = 0; executed < BATCH_TASK_LIMIT; executed += 1) {
            const entry = nextEntry(deadline);
            if (!entry) break;
            pending.delete(entry.key);
            const startedAt = DiagnosticConfig.developerDiagnostics ? performance.now() : 0;
            if (DiagnosticConfig.developerDiagnostics) {
                counters.started += 1;
                sample(waitSamples, startedAt - entry.queuedAt);
            }
            try {
                entry.task();
                DiagnosticConfig.developerDiagnostics && (counters.completed += 1);
            } catch (error) {
                DiagnosticConfig.developerDiagnostics && (counters.errors += 1);
                if (typeof entry.onError === 'function') {
                    try {
                        entry.onError(error);
                    } catch (handlerError) {
                        console.error('Hot AI error handler failed:', handlerError, 'Original error:', error);
                    }
                } else console.error('Hot AI dispatch error:', error);
            } finally {
                if (DiagnosticConfig.developerDiagnostics) sample(runSamples, performance.now() - startedAt);
            }
        }
    } finally {
        compact(urgentQueue);
        compact(normalQueue);
        draining = false;
        if (pending.size > 0) {
            DiagnosticConfig.developerDiagnostics && (counters.yields += 1);
            scheduleDrain();
        }
    }
}

function enqueue(key, task, options = {}) {
    if (!key || typeof task !== 'function') return false;
    const existing = pending.get(key);
    if (existing) {
        DiagnosticConfig.developerDiagnostics && (counters.coalesced += 1);
        if (options.urgent === true && !existing.urgent) {
            existing.urgent = true;
            DiagnosticConfig.developerDiagnostics && (counters.urgent += 1);
            urgentQueue.entries.push(existing);
        }
        return false;
    }
    const entry = {
        key,
        task,
        onError: options.onError,
        urgent: options.urgent === true,
        queuedAt: DiagnosticConfig.developerDiagnostics ? performance.now() : null,
        canceled: false
    };
    pending.set(key, entry);
    (entry.urgent ? urgentQueue : normalQueue).entries.push(entry);
    DiagnosticConfig.developerDiagnostics && (counters.enqueued += 1);
    if (entry.urgent) DiagnosticConfig.developerDiagnostics && (counters.urgent += 1);
    DiagnosticConfig.developerDiagnostics && (counters.maxDepth = Math.max(counters.maxDepth, pending.size));
    scheduleDrain();
    return true;
}

function cancel(key) {
    const entry = pending.get(key);
    if (!entry) return false;
    entry.canceled = true;
    pending.delete(key);
    DiagnosticConfig.developerDiagnostics && (counters.canceled += 1);
    return true;
}

function snapshot() {
    if (!DiagnosticConfig.developerDiagnostics) return { enabled: false };
    const measuredAt = performance.now();
    let urgentDepth = 0;
    let oldestUrgentMs = null;
    let oldestNormalMs = null;
    for (const entry of pending.values()) {
        const age = Math.max(0, measuredAt - entry.queuedAt);
        if (entry.urgent) {
            urgentDepth += 1;
            oldestUrgentMs = Math.max(oldestUrgentMs ?? 0, age);
        } else oldestNormalMs = Math.max(oldestNormalMs ?? 0, age);
    }
    return {
        enabled: true,
        processId: process.pid,
        processStartedAt: PROCESS_STARTED_AT,
        ...counters,
        sampleScope: 'latest_started_tasks',
        sampleLimit: SAMPLE_LIMIT,
        waitSamples: waitSamples.length,
        runSamples: runSamples.length,
        depth: pending.size,
        urgentDepth,
        oldestUrgentMs,
        oldestNormalMs,
        waitP95Ms: percentile(waitSamples, 0.95),
        waitMaxMs: waitSamples.length ? Number(Math.max(...waitSamples).toFixed(2)) : 0,
        runP95Ms: percentile(runSamples, 0.95),
        runMaxMs: runSamples.length ? Number(Math.max(...runSamples).toFixed(2)) : 0
    };
}

function resetForTest() {
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = null;
    pending.clear();
    draining = false;
    urgentQueue.entries.length = 0;
    urgentQueue.head = 0;
    normalQueue.entries.length = 0;
    normalQueue.head = 0;
    waitSamples.length = 0;
    runSamples.length = 0;
    Object.keys(counters).forEach((key) => { counters[key] = 0; });
}

module.exports = { enqueue, cancel, snapshot, resetForTest };
