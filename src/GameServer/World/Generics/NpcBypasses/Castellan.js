module.exports = function castellan(session, parts) {
    return invoke('GameServer/Lord/CastellanDialog').handle(session, parts);
};
