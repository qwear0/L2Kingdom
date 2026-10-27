const ServerResponse = invoke('GameServer/Network/Response');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const pendingPurchases = new WeakMap();

// Reserve every recipient synchronously. Pickup admission and its awards use
// the same queues as ordinary native grants; no nested purchaseItem calls.
function serialize(actors, operation) {
    const backpacks = [...new Set(actors.map(actor => actor.backpack))];
    const previous = backpacks.map(backpack => pendingPurchases.get(backpack)).filter(Boolean);
    const pending = Promise.all(previous).then(operation);
    const tail = pending.catch(() => {});
    backpacks.forEach(backpack => pendingPurchases.set(backpack, tail));
    tail.then(() => backpacks.forEach(backpack => {
        if (pendingPurchases.get(backpack) === tail) pendingPurchases.delete(backpack);
    }));
    return pending;
}

function purchaseItem(session, selfId, amount, metadata = {}) {
    const actor = session?.actor;
    if (!actor?.backpack) return Promise.resolve({ status: 'rejected', reason: 'missing_actor' });
    return serialize([actor], () => awardItem(session, actor, selfId, amount, metadata));
}

async function awardItem(session, actor, selfId, amount, metadata = {}) {
    const backpack = actor.backpack;
    if (session.actor !== actor || !Number.isSafeInteger(amount) || amount <= 0) {
        return { status: 'rejected', reason: 'stale_actor_or_amount' };
    }
    try {
        const stack = backpack.fetchItems().find(item => item.fetchSelfId() === selfId && item.fetchStackable());
        if (stack) {
            const total = stack.fetchAmount() + amount;
            if (!Number.isSafeInteger(total)) throw new Error('Item amount overflow');
            await Database.updateItemAmount(actor.fetchId(), stack.fetchId(), total);
            backpack.updateAmount(stack.fetchId(), total);
        } else {
            let item;
            DataCache.fetchItemFromSelfId(selfId, definition => { item = definition; });
            if (!item) throw new Error(`Unknown item ${selfId}`);
            const packet = await Database.setItem(actor.fetchId(), {
                selfId: item.selfId, name: item.template.name, amount,
                enchant: metadata.enchant ?? 0, equipped: false, slot: item.etc.slot,
                ...(metadata.petData ? { petData: metadata.petData } : {})
            });
            backpack.insertItem(Number(packet.insertId), selfId, { amount, ...metadata });
        }
    } catch (err) {
        utils.infoWarn('GameServer', 'Item award failed actor=%s item=%s error=%s',
            actor.fetchId(), selfId, err?.message || String(err));
        return { status: 'award_failed', actorId: actor.fetchId(), selfId };
    }
    // A presentation failure after the write is not permission to award twice.
    try {
        if (session.actor === actor) {
            session.dataSendToMe(ServerResponse.userInfo(actor));
            session.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
        }
    } catch (err) {
        utils.infoWarn('GameServer', 'Item award presentation failed actor=%s item=%s error=%s',
            actor.fetchId(), selfId, err?.message || String(err));
        return { status: 'awarded', presentationFailed: true };
    }
    return { status: 'awarded' };
}

module.exports = purchaseItem;
module.exports.serialize = serialize;
module.exports.busy = backpack => pendingPurchases.has(backpack);
module.exports.awardItem = awardItem;
