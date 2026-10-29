'use strict';

const Queries = require('./Queries');
const Journal = require('./Journal');
const { fault } = require('../../../Mcp/Contracts');
function bounded(value) {
    const result = Journal.compact(value);
    return Buffer.byteLength(JSON.stringify(result)) <= 2048 ? result : { truncated: true };
}
function diagnose(attachment, input, actorRef) {
    const { actor, session } = attachment.record;
    if ((input.destination || input.checkDirect) && input.kind !== 'movement') throw fault('destination_requires_movement_diagnostic');
    if (input.checkDirect && !input.destination) throw fault('destination_required');
    const action = input.actionId ? require('./Actions').read({ sessionId: attachment.sessionId, actionId: input.actionId }) : null;
    if (action && (action.actorRef.characterId !== actorRef.characterId || action.actorRef.incarnation !== actorRef.incarnation)) {
        throw fault('action_actor_mismatch', 409);
    }
    const from = Queries.point(actor), Geo = invoke('GameServer/Geodata/GeodataEngine');
    const entity = input.handle ? Queries.resolve(actor, input.handle) : null;
    const to = entity ? Queries.point(entity) : null;
    if (input.checkLos && !to) throw fault('target_handle_required');
    const grid = [];
    if (input.kind === 'movement') for (let x = -input.gridRadius; x <= input.gridRadius; x++) {
        for (let y = -input.gridRadius; y <= input.gridRadius; y++) {
            const locX = from.locX + x * 16, locY = from.locY + y * 16;
            const cell = Geo.getCellData(locX, locY, from.locZ);
            grid.push({ locX, locY, z: cell.z, nswe: cell.nswe, layerData: cell.hasLayerData });
        }
    }
    const result = { kind: input.kind, view: 'server_diagnostic', sampledAt: Date.now(), source: 'native_state_not_causal_inference',
        control: require('./Authority').view(session), position: from };
    if (input.destination) result.destination = require('./DestinationPreflight').inspect(from, input.destination, input.checkDirect);
    if (input.checkLos && to) result.geometry = { checkedAt: Date.now(),
        hasGeodata: Geo.hasGeo(to.locX, to.locY) && Geo.hasGeo(from.locX, from.locY),
        los: Geo.hasLineOfSight(from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ),
        source: 'current_native_LOS_not_past_cause' };
    if (input.kind === 'movement' || input.kind === 'evidence') result.movement = {
        lastPathfinding: bounded(session.lastPathfinding || null), pending: Boolean(session.pendingPathRequest),
        currentRoute: session.lastPathfinding ? { actionId: session.lastPathfinding.actionId || null,
            routeGeneration: session.lastPathfinding.routeGeneration ?? null, evidence: session.lastPathfinding.pathEvidence || null } : null,
        actionRoute: action?.evidence.route || null, currentNavigation: Geo.inputIdentity(),
        towards: bounded(actor.state.fetchTowards() || null), grid,
        geodata: Geo.hasGeo(from.locX, from.locY), relocationIsNotArrival: session.lastPathfinding?.lowLodWarp === true,
        gaps: ['lastPathfinding/currentRoute/grid/LOS describe current state, not the selected historical action. Only actionRoute is action-correlated.',
            'No new route job or nearest-blocker inference; absent route evidence stays unknown.'] };
    if (input.kind === 'combat' || input.kind === 'evidence') result.combat = {
        target: entity ? Queries.row(entity, input.handle.kind, from, 'diagnostic') : null,
        selectedTargetId: actor.fetchDestId() || null,
        distance: to ? Math.hypot(to.locX - from.locX, to.locY - from.locY) : null,
        normalAttackRange: actor.fetchAtkRadius?.() ?? null,
        peaceZone: utils.isInPeaceZone(actor.fetchLocX(), actor.fetchLocY()),
        hp: actor.fetchHp(), mp: actor.fetchMp(), lastSkillOutcome: bounded(session.lastSkillOutcome || null),
        restrictions: bounded(invoke('GameServer/Effects/EffectStore').impairments(actor)),
        attackAllowedNow: invoke('GameServer/Effects/EffectRestrictions').canAttack(actor),
        castAllowedNow: invoke('GameServer/Effects/EffectRestrictions').canCast(actor),
        los: result.geometry || null,
        consumablesAndReuse: 'inspect inventory/skills; eligibility is not execution authorization' };
    if (input.kind === 'ai' || input.kind === 'evidence') result.ai = {
        active: session.aiActive === true, plan: String(session.plan || '').slice(0, 100),
        decision: bounded(session.lastDecision || null), combatDecision: bounded(session.lastCombatDecision || null),
        duty: bounded(session.vassalRun || null), recovery: session.recoveryLocked === true,
        journey: session.journey ? { status: session.journey.status, reason: session.journey.reason,
            destination: bounded(session.journey.request?.to || null), paymentUncertain: session.journey.paymentUncertain === true } : null,
        source: 'existing_native_policy_evidence; missing reasons stay unknown' };
    if (input.kind === 'evidence') {
        result.action = action;
        result.events = Journal.recent(session.mcpObservation, input.actionId || null);
        result.gaps = ['Only selected before/after fields and the latest bounded route sample per action are retained, not full snapshots or raw packets.',
            'Loaded navigation identities do not certify a build SHA or independent native-client collision.'];
    }
    return result;
}
module.exports = { diagnose };
