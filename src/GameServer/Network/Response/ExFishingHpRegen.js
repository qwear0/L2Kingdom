const SendPacket = invoke('Packet/Send');

module.exports = function exFishingHpRegen(actor, time, hp, mode, good, animation, penalty) {
    return new SendPacket(0xfe).writeH(0x16).writeD(actor.fetchId()).writeD(time).writeD(hp)
        .writeC(mode).writeC(good).writeC(animation).writeD(penalty).writeC(0).fetchBuffer();
};
