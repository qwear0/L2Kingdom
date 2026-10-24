module.exports = function fortressDefense(session, parts) {
    return invoke('GameServer/World/FortressDefense').handle(session, parts);
};
