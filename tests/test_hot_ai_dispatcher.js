'use strict';
process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.

const assert = require('assert');

require('../src/Global');

const Dispatcher = invoke('GameServer/Bot/AI/HotAiDispatcher');
const BotAI = invoke('GameServer/Bot/BotAI');

function wait(ms = 10) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    Dispatcher.resetForTest();
    const order = [];
    const finished = new Promise((resolve) => {
        for (let id = 0; id < 40; id += 1) {
            Dispatcher.enqueue({}, () => {
                order.push(id);
                if (id === 0) setTimeout(() => order.push('player-timer'), 0);
                if (id === 39) resolve();
            });
        }
    });
    assert.deepStrictEqual(order, [], 'enqueue must enter asynchronously');
    await finished;
    const beforeTimer = order.indexOf('player-timer');
    assert(beforeTimer > 0 && beforeTimer <= 16, 'dispatcher must yield before an over-cap queue is exhausted');
    assert.deepStrictEqual(order.filter(Number.isInteger), Array.from({ length: 40 }, (_, id) => id), 'normal lane must stay FIFO');
    assert(Dispatcher.snapshot().batches >= 3);
    assert(Dispatcher.snapshot().yields >= 2);

    Dispatcher.resetForTest();
    let duplicateRuns = 0;
    const duplicate = {};
    assert.strictEqual(Dispatcher.enqueue(duplicate, () => { duplicateRuns += 1; }), true);
    assert.strictEqual(Dispatcher.enqueue(duplicate, () => { duplicateRuns += 100; }, { urgent: true }), false);
    await wait(10);
    assert.strictEqual(duplicateRuns, 1, 'duplicate wakeups for one actor must coalesce');
    assert.strictEqual(Dispatcher.snapshot().coalesced, 1);

    Dispatcher.resetForTest();
    const canceled = {};
    Dispatcher.enqueue(canceled, () => assert.fail('canceled actor must not run'));
    assert.strictEqual(Dispatcher.cancel(canceled), true);
    await wait(10);
    assert.strictEqual(Dispatcher.snapshot().completed, 0);

    Dispatcher.resetForTest();
    const priority = [];
    const promoted = {};
    Dispatcher.enqueue({}, () => priority.push('normal-1'));
    Dispatcher.enqueue(promoted, () => priority.push('promoted'));
    Dispatcher.enqueue({}, () => priority.push('normal-2'));
    Dispatcher.enqueue(promoted, () => assert.fail('promotion must retain the original task'), { urgent: true });
    Dispatcher.enqueue({}, () => priority.push('urgent'), { urgent: true });
    await wait(20);
    assert.deepStrictEqual(priority, ['promoted', 'urgent', 'normal-1', 'normal-2']);
    assert.strictEqual(Dispatcher.snapshot().started, 4, 'stale promotion copies must not execute');

    Dispatcher.resetForTest();
    const { performance } = require('perf_hooks');
    const clockDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
    let clock = 0;
    // Advancing the clock on reads makes tombstone-budget checks deterministic,
    // without asserting exact wall-clock timing on a loaded machine.
    Object.defineProperty(performance, 'now', { configurable: true, value: () => (clock += 0.25) });
    try {
        for (let index = 0; index < 1100; index += 1) {
            const key = {};
            Dispatcher.enqueue(key, () => assert.fail('canceled queue copies must not execute'));
            Dispatcher.cancel(key);
        }
        const staleOrder = [];
        const key = {};
        Dispatcher.enqueue(key, () => {
            staleOrder.push('urgent');
            setTimeout(() => staleOrder.push('timer'), 0);
        });
        Dispatcher.enqueue(key, () => {}, { urgent: true });
        await new Promise((resolve) => Dispatcher.enqueue({}, () => { staleOrder.push('tail'); resolve(); }));
        assert.deepStrictEqual(staleOrder, ['urgent', 'timer', 'tail'], 'stale traversal must also yield to timers');
        assert(Dispatcher.snapshot().batches > 2, 'canceled entries must consume slice time');
        assert.strictEqual(Dispatcher.snapshot().depth, 0);
        assert.strictEqual(Dispatcher.snapshot().started, 2);

        Dispatcher.resetForTest();
        const slowOrder = [];
        Dispatcher.enqueue({}, () => {
            slowOrder.push('slow');
            clock += 10;
            setTimeout(() => slowOrder.push('timer'), 0);
        });
        await new Promise((resolve) => Dispatcher.enqueue({}, () => { slowOrder.push('next'); resolve(); }));
        assert.deepStrictEqual(slowOrder, ['slow', 'timer', 'next'], 'a slow task must end its batch');
    } finally {
        if (clockDescriptor) Object.defineProperty(performance, 'now', clockDescriptor);
        else delete performance.now;
        Dispatcher.resetForTest();
    }

    const failures = [];
    const originalError = console.error;
    console.error = (...args) => failures.push(args);
    const recovered = [];
    try {
        Dispatcher.enqueue({}, () => {
            Dispatcher.enqueue({}, () => recovered.push('enqueued-in-task'));
            throw new Error('task failure');
        }, { onError: () => { throw new Error('handler failure'); } });
        Dispatcher.enqueue({}, () => recovered.push('remaining'));
        await wait(20);
        assert.deepStrictEqual(recovered, ['remaining', 'enqueued-in-task']);
        assert.strictEqual(failures.length, 1, 'error-handler failure must be reported');
        assert.strictEqual(Dispatcher.snapshot().errors, 1);
        assert.strictEqual(Dispatcher.snapshot().started, 3);
        assert.strictEqual(Dispatcher.snapshot().completed, 2);
        Dispatcher.enqueue({}, () => recovered.push('later'));
        await wait(20);
        assert.strictEqual(recovered.at(-1), 'later', 'failure must clear draining state and permit later work');
    } finally {
        console.error = originalError;
        Dispatcher.resetForTest();
    }

    const originalTick = BotAI.tick;
    const originalDelay = BotAI.calculateNextTickDelay;
    let ticks = 0;
    const session = { actor: {}, aiActive: true };
    const normalSession = { actor: {}, aiActive: true };
    try {
        BotAI.tick = () => { ticks += 1; };
        BotAI.calculateNextTickDelay = () => 60000;
        BotAI.wakeup(session, { urgent: true });
        assert.strictEqual(ticks, 0, 'urgent wakeup must never execute AI inside the caller/network stack');
        await wait(20);
        assert.strictEqual(ticks, 1, 'urgent wakeup must execute on the cooperative dispatcher');
        assert.strictEqual(Dispatcher.snapshot().urgent, 1);
        BotAI.stop(session);

        Dispatcher.resetForTest();
        ticks = 0;
        BotAI.wakeup(normalSession);
        await wait(20);
        assert.strictEqual(ticks, 1, 'normal wakeup must execute on the cooperative dispatcher');
        assert.strictEqual(Dispatcher.snapshot().urgent, 0, 'normal wakeup must preserve the fairness lane');
    } finally {
        BotAI.stop(session);
        BotAI.stop(normalSession);
        BotAI.tick = originalTick;
        BotAI.calculateNextTickDelay = originalDelay;
        Dispatcher.resetForTest();
    }

    console.log('Hot AI cooperative dispatcher checks passed');
}

const deadline = setTimeout(() => {
    console.error('Hot AI dispatcher check timed out with unfinished work');
    process.exitCode = 1;
}, 10000);
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => clearTimeout(deadline));
