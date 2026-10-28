const Catalogue = require('./C4GatekeeperTeleports');
const NpcIndex = require('./NpcObjectIndex');
const Karma = require('../Karma');

function contact(session, { actor = session?.actor, npcObjectId, npcId, npc = null, isCurrent = () => true }) {
    if (!actor || session.actor !== actor || actor.isDead() || !isCurrent()) return 'actor_changed';
    if (actor.state.fetchCasts() || actor.state.fetchHits() || actor.fetchPrivateStoreType?.()
        || session.trade || session.activeTrade || session.activeNegotiation || session.botTrade
        || session.pendingActorTeleport || session.townEscape) return 'actor_busy';
    if (!invoke('GameServer/Effects/EffectRestrictions').canUseBasicAction(actor)) return 'action_restricted';
    const live = NpcIndex.find(invoke('GameServer/World/World'), Number(npcObjectId));
    if (!live || npc && live !== npc || Number(live.fetchSelfId()) !== Number(npcId) || live.isDead()) return 'npc_unavailable';
    const dx = actor.fetchLocX() - live.fetchLocX(), dy = actor.fetchLocY() - live.fetchLocY();
    const dz = actor.fetchLocZ() - live.fetchLocZ();
    if (![dx, dy, dz].every(Number.isFinite) || Math.hypot(dx, dy) > 300 || Math.abs(dz) > 200) return 'out_of_range';
    if (!invoke('GameServer/Geodata/GeodataEngine').hasLineOfSight(
        actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ(), live.fetchLocX(), live.fetchLocY(), live.fetchLocZ())) return 'no_line_of_sight';
    return null;
}

// The caller owns UI/scheduling and latches its leg BEFORE entering here.
// Price/XYZ always come from the native offer; policy caps never authorize an
// alternate price. Inventory mutation is synchronous, not crash-atomic with
// position persistence. A failed/uncertain dispatch must not be paid again.
function teleport(session, options) {
    const actor = options.actor || session.actor;
    const result = { status: 'refused', paidFare: 0 };
    const refuse = reason => Object.assign(result, { reason });
    const refusal = contact(session, { ...options, actor });
    if (refusal) return refuse(refusal);
    const destination = Catalogue.destination(options.npcId, options.destinationId);
    if (!destination) return refuse('offer_unavailable');
    if (options.expected && (options.expected.fee !== destination.price
        || ['locX', 'locY', 'locZ'].some(key => options.expected.landing[key] !== destination[key]))) return refuse('offer_changed');
    if (Karma.closesTowns(actor.fetchKarma?.())) return refuse('karma');
    if (destination.price > (options.remainingFare ?? Infinity)) return refuse('fare_cap');
    const adena = actor.backpack.fetchItemFromSelfId(57);
    const balance = Number(adena?.fetchAmount() || 0);
    if (destination.price > 0 && balance < (options.minimumBalance ?? 0)) return refuse('spending_threshold');
    if (destination.price > balance) return refuse('insufficient_adena');
    if (destination.price > 0 && adena.fetchPetLocked?.()) return refuse('payment_unavailable');
    const dispatch = () => {
        result.paidFare = destination.price;
        options.onPaid?.(destination.price);
        if (session.actor !== actor || actor.isDead() || options.isCurrent && !options.isCurrent()) {
            result.reason = 'actor_changed_after_payment';
            result.status = 'failed';
            return;
        }
        const accepted = invoke('GameServer/Actor/Generics/TeleportTo')(session, actor, destination, {
            onArrival: options.onArrival, onInterrupted: options.onInterrupted, actionOwner: options.actionOwner, urgentWakeup: true
        });
        result.status = accepted ? 'accepted' : 'failed';
        result.reason = accepted ? null : 'dispatch_refused';
        result.sequence = actor.teleportSequence;
        result.destination = destination;
    };
    try {
        if (destination.price > 0) actor.backpack.deleteItem(session, adena.fetchId(), destination.price, dispatch);
        else dispatch();
    } catch (error) {
        // An exception can occur after the in-memory debit but before its
        // callback (e.g. client packet publication). Preserve that uncertainty;
        // do not invent a refund or let the executor retry this payment.
        result.status = 'failed';
        result.reason = 'native_action_error';
        result.error = error;
        result.paymentUncertain = destination.price > 0 && result.paidFare === 0;
    }
    if (result.status === 'refused') result.reason = 'payment_unavailable';
    return result;
}

module.exports = { contact, teleport };
