'use strict';

const { NPC_GRID_SIZE } = require('./WorldConstants');
const { steps } = require('./BoundedCellQuery');
const indexes = new WeakMap();
function reset(world) { indexes.set(world.items, { byId: new Map(), cells: new Map(), keys: new WeakMap() }); }
function add(world, item) {
    const index = indexes.get(world.items);
    if (!index) throw new Error('ground_index_uninitialized');
    const key = `${Math.floor(item.fetchLocX() / NPC_GRID_SIZE)}_${Math.floor(item.fetchLocY() / NPC_GRID_SIZE)}`;
    index.byId.set(item.fetchId(), item); index.keys.set(item, key);
    if (!index.cells.has(key)) index.cells.set(key, new Set());
    index.cells.get(key).add(item);
}
function remove(world, item) {
    const index = indexes.get(world.items);
    if (!index || index.byId.get(item.fetchId()) !== item) return;
    index.byId.delete(item.fetchId());
    const key = index.keys.get(item), cell = index.cells.get(key);
    cell?.delete(item); if (!cell?.size) index.cells.delete(key);
    index.keys.delete(item);
}
function find(world, id) {
    const index = indexes.get(world.items);
    return index ? index.byId.get(id) || null : (world.items?.spawns || []).find(item => item.fetchId() === id) || null;
}
function near(world, point, radius) {
    const index = indexes.get(world.items);
    if (!index) throw new Error('ground_index_uninitialized');
    return steps(point, radius, NPC_GRID_SIZE, key => index.cells.get(key));
}
module.exports = { reset, add, remove, find, near };
