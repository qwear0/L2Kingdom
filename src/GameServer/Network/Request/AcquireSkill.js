const ReceivePacket = invoke('Packet/Receive');

module.exports = function acquireSkill(session, buffer) {
    if (!session.actor || !buffer || buffer.length !== 13) return;
    const packet = new ReceivePacket(buffer);
    packet.readD().readD().readD();
    return require('../../Fishing/FishingTraining').learn(session, packet.data[0], packet.data[1], packet.data[2]);
};
