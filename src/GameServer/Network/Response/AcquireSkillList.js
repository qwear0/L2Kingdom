const SendPacket = invoke('Packet/Send');

module.exports = function acquireSkillList(ranks) {
    const packet = new SendPacket(0x8a).writeD(1).writeD(ranks.length);
    for (const rank of ranks) packet.writeD(rank.skillId).writeD(rank.level).writeD(rank.level).writeD(0).writeD(1);
    return packet.fetchBuffer();
};
