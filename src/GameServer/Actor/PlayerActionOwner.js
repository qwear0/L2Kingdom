// Only explicitly tagged server actions participate in player auto-fight.
// Untagged native/bot callers retain their existing action contract.
function current(session, actor, owner) {
    return !owner || (owner.source === 'player-auto-fight'
        && session?.actor === actor && owner.isCurrent());
}

function takeover(session, actor) {
    if (session?.actor === actor) actor.playerAutoFight?.stop('manual_takeover');
}

module.exports = { current, takeover };
