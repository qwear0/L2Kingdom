const Response = invoke('GameServer/Network/Response');
const { GROUND_ITEM_ID_START } = require('./WorldConstants');
const viewersByItem = new WeakMap();

function isViewer(session) {
    return session?.actor?.fetchIsOnline?.() === true && !session.botSession
        && !String(session.accountId || '').startsWith('bot_')
        && typeof session.dataSendToMe === 'function';
}

function publish(world, sourceSession, item) {
    if (sourceSession?.populationStaging) return;
    const id = item.fetchId();
    const packet = Response.spawnItem(item);
    const recipients = new Set([sourceSession, ...world.fetchVisibleRealPlayers(sourceSession, item)]);
    let viewers = viewersByItem.get(item);
    for (const session of recipients) {
        if (!isViewer(session)) continue;
        if (!viewers) viewersByItem.set(item, viewers = []);
        // An uncollected drop must not keep a disconnected character/session
        // alive. Actor identity also fences a connection's next character.
        viewers.push(new WeakRef(session.actor));
        try {
            session.dataSendToMe(packet);
        } catch (error) {
            utils.infoWarn('GroundItemVisibility', 'failed to show item=%s actor=%s error=%s',
                id, session.actor.fetchId(), error?.message || String(error));
        }
    }
}

function hide(session, id, rejectAction = false) {
    try {
        session.dataSendToMe(Response.deleteOb(id));
        if (rejectAction) session.dataSendToMe(Response.actionFailed());
    } catch (error) {
        utils.infoWarn('GroundItemVisibility', 'failed to hide item=%s actor=%s error=%s',
            id, session.actor.fetchId(), error?.message || String(error));
    }
}

function remove(sourceSession, item) {
    const id = item.fetchId();
    const viewers = viewersByItem.get(item);
    viewersByItem.delete(item);
    if (isViewer(sourceSession)) hide(sourceSession, id);
    if (!viewers) return;
    // Only actual observers matter, even after moving away. Do not scan world
    // sessions: unobserved bot drops should have constant removal overhead.
    for (const reference of viewers) {
        const actor = reference.deref();
        const session = actor?.session;
        if (session !== sourceSession && session?.actor === actor && isViewer(session)) {
            hide(session, id);
        }
    }
}

function removeMissing(world, session, id) {
    if (!isViewer(session) || !Number.isSafeInteger(id)
        || id < GROUND_ITEM_ID_START || id >= world.items.nextId
        || require('./GroundItemIndex').find(world, id)) return false;
    // Only issued, absent ground IDs qualify. This also handles a stale click
    // after a successful send: socket delivery is not a client acknowledgement.
    hide(session, id, true);
    return true;
}

module.exports = { publish, remove, removeMissing };
