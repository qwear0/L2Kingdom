const Response = invoke('GameServer/Network/Response');
const { CLIENT_VISIBILITY_RADIUS } = require('./WorldConstants');
const RADIUS_SQUARED = CLIENT_VISIBILITY_RADIUS ** 2;
const published = new WeakSet();
const viewersByActor = new WeakMap();

function isViewer(session) {
    return session?.actor?.fetchIsOnline?.() === true && !session.botSession
        && !String(session.accountId || '').startsWith('bot_')
        && typeof session.dataSendToMe === 'function';
}

function visible(viewer, actor) {
    if (!isViewer(viewer) || viewer.actor === actor || actor.session?.populationStaging
        || actor.session?.supplyErrandHidden || actor.fetchIsOnline?.() !== true) return false;
    const dx = Number(viewer.actor.fetchLocX()) - Number(actor.fetchLocX());
    const dy = Number(viewer.actor.fetchLocY()) - Number(actor.fetchLocY());
    return dx * dx + dy * dy < RADIUS_SQUARED;
}

function forget(viewer, id) {
    const actor = viewer.knownActors?.get(id);
    if (!actor) return;
    viewer.knownActors.delete(id);
    viewersByActor.get(actor)?.delete(viewer);
}

function clearViewer(viewer) {
    if (!viewer.knownActors) return;
    for (const id of viewer.knownActors.keys()) forget(viewer, id);
}

// Proximity queries cannot find a former observer after a boundary crossing.
// Retain the actual CharInfo recipients, including direct socket broadcasts,
// so DeleteObject reaches exactly the clients that still have this actor.
function trackPacket(world, viewer, packet) {
    if (!packet || typeof packet.readInt32LE !== 'function') return;
    if (packet[0] === 0x12 && packet.length >= 5) {
        forget(viewer, packet.readInt32LE(1));
    } else if (packet[0] === 0x03 && packet.length >= 21 && isViewer(viewer)) {
        // C4 CharInfo puts objectId after XYZ and the reserved boat id.
        const id = packet.readInt32LE(17);
        const actor = world.registeredActorById(id)?.actor;
        if (!actor || actor === viewer.actor) return;
        forget(viewer, id);
        viewer.knownActors ||= new Map();
        viewer.knownActors.set(id, actor);
        let viewers = viewersByActor.get(actor);
        if (!viewers) viewersByActor.set(actor, viewers = new Set());
        viewers.add(viewer);
    }
}

function hide(viewer, actor) {
    const id = Number(actor.fetchId());
    if (viewer.knownActors?.get(id) !== actor) return;
    forget(viewer, id);
    if (isViewer(viewer)) viewer.dataSendToMe(Response.deleteOb(id));
}

function removeActor(actor) {
    for (const viewer of viewersByActor.get(actor) || []) hide(viewer, actor);
    viewersByActor.delete(actor);
}

function show(viewer, actor) {
    if (!published.has(actor) || !visible(viewer, actor)
        || viewer.knownActors?.get(Number(actor.fetchId())) === actor) return;
    viewer.dataSendToMe(Response.charInfo(actor));
    viewer.dataSendToMe(Response.relationChanged(actor));
    const storeType = actor.fetchPrivateStoreType?.();
    const title = actor.fetchPrivateStore?.()?.title || actor.fetchTitle();
    if (storeType === 1) viewer.dataSendToMe(Response.privateStoreMsg(actor, title));
    else if (storeType === 3) viewer.dataSendToMe(Response.privateStoreBuyMsg(actor, title));
    else if (storeType === 5) viewer.dataSendToMe(Response.recipeShopMsg(actor));

    // A player may discover a bot halfway through a long movement segment.
    // CharInfo alone leaves it standing until the next waypoint announcement.
    const session = actor.session;
    const interpolation = actor.automation?.moveInterpolation;
    const to = interpolation?.actor === actor ? interpolation.to
        : session?.moveTimer ? session.activeMoveGoal?.waypoint : null;
    if (to && actor.state?.fetchTowards?.()) {
        const from = { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() };
        if (from.locX !== to.locX || from.locY !== to.locY)
            viewer.dataSendToMe(Response.moveToLocation(actor.fetchId(), { from, to }));
    }
}

function sync(world, session, actor) {
    if (actor.fetchIsOnline?.() !== true || session.populationStaging || session.supplyErrandHidden) {
        removeActor(actor);
        clearViewer(session);
        return;
    }
    if (!published.has(actor)) return;

    const nearbyViewers = new Set(world.fetchVisibleRealPlayers(session, actor));
    for (const viewer of viewersByActor.get(actor) || []) {
        if (!nearbyViewers.has(viewer)) hide(viewer, actor);
    }
    for (const viewer of nearbyViewers) show(viewer, actor);

    // Moving the observer changes visibility even when every bot is stationary.
    if (!isViewer(session)) return;
    for (const known of session.knownActors?.values() || []) {
        if (world.registeredActorById(Number(known.fetchId()))?.actor !== known || !visible(session, known))
            hide(session, known);
    }
    for (const other of world.fetchVisibleUsers(session, actor)) show(session, other.actor);
}

module.exports = { publish: actor => published.add(actor), trackPacket, sync, removeActor, clearViewer };
