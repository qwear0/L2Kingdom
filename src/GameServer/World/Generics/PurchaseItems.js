const DataCache = invoke('GameServer/DataCache');
const ServerResponse = invoke('GameServer/Network/Response');

function purchaseItems(session, items, purchaseOptions = {}) {
    // 1. Calculate total cost
    let totalCost = 0;
    if (!purchaseOptions.free) {
        for (const item of items) {
            let price = 0;
            if (purchaseOptions.prices && purchaseOptions.prices.has(item.selfId)) {
                price = purchaseOptions.prices.get(item.selfId);
            } else {
                DataCache.fetchItemFromSelfId(item.selfId, (itemDetails) => {
                    price = itemDetails.template.price ?? 0;
                });
            }
            totalCost += price * item.amount;
        }
    }

    const actor = session.actor;
    const backpack = actor.backpack;
    const totalAdena = backpack.fetchTotalAdena();

    if (totalCost > 0 && totalAdena < totalCost) {
        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: `You do not have enough Adena. Required: ${totalCost}, available: ${totalAdena}` }));
        return;
    }

    if (purchaseOptions.operation) return trackedPurchase.call(this, session, items, totalCost, purchaseOptions.operation);

    // Deduct Adena if needed
    if (totalCost > 0) {
        const adenaItem = backpack.fetchItemFromSelfId(57);
        if (adenaItem) {
            backpack.deleteItem(session, adenaItem.fetchId(), totalCost, () => {
                let timer = 0;
                items.forEach((item) => {
                    setTimeout(() => {
                        this.purchaseItem(session, item.selfId, item.amount);
                    }, timer += 100);
                });
            });
        } else {
            session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "You do not have any Adena." }));
        }
    } else {
        // Free / Admin / 0 cost purchase
        let timer = 0;
        items.forEach((item) => {
            setTimeout(() => {
                this.purchaseItem(session, item.selfId, item.amount);
            }, timer += 100);
        });
    }
}

// The tracked ingress is one selected line. A debit owns its delayed grant:
// losing authority after payment cannot discard that required settlement.
function trackedPurchase(session, items, cost, operation) {
    if (items.length !== 1) throw Error('tracked_purchase_requires_one_line');
    operation.check();
    const actor = session.actor, backpack = actor.backpack;
    return new Promise((resolve, reject) => {
        let dispatched = false;
        const grant = () => {
            dispatched = true;
            operation.applied({ paidAdena: cost }, 'live_applied_persistence_queued');
            setTimeout(() => {
                if (session.actor !== actor) { operation.uncertain('purchase_actor_changed_after_debit'); resolve(); return; }
                Promise.resolve(this.purchaseItem(session, items[0].selfId, items[0].amount)).then(result => {
                    if (result.status !== 'awarded') operation.uncertain('purchase_award_uncertain');
                    else operation.complete({ paidAdena: cost, itemId: items[0].selfId, amount: items[0].amount,
                        presentationFailed: !!result.presentationFailed }, 'purchased', 'live_applied_persistence_queued');
                    resolve();
                }).catch(reject);
            }, 100);
        };
        operation.begin();
        if (cost > 0) {
            const adena = backpack.fetchItemFromSelfId(57);
            if (!adena || adena.fetchPetLocked?.() || adena.fetchAmount() < cost) { operation.rolledBack(); resolve(); return; }
            backpack.deleteItem(session, adena.fetchId(), cost, grant);
            if (!dispatched) { operation.rolledBack(); resolve(); }
        } else grant();
    });
}
module.exports = purchaseItems;
