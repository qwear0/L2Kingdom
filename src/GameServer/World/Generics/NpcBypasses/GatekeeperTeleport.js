const ServerResponse = invoke('GameServer/Network/Response');
const C4GatekeeperTeleports = invoke('GameServer/World/C4GatekeeperTeleports');
const GatekeeperService = require('../../GatekeeperService');
const refuseKarmaTeleport = invoke('GameServer/World/Generics/TeleporterKarmaRefusal');

module.exports = function gatekeeperTeleport(session, parts) {
    const actor = session?.actor, talk = session?.activeNpcTalk;
    const options = {
        actor, npcObjectId: talk?.objectId, npcId: talk?.selfId,
        isCurrent: () => session.actor === actor && session.activeNpcTalk === talk
    };
    if (!parts?.[1]) {
        if (GatekeeperService.contact(session, options)) return session?.dataSendToMe?.(ServerResponse.actionFailed());
        const html = C4GatekeeperTeleports.html(talk.selfId);
        if (html) {
            session.dataSendToMe(ServerResponse.npcHtml(talk.objectId, html));
            session.dataSendToMe(ServerResponse.actionFailed());
        }
        return;
    }
    const result = GatekeeperService.teleport(session, { ...options, destinationId: Number(parts[1]) });
    if (result.status === 'accepted') return;
    if (result.reason === 'karma' && refuseKarmaTeleport(session, actor)) return;
    if (result.reason === 'insufficient_adena') {
        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: 'You do not have enough Adena.' }));
    }
    if (result.error) utils.infoWarn('Gatekeeper', 'native action failed: %s', result.error.message);
    session.dataSendToMe(ServerResponse.actionFailed());
};
