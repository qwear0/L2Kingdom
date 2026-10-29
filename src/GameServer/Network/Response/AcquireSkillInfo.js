const SendPacket = invoke('Packet/Send');

module.exports = function acquireSkillInfo(rank) {
    // Source C4 requirements use an integer Q count, not Send.writeF's double.
    // Fishing prices fit the low D; the high D is zero.
    return new SendPacket(0x8b).writeD(rank.skillId).writeD(rank.level).writeD(0).writeD(1)
        .writeD(1).writeD(99).writeD(57).writeD(rank.adena).writeD(0).writeD(50).fetchBuffer();
};
