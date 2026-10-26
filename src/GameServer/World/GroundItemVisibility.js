const Response = invoke('GameServer/Network/Response');
const { GROUND_ITEM_ID_START } = require('./WorldConstants');
const viewers = new WeakMap();

function isViewer(session) {
    return session?.actor?.fetchIsOnline?.() === true && !session.botSession
        && !String(session.accountId || '').startsWith('bot_')
        && typeof session.dataSendToMe === 'function';
}

function knownItems(session, create = false) {
    let known = viewers.get(session);
    // A connection can return to character selection and acquire another actor.
    // Its previous character's item knowledge must not cross that boundary.
    if (known?.actor !== session.actor) {
        if (!create) return null;
        known = { actor: session.actor, ids: new Set() };
        viewers.set(session, known);
    }
    return known?.ids;
}

function publish(world, sourceSession, item) {
    if (sourceSession?.populationStaging) return;
    const id = item.fetchId();
    const packet = Response.spawnItem(item);
    const recipients = new Set([sourceSession, ...world.fetchVisibleRealPlayers(sourceSession, item)]);
    for (const session of recipients) {
        if (!isViewer(session)) continue;
        knownItems(session, true).add(id);
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
        knownItems(session)?.delete(id);
        if (rejectAction) session.dataSendToMe(Response.actionFailed());
    } catch (error) {
        utils.infoWarn('GroundItemVisibility', 'failed to hide item=%s actor=%s error=%s',
            id, session.actor.fetchId(), error?.message || String(error));
    }
}

function remove(world, sourceSession, item) {
    const id = item.fetchId();
    // Current proximity cannot find a client that saw the drop before moving
    // away. Delete at claim time, before asynchronous inventory awards yield.
    for (const session of new Set([sourceSession, ...(world.user?.sessions || [])])) {
        if (isViewer(session) && (session === sourceSession || knownItems(session)?.has(id))) {
            hide(session, id);
        }
    }
}

function removeMissing(world, session, id) {
    if (!isViewer(session) || !Number.isSafeInteger(id)
        || id < GROUND_ITEM_ID_START || id >= world.items.nextId
        || world.items.spawns.some(item => item.fetchId() === id)) return false;
    // Only issued, absent ground IDs qualify. This also handles a stale click
    // after a successful send: socket delivery is not a client acknowledgement.
    hide(session, id, true);
    return true;
}

module.exports = { publish, remove, removeMissing };
