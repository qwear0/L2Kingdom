'use strict';

let stopping = false;
const pending = new Set();
const failures = [];

function track(work) {
    pending.add(work);
    work.then(() => pending.delete(work), error => {
        pending.delete(work);
        if (stopping) failures.push(error);
    });
    return work;
}

async function drain() {
    // A settling callback can admit its own publication tail. Drain to a fixed
    // point, not just the promises present when shutdown first began.
    while (pending.size) await Promise.allSettled([...pending]);
    if (failures.length) throw new AggregateError(failures.splice(0), 'gameplay settlement failed');
}

module.exports = {
    get stopping() { return stopping; },
    begin() { stopping = true; },
    track,
    drain,
    get pending() { return pending.size; }
};
