'use strict';

// Yield work, not an eagerly materialized result. Consumers must charge both
// empty cells and candidates before filtering, sorting or building payloads.
function* steps(point, radius, size, cell, entity = value => value) {
    const minX = Math.floor((point.locX - radius) / size), maxX = Math.floor((point.locX + radius) / size);
    const minY = Math.floor((point.locY - radius) / size), maxY = Math.floor((point.locY + radius) / size);
    if (![minX, maxX, minY, maxY].every(Number.isSafeInteger) || radius < 0 || radius > 6000) throw new RangeError('invalid_bounded_query');
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
        yield { cell: true };
        for (const value of cell(`${x}_${y}`) || []) yield { entity: entity(value) };
    }
}
module.exports = { steps };
