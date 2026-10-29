'use strict';

const { randomUUID } = require('crypto');

// Capture scalar control state and exact runtime identities, not positions/vitals.
// Observation catches native/async changes; consumption also fences no-op replays.
function observe(owner, key, values) {
    let state = owner[key];
    if (!state || state.values.length !== values.length || values.some((value, index) => !Object.is(value, state.values[index]))) {
        state = owner[key] = { values, version: randomUUID() };
    }
    return state.version;
}
function consume(owner, key) {
    owner[key].version = randomUUID();
    return owner[key].version;
}
module.exports = { observe, consume };
