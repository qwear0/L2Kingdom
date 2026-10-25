// Mutation services require the spawned object and physical contact, never
// just a client-supplied template ID or a previously opened dialog.
const npcId = 90002;
const loc = Object.freeze({ locX: -12500, locY: 122816, locZ: -3114 });
function requireContact(session, expectedActor = session?.actor) {
    const actor = session?.actor, active = session?.activeNpcTalk;
    if (!actor || actor !== expectedActor || actor.isDead?.() || actor.state?.fetchCasts?.() || actor.state?.fetchHits?.()
        || actor.fetchPrivateStoreType?.() || session.trade || session.activeTrade || session.activeNegotiation
        || String(session.accountId).startsWith('bot_')) throw Error('lord_actor_unavailable');
    const World = invoke('GameServer/World/World');
    const npc = World.npc?.spawns?.find(row => Number(row.fetchId?.()) === Number(active?.objectId));
    if (!npc || Number(npc.fetchSelfId?.()) !== npcId || Number(active?.selfId) !== npcId) throw Error('castellan_required');
    const dx = actor.fetchLocX() - npc.fetchLocX(), dy = actor.fetchLocY() - npc.fetchLocY();
    const dz = actor.fetchLocZ() - npc.fetchLocZ();
    if (![dx,dy,dz].every(Number.isFinite) || dx * dx + dy * dy > 300 * 300 || Math.abs(dz) > 200) throw Error('castellan_too_far');
    return actor;
}
function fence(session) {
    const actor = requireContact(session);
    const revision = Number(actor.backpack.inventoryRevision || 0);
    const source = [actor.fetchClassId(), actor.fetchLevel(), actor.fetchExp(), actor.fetchSp(), actor.fetchClanId()];
    return () => {
        requireContact(session, actor);
        const current = [actor.fetchClassId(), actor.fetchLevel(), actor.fetchExp(), actor.fetchSp(), actor.fetchClanId()];
        if (Number(actor.backpack.inventoryRevision || 0) !== revision || current.some((value,index) => value !== source[index])) throw Error('lord_actor_changed');
    };
}
module.exports = { npcId, loc, requireContact, fence };
