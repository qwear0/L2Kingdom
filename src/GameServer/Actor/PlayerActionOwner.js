const GameplayLifecycle = require('../GameplayLifecycle');

// MCP uses the existing owned native continuations, but never impersonates
// player auto-fight. An untagged AI continuation cannot write through a
// manual handoff; callers with async lookup also capture the generation.
function current(session, actor, owner) {
    if (GameplayLifecycle.stopping) return false;
    if (!owner) return session?.actor !== actor || !session?.mcpControl;
    return ['player-auto-fight', 'bot-mcp'].includes(owner.source)
        && session?.actor === actor && owner.isCurrent();
}

function takeover(session, actor) {
    if (session?.actor === actor) actor.playerAutoFight?.stop('manual_takeover');
}

module.exports = { current, takeover };
