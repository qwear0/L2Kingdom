// All mutations here run on Database's existing synchronous transaction queue.
// Prepared catalog data contains no SQL calls; publication belongs to services
// after commit, and a publication failure must never roll back a reward receipt.
function migrate(connection) {
    connection.exec(`
        CREATE TABLE lord_characters (
            characterId INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
            grantedAt INTEGER NOT NULL,
            clanGrantedAt INTEGER
        );
        CREATE TABLE vassals (
            characterId INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
            ownerCharacterId INTEGER NOT NULL REFERENCES lord_characters(characterId) ON DELETE RESTRICT,
            boundClanId INTEGER REFERENCES clans(id) ON DELETE SET NULL,
            "order" TEXT NOT NULL DEFAULT 'service' CHECK("order" IN ('service','gather','return')),
            areaId TEXT,
            loadoutPreference TEXT CHECK(loadoutPreference IN ('bow','dagger')),
            gatherResumePending INTEGER NOT NULL DEFAULT 0 CHECK(gatherResumePending IN (0,1)),
            orderRevision INTEGER NOT NULL DEFAULT 1 CHECK(orderRevision > 0),
            creationRequestId TEXT NOT NULL,
            updatedAt INTEGER NOT NULL,
            UNIQUE(ownerCharacterId, creationRequestId),
            CHECK(("order" = 'gather' AND areaId IS NOT NULL AND length(areaId) > 0)
                OR ("order" != 'gather' AND areaId IS NULL AND gatherResumePending = 0)),
            CHECK(characterId != ownerCharacterId)
        );
        CREATE INDEX vassals_owner ON vassals(ownerCharacterId, characterId);
        CREATE TRIGGER character_clan_capacity BEFORE UPDATE OF clanId ON characters
        WHEN NEW.clanId != 0 AND NEW.clanId != OLD.clanId
        BEGIN
            SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM clans WHERE id = NEW.clanId)
                THEN RAISE(ABORT, 'clan_missing') END;
            SELECT CASE WHEN (SELECT COUNT(*) FROM characters WHERE clanId = NEW.clanId) >=
                (SELECT CASE WHEN level <= 0 THEN 10 WHEN level = 1 THEN 15 WHEN level = 2 THEN 20
                    WHEN level = 3 THEN 30 ELSE 40 END FROM clans WHERE id = NEW.clanId)
                THEN RAISE(ABORT, 'clan_full') END;
        END;
        CREATE TRIGGER character_clan_capacity_insert BEFORE INSERT ON characters
        WHEN NEW.clanId != 0
        BEGIN
            SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM clans WHERE id = NEW.clanId)
                THEN RAISE(ABORT, 'clan_missing') END;
            SELECT CASE WHEN (SELECT COUNT(*) FROM characters WHERE clanId = NEW.clanId) >=
                (SELECT CASE WHEN level <= 0 THEN 10 WHEN level = 1 THEN 15 WHEN level = 2 THEN 20
                    WHEN level = 3 THEN 30 ELSE 40 END FROM clans WHERE id = NEW.clanId)
                THEN RAISE(ABORT, 'clan_full') END;
        END;
    `);
}

function repository({ one, all, write, run, inTransaction, withCharacterFlush }) {
    const Rules = require('../Clan/ClanRules');
    const character = id => one('SELECT * FROM characters WHERE id = ?', [id]);
    const lord = id => one('SELECT * FROM lord_characters WHERE characterId = ?', [id]);
    const resultFor = (id, replayed = false) => ({ ok: true, replayed, character: character(id),
        items: all('SELECT * FROM items WHERE characterId = ?', [id]),
        skills: all('SELECT * FROM skills WHERE characterId = ?', [id]),
        vassal: one('SELECT * FROM vassals WHERE characterId = ?', [id]) });
    function authenticate(id, accountId) {
        const row = character(id);
        if (!row || row.username.toLowerCase() !== String(accountId).toLowerCase()
            || row.username.startsWith('bot_')) throw Error('invalid_lord_owner');
        return row;
    }
    function grant(id, prepared, equip) {
        if (equip) write('UPDATE items SET equipped = 0 WHERE characterId = ?', [id]);
        for (const item of prepared.items) {
            const stack = item.stackable && one('SELECT id FROM items WHERE characterId = ? AND selfId = ? AND equipped = 0 AND enchant = 0 ORDER BY id LIMIT 1', [id, item.selfId]);
            if (stack) write('UPDATE items SET amount = amount + ? WHERE id = ?', [item.amount, stack.id]);
            else write('INSERT INTO items(selfId,name,amount,enchant,equipped,slot,characterId) VALUES(?,?,?,0,?,?,?)',
                [item.selfId, item.name, item.amount, equip && item.equipped ? 1 : 0, item.slot, id]);
        }
        for (const skill of prepared.skills) {
            const existing = one('SELECT level FROM skills WHERE characterId = ? AND selfId = ?', [id, skill.selfId]);
            if (!existing) write('INSERT INTO skills(selfId,name,level,passive,characterId) VALUES(?,?,?,?,?)',
                [skill.selfId, skill.name, skill.level, skill.passive ? 1 : 0, id]);
            else if (Number(existing.level) < skill.level) write('UPDATE skills SET level = ? WHERE characterId = ? AND selfId = ?', [skill.level, id, skill.selfId]);
        }
    }
    return {
        fetchLordRegistry() { return run('SELECT * FROM lord_characters', [], 'lord:registry', true); },
        fetchVassalRegistry() { return run('SELECT * FROM vassals', [], 'vassal:registry', true); },
        fetchOwnedVassalCharacters() {
            return run('SELECT characters.* FROM characters JOIN vassals ON vassals.characterId = characters.id ORDER BY characters.id', [], 'vassal:characters', true);
        },
        characterOwnsVassals(id) {
            return run('SELECT 1 FROM vassals WHERE ownerCharacterId = ? LIMIT 1', [id], 'vassal:delete-guard', true).then(rows => rows.length > 0);
        },
        grantLord({ characterId, accountId, prepared, beforeWrite }) {
            return withCharacterFlush(characterId, () => inTransaction(() => {
                beforeWrite();
                const row = authenticate(characterId, accountId);
                if (lord(characterId)) return resultFor(characterId, true);
                if (!prepared) throw Error('lord_grant_preparation_required');
                if (row.classId !== prepared.sourceClassId || row.level !== prepared.sourceLevel) throw Error('lord_source_changed');
                write('UPDATE characters SET classId = ?, level = ?, exp = MAX(exp, ?) WHERE id = ?',
                    [prepared.classId, Math.max(20, row.level), prepared.exp, characterId]);
                grant(characterId, prepared, false);
                write('INSERT INTO lord_characters(characterId,grantedAt) VALUES(?,?)', [characterId, Date.now()]);
                return resultFor(characterId);
            }, 'lord:grant'));
        },
        ensureLordClan({ characterId, accountId, name, beforeWrite }) {
            return withCharacterFlush(characterId, () => inTransaction(() => {
                beforeWrite();
                const row = authenticate(characterId, accountId), enrollment = lord(characterId);
                if (!enrollment) throw Error('not_lord');
                if (row.clanId) {
                    const clan = one('SELECT * FROM clans WHERE id = ?', [row.clanId]);
                    if (!clan || clan.leaderId !== characterId || clan.dissolvingExpiryTime > Date.now()) throw Error('not_eligible_clan_leader');
                    if (clan.level >= 1) return { ok: true, replayed: true, clanId: clan.id };
                    if (enrollment.clanGrantedAt != null) throw Error('clan_grant_consumed');
                    write('UPDATE clans SET level = 1 WHERE id = ?', [clan.id]);
                } else {
                    const valid = Rules.validateClanName(name);
                    if (!valid.ok) throw Error(valid.code);
                    if (enrollment.clanGrantedAt != null) throw Error('clan_grant_consumed');
                    if (row.clanCreateExpiryTime > Date.now() || row.clanJoinExpiryTime > Date.now()) throw Error('clan_cooldown');
                    const clanId = write('INSERT INTO clans(name,leaderId,level) VALUES(?,?,1)', [valid.name, characterId]).insertId;
                    write('UPDATE characters SET clanId = ?, clanPrivileges = ?, clanJoinExpiryTime = 0, clanCreateExpiryTime = 0 WHERE id = ?',
                        [clanId, Rules.CP_ALL, characterId]);
                    row.clanId = clanId;
                }
                write('UPDATE lord_characters SET clanGrantedAt = ? WHERE characterId = ?', [Date.now(), characterId]);
                return { ok: true, clanId: row.clanId };
            }, 'lord:clan'));
        },
        createOwnedVassal({ ownerCharacterId, accountId, requestId, expiresAt, prepared, beforeWrite }) {
            return withCharacterFlush(ownerCharacterId, () => inTransaction(() => {
                beforeWrite();
                const owner = authenticate(ownerCharacterId, accountId);
                if (!lord(ownerCharacterId)) throw Error('not_lord');
                const receipt = one('SELECT characterId FROM vassals WHERE ownerCharacterId = ? AND creationRequestId = ?', [ownerCharacterId, requestId]);
                // Authentication precedes replay; expiry/capacity follow it. A
                // committed confirmation is a receipt, never a second grant.
                if (receipt) return resultFor(receipt.characterId, true);
                if (!requestId || !Number.isFinite(expiresAt) || expiresAt < Date.now()) throw Error('creation_confirmation_expired');
                const clan = one('SELECT * FROM clans WHERE id = ?', [owner.clanId]);
                if (!clan || clan.leaderId !== ownerCharacterId || clan.level < 1 || clan.dissolvingExpiryTime > Date.now()
                    || clan.charPenaltyExpiryTime > Date.now()) throw Error('not_eligible_clan_leader');
                if (one('SELECT COUNT(*) AS total FROM characters WHERE clanId = ?', [clan.id]).total >= Rules.memberLimit(clan.level)) throw Error('clan_full');
                write('INSERT INTO accounts(username,password) VALUES(?,?)', [prepared.username, prepared.password]);
                const p = prepared;
                const id = write(`INSERT INTO characters(username,name,race,classId,level,exp,sex,face,hair,hairColor,
                    hp,maxHp,mp,maxMp,locX,locY,locZ,clanId,newbie)
                    VALUES(?,?,?,?,20,?,?,0,0,0,?,?,?,?,?,?,?,? ,0)`,
                [p.username,p.name,p.race,p.classId,p.exp,p.sex,p.maxHp,p.maxHp,p.maxMp,p.maxMp,p.locX,p.locY,p.locZ,clan.id]).insertId;
                grant(id, prepared, true);
                write('INSERT INTO vassals(characterId,ownerCharacterId,boundClanId,loadoutPreference,creationRequestId,updatedAt) VALUES(?,?,?,?,?,?)',
                    [id,ownerCharacterId,clan.id,p.loadoutPreference,requestId,Date.now()]);
                return resultFor(id);
            }, 'vassal:create'));
        },
        updateVassalDuty({ characterId, ownerCharacterId, revision, order, areaId = null, gatherResumePending = false,
            accountId = null, beforeWrite = null }) {
            return inTransaction(() => {
                beforeWrite?.();
                if (accountId !== null) {
                    const owner = authenticate(ownerCharacterId, accountId);
                    const owned = one('SELECT * FROM vassals WHERE characterId = ? AND ownerCharacterId = ?', [characterId, ownerCharacterId]);
                    if (!lord(ownerCharacterId) || !owned) throw Error('not_owned_vassal');
                    if (order === 'gather') {
                        const clan = one('SELECT * FROM clans WHERE id = ?', [owned.boundClanId]);
                        const member = character(characterId);
                        if (!clan || clan.leaderId !== ownerCharacterId || clan.level < 1 || clan.dissolvingExpiryTime > Date.now()
                            || Number(owner.clanId) !== Number(clan.id) || Number(member?.clanId) !== Number(clan.id)) throw Error('vassal_clan_ineligible');
                    }
                }
                const result = write(`UPDATE vassals SET "order" = ?, areaId = ?, gatherResumePending = ?,
                    orderRevision = orderRevision + 1, updatedAt = ? WHERE characterId = ? AND ownerCharacterId = ? AND orderRevision = ?`,
                [order, areaId, gatherResumePending ? 1 : 0, Date.now(), characterId, ownerCharacterId, revision]);
                return result.affectedRows ? one('SELECT * FROM vassals WHERE characterId = ?', [characterId]) : null;
            }, 'vassal:duty');
        }
    };
}
module.exports = { migrate, repository };
