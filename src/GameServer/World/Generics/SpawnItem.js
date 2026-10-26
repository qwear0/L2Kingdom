const GroundItemVisibility = require('../GroundItemVisibility');
const Item           = invoke('GameServer/Item/Item');
const DataCache      = invoke('GameServer/DataCache');

function spawnItem(session, selfId, amount, coords, onSpawn) {
    DataCache.fetchItemFromSelfId(selfId, (itemDetails) => {
        const item = new Item(this.items.nextId++, { ...utils.crushOb(itemDetails), ...coords });
        item.setAmount(amount);
        this.items.spawns.push(item);
        GroundItemVisibility.publish(this, session, item);
        onSpawn?.(item);
    });
}

module.exports = spawnItem;
