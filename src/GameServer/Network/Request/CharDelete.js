const Shared        = invoke('GameServer/Network/Shared');
const ReceivePacket = invoke('Packet/Receive');
const Database      = invoke('Database');
const Response      = invoke('GameServer/Network/Response');
const SendPacket    = invoke('Packet/Send');

function refuseOwnedDeletion(session) {
    session.dataSendToMe(Response.systemMessage.text('This Lord owns vassals and cannot be deleted.'));
    session.dataSendToMe(new SendPacket(0x24).writeD(0).fetchBuffer()); // C4 CharDeleteFail
}

function charDelete(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD(); // Character Slot

    return consume(session, {
        characterSlot: packet.data[0]
    });
}

function consume(session, data) {
    return Shared.fetchCharacters(session.accountId).then(async (characters) => {
        const character = characters[data.characterSlot];
        if (!character) return;
        // Refuse before board leave or any other unrelated teardown. The
        // queued delete repeats the guard and the owner FK is RESTRICT.
        if (await Database.characterOwnsVassals(character.id)) {
            refuseOwnedDeletion(session);
            return;
        }

        // The leave rule (design 2.7, E49): the character's board records
        // close first, so the board in memory and its index drop them.
        return invoke('GameServer/AfkTrade/AfkTradeService').leave(character.id).catch((error) => {
            utils.infoWarn('CharDelete', 'board leave failed for %s: %s', character.name, error.message);
        }).then(() => Database.deleteCharacter(session.accountId, character.name)).then(() => {
            // The character's items, skills, shortcuts and macros go with its
            // row: every table references characters(id) ON DELETE CASCADE and
            // the game connection enables foreign keys (U53).
            characters.splice(data.characterSlot, 1);
            Shared.enterCharacterHall(session, characters);
        }).catch(error => {
            if (error.message !== 'character_owns_vassals') throw error;
            refuseOwnedDeletion(session);
        });
    });
}

module.exports = charDelete;
