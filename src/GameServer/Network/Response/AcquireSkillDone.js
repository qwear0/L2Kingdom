const SendPacket = invoke('Packet/Send');

module.exports = function acquireSkillDone() {
    return new SendPacket(0x8e).fetchBuffer();
};
