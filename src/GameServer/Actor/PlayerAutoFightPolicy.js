// This is a temporary constraint on following companions, not a rewrite of
// their saved pull orders. Explicit duties and ordinary manual players keep
// their native contract; only tagged player actions own the player's run.
function forLeader(session) {
    const controller = session?.actor?.playerAutoFight;
    return controller?.run?.kind === 'hunt' ? controller : null;
}

function forAction(session, actor, owner) {
    if (owner) return owner.controller;
    if (session?.actor !== actor || session.partyCompanion !== true) return null;
    return forLeader(session.followPlayerSession);
}

function canStart(session, actor, targets, owner) {
    const controller = forAction(session, actor, owner);
    return !controller || controller.canInitiate(targets, actor);
}

function accepted(session, actor, targets, owner) {
    forAction(session, actor, owner)?.acceptTargets(targets);
}

function recovering(session) {
    const controller = forLeader(session);
    return !!controller && (controller.run.recovery || controller.needsRecovery());
}

module.exports = { forLeader, forAction, canStart, accepted, recovering };
