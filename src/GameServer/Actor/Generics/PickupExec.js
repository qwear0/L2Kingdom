const ServerResponse = invoke('GameServer/Network/Response');
const World          = invoke('GameServer/World/World');

function pickupExec(session, actor, data, onComplete, canContinue = () => true) {
    const generation = actor?.automation?.pickupGeneration;
    const isCurrent = () => actor && session?.actor === actor &&
        actor.automation?.pickupGeneration === generation &&
        !actor.isDead?.() && actor.fetchIsOnline?.() !== false && canContinue();
    World.fetchItem(data.id).then((item) => {
        if (!isCurrent()) { onComplete?.({ status: 'ineligible' }); return; }
        if (data.actionOwner && (Math.hypot(actor.fetchLocX() - item.fetchLocX(), actor.fetchLocY() - item.fetchLocY())
            > 36 + Math.max(0, Number(actor.fetchRadius?.()) || 0)
            || !invoke('GameServer/Geodata/GeodataEngine').hasLineOfSight(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ(),
                item.fetchLocX(), item.fetchLocY(), item.fetchLocZ()))) {
            onComplete?.({ status: 'ineligible' });
            return;
        }
        const scheduled = actor.automation.schedulePickup(session, actor, item, () => {
            if (!isCurrent()) { onComplete?.({ status: 'ineligible' }); return; }
            // C4 clears the client's pending Action before the pickup animation.
            session.dataSendToMe(ServerResponse.actionFailed());
            session.dataSendToMeAndOthers(ServerResponse.stopMove(actor.fetchId(), {
                locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ(),
                head: actor.fetchHead()
            }), actor);
            session.dataSendToMeAndOthers(ServerResponse.pickupItem(actor.fetchId(), item), actor);
            // Lisvus awards on arrival; GetItem's client animation does not
            // impose a server-side pickup cooldown.
            World.pickupItem(session, actor, item, { canContinue: isCurrent }).then(result => {
                if (session.actor === actor && result.status !== 'awarded') {
                    session.dataSendToMe(ServerResponse.actionFailed());
                    if (result.status === 'capacity' || result.status === 'award_failed') {
                        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: result.status === 'capacity'
                            ? 'Pickup rejected: a recipient has insufficient inventory capacity.'
                            : 'Pickup award failed. Do not retry a claimed item; check the server log.' }));
                    }
                }
                onComplete?.(result);
            });
        });
        if (scheduled === false) {
            session.dataSendToMe(ServerResponse.actionFailed());
            onComplete?.({ status: 'rejected' });
        }
    }).catch((err) => {
        if (isCurrent()) session.dataSendToMe(ServerResponse.actionFailed());
        utils.infoWarn(
            'GameServer',
            'Pickup failed actor=%s item=%s error=%s',
            actor?.fetchName?.() || actor?.fetchId?.() || 'unknown',
            data?.id || 'unknown',
            err?.message || String(err)
        );
        onComplete?.({ status: 'missing' });
    });
}

module.exports = pickupExec;
