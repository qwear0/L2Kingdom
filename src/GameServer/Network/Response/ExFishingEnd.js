const SendPacket = invoke('Packet/Send');

module.exports = function exFishingEnd(actor, win) {
    return new SendPacket(0xfe).writeH(0x14).writeD(actor.fetchId()).writeC(win ? 1 : 0).fetchBuffer();
};
