const GroundItemVisibility = require('../GroundItemVisibility');
const ConsoleText = invoke('GameServer/ConsoleText');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const Purchase = invoke('GameServer/World/Generics/PurchaseItem');
const Capacity = invoke('GameServer/Inventory/PickupCapacity');
let pendingPickup = Promise.resolve();

function pickupItem(session, actor, item, { canContinue = () => true } = {}) {
    // Serialize allocation/turn decisions as well as backpack mutations. Random
    // selection happens once; rejection cannot consume the ground or turn.
    session.nativePickupPending = Number(session.nativePickupPending || 0) + 1;
    const pending = pendingPickup.then(() => claim.call(this, session, actor, item, canContinue))
        .finally(() => { session.nativePickupPending--; });
    pendingPickup = pending.catch(() => {});
    return pending.catch(error => {
        utils.infoWarn('GameServer', 'Pickup award failed actor=%s item=%s error=%s',
            actor?.fetchId?.(), item?.fetchId?.(), error?.message || String(error));
        return { status: 'award_failed' };
    });
}

async function claim(session, actor, item, canContinue) {
    const eligible = () => session?.actor === actor && actor?.backpack && !actor.isDead?.()
        && actor.fetchIsOnline?.() !== false && canContinue() && PartyCompanionService.canPickupLoot(session);
    if (!eligible()) return { status: 'ineligible' };
    const canonical = require('../GroundItemIndex').find(this, item?.fetchId?.());
    if (canonical !== item) return { status: 'missing' };
    if (!canonical) return { status: 'missing' };
    const selfId = canonical.fetchSelfId(), amount = canonical.fetchAmount();
    if (!Number.isSafeInteger(amount) || amount <= 0) return { status: 'rejected', reason: 'amount' };
    const leader = PartyCompanionService.groundLootLeader(session);
    const reservation = {};
    const allocations = selfId === 57 ? PartyCompanionService.adenaAllocations(session, amount, canonical)
        : [{ session: PartyCompanionService.resolveLootSession(session, selfId, canonical, { reservation }), amount }];
    const recipients = allocations.map(entry => ({ ...entry, actor: entry.session?.actor }));
    if (!recipients.length || recipients.some(entry => !entry.actor?.backpack)) return { status: 'ineligible' };
    return Purchase.serialize(recipients.map(entry => entry.actor), async () => {
        if (!eligible() || recipients.some(entry => entry.session.actor !== entry.actor
            || entry.actor.isDead?.() || entry.actor.fetchIsOnline?.() === false)) return { status: 'ineligible' };
        if (PartyCompanionService.groundLootLeader(session) !== leader) return { status: 'ineligible' };
        const members = PartyCompanionService.lootMembersForLeader(leader, canonical);
        if (recipients.some(entry => !members.includes(entry.session))) return { status: 'ineligible' };
        const index = this.items.spawns.indexOf(canonical);
        if (index < 0) return { status: 'missing' };
        for (const entry of recipients) {
            const admission = Capacity.admit(entry.actor, selfId, entry.amount);
            if (admission.status !== 'admitted') return { ...admission, recipientId: entry.actor.fetchId() };
        }
        this.items.spawns.splice(index, 1);
        require('../GroundItemIndex').remove(this, canonical);
        GroundItemVisibility.remove(session, canonical);
        if (session.mcpObservation) session.mcpObservation.emit('drop_claimed', 'native_pickup_claim', { objectId: canonical.fetchId(), templateId: selfId, amount });
        reservation.commit?.();
        const results = [];
        // This is not a multi-recipient database transaction. Keep partial
        // failure visible; never respawn/retry an already claimed allocation.
        for (const entry of recipients) {
            results.push(await Purchase.awardItem(entry.session, entry.actor, selfId, entry.amount, {
                enchant: canonical.fetchEnchantLevel?.() ?? 0,
                ...(canonical.fetchPetData?.() ? { petData: canonical.fetchPetData() } : {})
            }));
        }
        try {
            recipients.forEach((entry, i) => {
                if (results[i].status === 'awarded' && entry.session.actor === entry.actor) {
                    ConsoleText.transmitPickup(entry.session, selfId, entry.amount);
                }
            });
        } catch (error) {
            utils.infoWarn('GameServer', 'Pickup presentation failed item=%s error=%s', selfId, error?.message || String(error));
        }
        return { status: results.every(result => result.status === 'awarded') ? 'awarded' : 'award_failed', results };
    });
}

module.exports = pickupItem;
