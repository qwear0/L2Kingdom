const Limits = invoke('GameServer/Inventory/InventoryLimits');
const DataCache = invoke('GameServer/DataCache');

function full(actor) {
    return actor.backpack.fetchItems().length >= Limits.forActor(actor)
        || actor.backpack.fetchTotalLoad() >= actor.fetchMaxLoad();
}

// Called inside PurchaseItem's recipient locks, after all preceding native
// awards have updated live inventory. A rejected drop keeps its allocation.
function admit(actor, selfId, amount) {
    let definition;
    DataCache.fetchItemFromSelfId(selfId, item => { definition = item; });
    if (!definition) return { status: 'rejected', reason: 'unknown_item' };
    const items = actor.backpack.fetchItems();
    const stack = items.find(item => item.fetchSelfId() === selfId && item.fetchStackable());
    if (!stack && items.length >= Limits.forActor(actor)) return { status: 'capacity', reason: 'slots' };
    const mass = Number(definition.template?.mass ?? 0);
    if (!Number.isFinite(mass) || mass < 0) return { status: 'rejected', reason: 'unknown_weight' };
    const maxLoad = Number(actor.fetchMaxLoad());
    if (!Number.isFinite(maxLoad) || maxLoad <= 0) return { status: 'rejected', reason: 'unknown_load_limit' };
    if (actor.backpack.fetchTotalLoad() + mass * amount > maxLoad) {
        return { status: 'capacity', reason: 'weight' };
    }
    return { status: 'admitted' };
}

module.exports = { full, admit };
