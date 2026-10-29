const Data = require('./FishingData');
const Item = invoke('GameServer/Item/Item');
const Database = invoke('Database');
const Response = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');
const INCOMPATIBLE_PACKETS = new Set([
    0x15, 0x16, 0x17, 0x1e, 0x1f, 0x31, 0x32, 0x58, 0x59, 0x72,
    0x73, 0x74, 0x76, 0x77, 0x79, 0x90, 0x91, 0x93, 0x94, 0x96,
    0xa7, 0xae, 0xaf, 0xb0, 0xb2, 0xb3, 0xb5, 0xb6, 0xb7
]);

function current(session, actor) {
    return !!actor && session?.actor === actor && actor.fetchIsOnline?.() === true
        && !session.socket?.destroyed && !!session.socket && !session.botSession
        && !String(session.accountId || '').startsWith('bot_') && !session.arenaEphemeral
        && session.persistenceMode !== 'ephemeral'
        && World.registeredActorById(actor.fetchId())?.actor === actor;
}

function available(session, actor) {
    return current(session, actor) && !actor.state.fetchDead() && !actor.fetchPrivateStoreType()
        && !actor.fetchMounted() && !actor.boat && !actor.fetchBoat?.() && !actor.fetchBoatId?.()
        && !session.activeTrade && !session.trade && !session.botTrade && !session.activeNegotiation
        && !session.pendingActorTeleport && !session.activeEnchantItem
        && !actor.state.fetchSeated() && !actor.state.fetchAnimated() && !actor.state.fetchPickinUp()
        && !invoke('GameServer/Crafting/RecipeCrafting').busy(actor.fetchId());
}

function message(session, actor, text) {
    if (current(session, actor)) session.dataSendToMe(Response.speak(actor, { kind: 0, text }));
}

function reject(session, actor, text) {
    if (!current(session, actor)) return;
    if (text) message(session, actor, text);
    session.dataSendToMe(Response.actionFailed());
}

function report(session, actor, error) {
    utils.infoWarn('Fishing', 'operation rejected for %d: %s', actor?.fetchId?.() || 0, error.message);
    reject(session, actor, `Fishing: ${error.message.replace(/^fishing_/, '').replaceAll('_', ' ')}.`);
}

function resetShot(actor) {
    const weapon = actor?.backpack?.fetchEquippedWeapon();
    for (const rod of new Set([weapon, actor?.fishingChargedRod].filter(Boolean))) {
        if (!Data.isRod(rod)) continue;
        rod.chargedFishShot = false;
        if (rod.model) rod.model.chargedFishShot = false;
    }
    if (actor) delete actor.fishingChargedRod;
}

function appearance(session, actor) {
    if (!current(session, actor)) return;
    session.dataSendToMe(Response.userInfo(actor));
    session.dataSendToOthers(Response.charInfo(actor), actor);
}

function end(session, actor, attempt, win = false) {
    if (actor.fishing !== attempt) return;
    clearTimeout(attempt.timer);
    actor.fishing = null;
    if (attempt.visible && current(session, actor)) {
        session.dataSendToMeAndOthers(Response.exFishingEnd(actor, win), actor);
        appearance(session, actor);
    }
}

function dispose(session, actor) {
    if (!actor) return;
    actor.fishingGeneration = Number(actor.fishingGeneration || 0) + 1;
    if (actor.fishing) end(session, actor, actor.fishing);
    resetShot(actor);
    if (session?.activeFishingTraining?.actor === actor) session.activeFishingTraining = null;
}

function validateInventory(actor, rows) {
    const items = actor.backpack.fetchItems();
    if (rows.length !== items.length) throw Error('fishing_inventory_changed');
    const held = new Map(items.map(item => [item.fetchId(), item]));
    for (const row of rows) {
        const item = held.get(row.id);
        if (!item || item.fetchSelfId() !== row.selfId || item.fetchAmount() !== row.amount
            || !!item.fetchEquipped() !== !!row.equipped || row.equipped && item.fetchSlot() !== row.slot)
            throw Error('fishing_inventory_changed');
    }
}

function applyRows(actor, rows) {
    const bag = actor.backpack;
    let equipmentChanged = false;
    for (const row of rows) {
        const item = bag.fetchItemRaw(row.id);
        if (!row.amount) {
            if (item?.fetchEquipped()) {
                bag.unequipPaperdoll(item.fetchSlot());
                equipmentChanged = true;
            }
            bag.items = bag.fetchItems().filter(entry => entry.fetchId() !== row.id);
            bag.inventoryRevision = Number(bag.inventoryRevision || 0) + 1;
            bag.onInventoryChange?.(row.selfId);
        } else if (item) item.setAmount(row.amount);
        else bag.insertItem(row.id, row.selfId, row);
    }
    Item.bindInventory(bag);
    return equipmentChanged;
}

// A single live mutation owner spans queue admission through publication.
// Lifecycle invalidation revokes uncommitted work; a completed transaction
// still belongs to the original character, never a replacement session actor.
async function settle(session, actor, action, check = () => {}) {
    if (!available(session, actor) || actor.fishingMutation) throw Error('fishing_busy');
    const token = {}, generation = Number(actor.fishingGeneration || 0);
    const revision = Number(actor.backpack.inventoryRevision || 0);
    actor.fishingMutation = token;
    try {
        const result = await Database.settleFishing(actor.fetchId(), action, rows => {
            if (!available(session, actor) || actor.fishingMutation !== token
                || Number(actor.fishingGeneration || 0) !== generation
                || Number(actor.backpack.inventoryRevision || 0) !== revision) throw Error('fishing_interrupted');
            check();
            validateInventory(actor, rows);
            return { level: actor.fetchLevel(), maxLoad: actor.fetchMaxLoad() };
        });
        const equipmentChanged = applyRows(actor, result.rows);
        if (result.learned) {
            const definition = invoke('GameServer/Item/ItemTemplateIndex').findStrictRequired(
                invoke('GameServer/DataCache').skills, result.learned.selfId);
            const rank = definition.levels.find(row => row.level === result.learned.level);
            const Skill = invoke('GameServer/Model/Skill');
            actor.skillset.skills = actor.skillset.fetchSkills().filter(skill => skill.fetchSelfId() !== result.learned.selfId);
            actor.skillset.skills.push(new Skill({ ...utils.crushOb(definition), ...rank }));
        }
        if (current(session, actor)) {
            session.dataSendToMe(Response.itemsList(actor.backpack.fetchItems()));
            actor.statusUpdateVitals?.(actor);
            if (equipmentChanged) appearance(session, actor);
            if (result.learned) session.dataSendToMe(Response.skillsList(actor.skillset.fetchSkills()));
        }
        return result;
    } finally {
        if (actor.fishingMutation === token) delete actor.fishingMutation;
    }
}

function valid(session, actor, attempt) {
    const weapon = actor.backpack.fetchEquippedWeapon();
    return available(session, actor) && actor.fishing === attempt
        && Number(actor.fishingGeneration || 0) === attempt.generation
        && Number(actor.backpack.equipmentRevision || 0) === attempt.equipmentRevision
        && weapon === attempt.rod && weapon.fetchSelfId() === Data.rod.itemId
        && actor.fetchLocX() === attempt.origin.locX && actor.fetchLocY() === attempt.origin.locY
        && actor.fetchLocZ() === attempt.origin.locZ;
}

function schedule(session, actor, attempt, delay, work) {
    attempt.timer = setTimeout(() => {
        if (!valid(session, actor, attempt)) {
            if (actor.fishing === attempt) dispose(session, actor);
            return;
        }
        try { work(); }
        catch (error) { end(session, actor, attempt); report(session, actor, error); }
    }, delay);
    attempt.timer.unref?.();
}

function hpPacket(actor, attempt, good = 0, animation = 0, penalty = 0) {
    return Response.exFishingHpRegen(actor, attempt.time, attempt.hp, attempt.mode, good, animation, penalty);
}

function tick(session, actor, attempt) {
    if (attempt.hp >= attempt.fish.hp * 2 || attempt.time <= 0) {
        message(session, actor, 'The fish got away.');
        end(session, actor, attempt);
        return;
    }
    --attempt.time;
    if (attempt.mode === 1) attempt.hp += Math.trunc(attempt.fish.regen);
    if (attempt.stop === 0) {
        attempt.stop = 1;
        if (Math.floor(Math.random() * 100) >= 70) attempt.mode = attempt.mode === 0 ? 1 : 0;
    } else --attempt.stop;
    session.dataSendToMe(hpPacket(actor, attempt));
    schedule(session, actor, attempt, 1000, () => tick(session, actor, attempt));
}

function look(session, actor, attempt) {
    if (Date.now() >= attempt.biteDeadline) {
        message(session, actor, 'No fish took the bait.');
        end(session, actor, attempt);
        return;
    }
    if (!attempt.night && attempt.fish.guts > Math.floor(Math.random() * 100)) {
        attempt.phase = 'fighting';
        attempt.time = attempt.fish.duration;
        attempt.hp = attempt.fish.hp;
        attempt.mode = Math.floor(Math.random() * 100) >= 80 ? 1 : 0;
        attempt.stop = 0;
        session.dataSendToMeAndOthers(Response.exFishingStartCombat(actor, attempt.time, attempt.hp, attempt.mode), actor);
        session.dataSendToMe(Response.playSound('SF_S_01'));
        message(session, actor, 'You have a bite!');
        schedule(session, actor, attempt, 1000, () => tick(session, actor, attempt));
    } else schedule(session, actor, attempt, attempt.fish.checkTime * 66, () => look(session, actor, attempt));
}

function cost(actor, skill) {
    // Several client packets can enter before the dispatch microtask runs.
    // Recheck at the actual action, not only when each request was received.
    if (!actor.canUseSkill(skill) || !invoke('GameServer/Effects/EffectRestrictions').canCast(actor))
        throw Error('fishing_action_unavailable');
    const mp = Number(skill.fetchConsumedMp());
    if (!Number.isFinite(mp) || actor.fetchMp() < mp) throw Error('fishing_not_enough_mp');
    actor.setMp(actor.fetchMp() - mp);
    const reuse = Number(skill.fetchReuseTime());
    if (reuse > 0) {
        actor.skillReuseUntil.set(skill.fetchSelfId(), Date.now() + reuse);
        actor.skillReuseDetails.set(skill.fetchSelfId(), { duration: reuse, level: skill.fetchLevel() });
    }
    actor.statusUpdateVitals(actor);
}

async function start(session, actor, skill) {
    if (actor.fishing) {
        dispose(session, actor);
        message(session, actor, 'Fishing cancelled.');
        return;
    }
    if (!available(session, actor) || actor.fishingMutation || actor.state.fetchCasts() || actor.state.fetchHits()
        || actor.state.fetchCombats() || actor.state.fetchSeated() || session.moveTimer || session.pendingPathRequest
        || actor.automation?.moveInterpolation || actor.state.inMotion()) throw Error('fishing_busy');
    const rod = actor.backpack.fetchEquippedWeapon();
    const lure = actor.backpack.fetchItems().find(item => item.fetchEquipped() && item.fetchSlot() === 8);
    if (!Data.isPair(rod?.fetchSelfId(), lure?.fetchSelfId()) || lure.fetchAmount() < 1) throw Error('fishing_equip_rod_and_lure');
    if (actor.fetchMp() < Number(skill.fetchConsumedMp())) throw Error('fishing_not_enough_mp');
    const hook = require('./FishingZones').findHook(actor);
    if (!hook) throw Error('fishing_no_valid_water_or_geodata');
    actor.playerAutoFight?.stop('manual_fishing');
    invoke(path.actor).clearStoredActions(session, actor);
    actor.automation.abortAll(actor);
    actor.attack.clearTimers();
    const expertise = actor.skillset.fetchSkill(1315)?.fetchLevel() || 0;
    const attempt = { phase: 'admitting', rod, hook, generation: Number(actor.fishingGeneration || 0),
        equipmentRevision: Number(actor.backpack.equipmentRevision || 0),
        origin: { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() },
        fish: Data.select(expertise), night: invoke('GameServer/World/GameTime').isNight(), visible: false };
    actor.fishing = attempt;
    try {
        await settle(session, actor, { kind: 'bait', itemId: lure.fetchId() }, () => {
            if (!valid(session, actor, attempt) || actor.fetchMp() < Number(skill.fetchConsumedMp())) throw Error('fishing_interrupted');
        });
        // Consuming the final equipped lure removes its paperdoll row. That
        // one committed removal belongs to this cast, not an external cancel.
        attempt.equipmentRevision = Number(actor.backpack.equipmentRevision || 0);
        if (!valid(session, actor, attempt)) { end(session, actor, attempt); return; }
        cost(actor, skill);
        attempt.phase = 'waiting';
        attempt.visible = true;
        attempt.biteDeadline = Date.now() + (attempt.fish.startCombatTime + 10) * 1000;
        session.activeFishingTraining = null;
        appearance(session, actor);
        session.dataSendToMeAndOthers(Response.exFishingStart(actor, attempt.night ? -1 : attempt.fish.group, hook), actor);
        session.dataSendToMe(Response.playSound('SF_P_01'));
        message(session, actor, 'You start fishing.');
        schedule(session, actor, attempt, 10000, () => look(session, actor, attempt));
    } catch (error) { end(session, actor, attempt); throw error; }
}

async function win(session, actor, attempt) {
    clearTimeout(attempt.timer);
    attempt.phase = 'settling';
    try {
        await settle(session, actor, { kind: 'catch', itemId: attempt.fish.itemId }, () => {
            if (!valid(session, actor, attempt)) throw Error('fishing_interrupted');
        });
        if (actor.fishing === attempt) {
            if (current(session, actor)) invoke('GameServer/ConsoleText').transmitPickup(session, attempt.fish.itemId, 1);
            end(session, actor, attempt, true);
        }
    } catch (error) { end(session, actor, attempt); report(session, actor, error); }
}

function fight(session, actor, skill) {
    const attempt = actor.fishing;
    if (!attempt || attempt.phase !== 'fighting' || !valid(session, actor, attempt) || actor.fishingMutation)
        throw Error('fishing_action_unavailable');
    if (attempt.hp >= attempt.fish.hp * 2 || attempt.time <= 0) {
        end(session, actor, attempt);
        throw Error('fishing_fish_got_away');
    }
    cost(actor, skill);
    const charged = !!(attempt.rod.chargedFishShot || attempt.rod.model.chargedFishShot);
    const expertise = actor.skillset.fetchSkill(1315);
    // The pinned snapshot calls the rod-level coefficient guessed. Preserve
    // that reference balance, not ordinary P.Atk or a claim of retail accuracy.
    let damage = Math.trunc((Data.rod.damage + (expertise?.fetchPower() ?? 1) + skill.fetchPower())
        * (Data.rod.level * 0.1) * (charged ? 2 : 1));
    const penalty = (expertise?.fetchLevel() || 0) < skill.fetchLevel() - 2 ? Math.trunc(damage * 0.05) : 0;
    damage -= penalty;
    if (charged) resetShot(actor);
    const resisted = Math.floor(Math.random() * 100) > 90;
    const correct = skill.fetchSelfId() === 1313 ? attempt.mode === 0 : attempt.mode === 1;
    const good = resisted ? 0 : correct ? 1 : 2;
    if (!resisted) attempt.hp = Math.max(0, attempt.hp + (correct ? -damage : damage));
    // Source execution sets Pumping=1 and Reeling=2; descriptive packet
    // comments in the source reverse these values and must not drive behavior.
    session.dataSendToMeAndOthers(hpPacket(actor, attempt, good, skill.fetchSelfId() === 1313 ? 1 : 2, penalty), actor);
    if (attempt.hp > attempt.fish.hp * 2) end(session, actor, attempt);
    else if (attempt.hp === 0) return win(session, actor, attempt);
}

function dispatch(session, actor, data) {
    if (!Data.isSkill(Number(data.selfId))) return false;
    if (Number(data.selfId) === 1312 && actor.fishing && !data.actionOwner && current(session, actor)) {
        dispose(session, actor);
        message(session, actor, 'Fishing cancelled.');
        return true;
    }
    const skill = actor.skillset.fetchSkill(Number(data.selfId));
    if (!skill || data.actionOwner || !available(session, actor)
        || !invoke('GameServer/Effects/EffectRestrictions').canCast(actor) || !actor.canUseSkill(skill)) {
        reject(session, actor);
        return true;
    }
    Promise.resolve().then(() => data.selfId === 1312 ? start(session, actor, skill) : fight(session, actor, skill))
        .catch(error => report(session, actor, error));
    return true;
}

function charge(session, actor, itemId, skill) {
    const rod = actor.backpack.fetchEquippedWeapon();
    if (!available(session, actor) || !Data.isPair(rod?.fetchSelfId(), Data.lureId)
        || rod.chargedFishShot || rod.model.chargedFishShot) return reject(session, actor);
    const equipmentRevision = Number(actor.backpack.equipmentRevision || 0);
    const generation = Number(actor.fishingGeneration || 0);
    settle(session, actor, { kind: 'shot', itemId }, () => {
        if (actor.backpack.fetchEquippedWeapon() !== rod || Number(actor.backpack.equipmentRevision || 0) !== equipmentRevision
            || rod.chargedFishShot || rod.model.chargedFishShot) throw Error('fishing_rod_changed');
    }).then(() => {
        if (!available(session, actor) || Number(actor.fishingGeneration || 0) !== generation
            || actor.backpack.fetchEquippedWeapon() !== rod
            || Number(actor.backpack.equipmentRevision || 0) !== equipmentRevision) return;
        rod.chargedFishShot = rod.model.chargedFishShot = true;
        actor.fishingChargedRod = rod;
        session.dataSendToMeAndOthers(Response.skillStarted(actor, actor.fetchId(), skill), actor);
    }).catch(error => report(session, actor, error));
}

function open(session, actor, itemId) {
    if (actor.fishing) return reject(session, actor, 'Cancel fishing before opening your catch.');
    settle(session, actor, { kind: 'open', itemId }).then(result => {
        if (!current(session, actor)) return;
        for (const product of result.products) invoke('GameServer/ConsoleText').transmitPickup(session, product.selfId, product.amount);
    }).catch(error => report(session, actor, error));
}

function rejectPacket(session, actor, opcode) {
    if (!INCOMPATIBLE_PACKETS.has(opcode) && !(actor.fishingMutation && opcode === 0x14)) return false;
    reject(session, actor, 'Finish or cancel the current fishing operation first.');
    return true;
}

module.exports = { current, available, message, reject, report, dispose, settle, dispatch, charge, open, rejectPacket };
