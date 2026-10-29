const SendPacket = invoke('Packet/Send');

module.exports = function exFishingStart(actor, group, hook) {
    return new SendPacket(0xfe).writeH(0x13).writeD(actor.fetchId()).writeD(group)
        .writeD(hook.locX).writeD(hook.locY).writeD(hook.locZ).writeC(0).writeC(0).fetchBuffer();
};
