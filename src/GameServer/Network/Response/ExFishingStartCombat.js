const SendPacket = invoke('Packet/Send');

module.exports = function exFishingStartCombat(actor, time, hp, mode) {
    return new SendPacket(0xfe).writeH(0x15).writeD(actor.fetchId()).writeD(time).writeD(hp)
        .writeC(mode).writeC(1).writeC(0).fetchBuffer();
};
