'use strict';

const { fault } = require('../../../Mcp/Contracts');
const Offers = require('./Offers');
const World = invoke('GameServer/World/World');
const Npcs = require('../../World/NpcObjectIndex');
function contact(run, npc = Npcs.find(World, run.session.activeNpcTalk?.objectId)) {
    if (!npc || npc.fetchAttackable?.() || npc.fetchIsSummon?.()) throw fault('npc_not_interactive', 409);
    if (npc.questSpawn && npc.questSpawn.ownerId !== run.actor.fetchId()) throw fault('personal_npc_unavailable', 409);
    const reason = require('../../World/GatekeeperService').contact(run.session, { actor: run.actor, npc,
        npcObjectId: npc.fetchId(), npcId: npc.fetchSelfId(), isCurrent: run.owner.isCurrent });
    if (reason) throw fault(reason, 409);
    if (npc.fetchSelfId() === require('../../Lord/CastellanAccess').npcId) throw fault('owner_only_service', 409);
    return npc;
}
function* shopRows(session, selling) {
    if (selling) {
        for (const [objectId, quote] of session.activeNpcSellShop.items) yield { type: 'sell', objectId, selfId: quote.selfId, price: quote.price,
            display: { objectId, templateId: quote.selfId, unitPrice: quote.price } };
    } else for (const [selfId, price] of session.activeNpcShop.prices) yield { type: 'buy', selfId, price,
        display: { templateId: selfId, unitPrice: price } };
}
function warehouseRows(items, mode) {
    return function* () {
        for (const item of items) yield { type: 'warehouse', mode, objectId: item.fetchId(), selfId: item.fetchSelfId(),
            amount: item.fetchAmount(), display: { objectId: item.fetchId(), templateId: item.fetchSelfId(),
                name: String(item.fetchName()).slice(0, 64), amount: item.fetchAmount(), mode } };
    };
}
async function warehouseWindow(run, mode, operation) {
    const { session, actor } = run;
    const Personal = require('../../Warehouse/PersonalWarehouse'), Clan = require('../../Warehouse/ClanWarehouse');
    operation.check(); contact(run);
    if (!Personal.isWarehouseNpc(session)) throw fault('warehouse_npc_required', 409);
    const clanMode = mode.startsWith('clan-'), action = mode.endsWith('deposit') ? 'deposit' : 'withdraw';
    let clan = null;
    if (clanMode) {
        clan = Clan.clanFor(session);
        if (action === 'withdraw' && !Clan.canView(session, clan)) throw fault('clan_warehouse_privilege', 409);
    }
    const items = action === 'deposit' ? actor.backpack.fetchItems()
        : clanMode ? await Clan.list(clan.id) : await Personal.list(session);
    operation.check(); contact(run);
    if (items.length > 256) throw fault('native_service_catalog_budget', 429);
    if (clanMode && Clan.clanFor(session) !== clan) throw fault('clan_changed', 409);
    session.activeWarehouse = clanMode ? { type: 'clan', mode: action, clanId: clan.id } : { type: 'personal', mode: action };
    Offers.open(session, 'warehouse', warehouseRows(items, mode));
    operation.begin(); operation.complete({ mode }, 'warehouse_opened', 'native_context_ready');
}
function showHtml(run, npc, html, source) {
    const Response = invoke('GameServer/Network/Response');
    require('./Journal').dialogue(run.session, npc.fetchId(), html, source);
    run.session.dataSendToMe(Response.npcHtml(npc.fetchId(), html));
    run.session.dataSendToMe(Response.actionFailed());
}
async function choice(run, context, row, amount, operation) {
    const { session, actor } = run, npc = contact(run), npcId = npc.fetchSelfId();
    if (row.type !== 'buy' && row.type !== 'sell' && row.type !== 'warehouse' && row.type !== 'multisell' && amount !== 1)
        throw fault('quantity_not_applicable', 409);
    if (row.type === 'buy_window' || row.type === 'sell_window') {
        if (!require('../../World/Generics/NpcShopBuyLists').fetchForNpc(npcId).length || row.type === 'buy_window' && row.list !== 'npc')
            throw fault('native_bound_shop_required', 409);
        operation.begin();
        if (row.type === 'buy_window') invoke('GameServer/World/Generics/NpcBypasses/BuyShop')(session, ['buy-shop', 'npc']);
        else invoke('GameServer/World/Generics/NpcBypasses/SellShop')(session);
        Offers.open(session, 'shop', () => shopRows(session, row.type === 'sell_window'));
        operation.complete({ mode: row.type }, 'shop_opened', 'native_context_ready');
    } else if (row.type === 'buy') {
        const shop = session.activeNpcShop;
        if (!shop || shop.npcSelfId !== npcId || !shop.itemIds.has(row.selfId) || shop.prices.get(row.selfId) !== row.price
            || !Number.isSafeInteger(row.price * amount)) throw fault('shop_quote_changed', 409);
        if (!Number.isSafeInteger(row.price) || row.price < 0) throw fault('native_quote_invalid', 409);
        const template = require('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, row.selfId);
        if (!template || !Number.isFinite(template.template.mass)) throw fault('native_item_template_unavailable', 409);
        if (!template.etc.stackable && amount !== 1) throw fault('nonstackable_quantity_requires_one', 409);
        const stack = template.etc.stackable && actor.backpack.fetchItemFromSelfId(row.selfId);
        if (!stack && actor.backpack.fetchItems().length >= require('../../Inventory/InventoryLimits').forActor(actor)) throw fault('inventory_full', 409);
        if (actor.backpack.fetchTotalLoad() + template.template.mass * amount > actor.fetchMaxLoad()) throw fault('weight_limit', 409);
        if (actor.backpack.fetchTotalAdena() < row.price * amount) throw fault('insufficient_adena', 409);
        await World.purchaseItems(session, [{ selfId: row.selfId, amount }], { prices: shop.prices, operation });
        Offers.clear(session);
    } else if (row.type === 'sell') {
        const shop = session.activeNpcSellShop, item = actor.backpack.fetchItemRaw(row.objectId), quote = shop?.items.get(row.objectId);
        if (!shop || shop.npcSelfId !== npcId || quote?.selfId !== row.selfId || quote?.price !== row.price || !item || amount > item.fetchAmount())
            throw fault('sale_quote_changed', 409);
        await invoke('GameServer/Network/Request/Sell').sellToNpcShop(session, [{ objectId: row.objectId, selfId: row.selfId, amount }], { operation });
        Offers.clear(session);
    } else if (row.type === 'warehouse_window') await warehouseWindow(run, row.mode, operation);
    else if (row.type === 'warehouse') {
        if (amount > row.amount) throw fault('warehouse_quantity_changed', 409);
        const clan = row.mode.startsWith('clan-'), mode = row.mode.endsWith('deposit') ? 'deposit' : 'withdraw';
        if (session.activeWarehouse?.mode !== mode || (session.activeWarehouse.type === 'clan') !== clan) throw fault('warehouse_context_changed', 409);
        const service = clan ? require('../../Warehouse/ClanWarehouse') : require('../../Warehouse/PersonalWarehouse');
        await service[mode](session, [{ objectId: row.objectId, amount }], { operation });
        Offers.clear(session);
    } else if (row.type === 'multisell_window') {
        const Catalog = require('../../World/Generics/NpcExchangeShopLists');
        if (row.listId !== npcId || !Catalog.fetchForNpc(npcId).length) throw fault('multisell_npc_mismatch', 409);
        operation.begin(); require('../../Items/LuxuryShopService').open(session, row.listId);
        Offers.open(session, 'multisell', function* () {
            let index = 0;
            for (const recipe of Catalog.fetchForNpc(npcId)) yield { type: 'multisell', listId: npcId, entryId: ++index * 100000,
                display: { entryId: index * 100000, result: recipe.result, required: recipe.required } };
        });
        operation.complete({ listId: npcId }, 'multisell_opened', 'native_context_ready');
    } else if (row.type === 'multisell') {
        await require('../../Items/LuxuryShopService').exchange(session, row.listId, row.entryId, amount, { operation });
        Offers.clear(session);
    } else if (row.type === 'gatekeeper_window') {
        const html = require('../../World/C4GatekeeperTeleports').html(npcId);
        if (!html) throw fault('gatekeeper_unavailable', 409);
        operation.begin(); showHtml(run, npc, html, 'native_gatekeeper_offers'); operation.complete({ npcId }, 'travel_menu_opened');
    } else if (row.type === 'gatekeeper') {
        operation.begin();
        await new Promise((resolve, reject) => {
            const result = require('../../World/GatekeeperService').teleport(session, { actor, npc, npcObjectId: npc.fetchId(), npcId,
                destinationId: row.destinationId, expected: row.expected, isCurrent: run.owner.isCurrent, actionOwner: run.owner,
                onPaid: paidFare => operation.applied({ paidFare }, 'live_applied_persistence_queued'),
                onArrival: coords => { operation.complete({ destination: coords, teleportSequence: actor.teleportSequence }, 'native_teleport_arrived', 'live_applied_persistence_queued'); resolve(); },
                onInterrupted: reason => reject(Error(reason)) });
            run.receipt.evidence.travel = { status: result.status, reason: result.reason, paidFare: result.paidFare,
                paymentUncertain: !!result.paymentUncertain, sequence: result.sequence };
            run.receipt.sideEffects.paidFare = result.paidFare;
            if (result.status !== 'accepted') {
                if (result.status === 'refused') operation.rolledBack();
                reject(fault(result.reason || 'teleport_failed', 409));
            }
        });
        Offers.clear(session);
    } else if (row.type === 'quest' || row.type === 'quest_window') {
        const Quest = require('../../Quest/QuestService');
        const handled = row.type === 'quest' ? await Quest.onEvent(session, { questId: row.questId, name: row.event }, { operation })
            : await Quest.onTalk(session, npc, { operation });
        if (!handled) { if (run.nativeStarted) operation.complete({ handled: false }, 'native_unhandled'); return; }
        operation.complete({ handled: true, questId: row.questId || null }, 'native_quest_response');
    } else if (row.type === 'html') {
        const questPage = /^(\d+)-quest$/.exec(row.page);
        if (questPage) {
            if (Number(questPage[1]) !== npcId) throw fault('quest_npc_changed', 409);
            return choice(run, context, { type: 'quest_window' }, 1, operation);
        }
        const filename = `data/Html/${row.page}.html`;
        if (!utils.fileExists(filename)) throw fault('native_page_unavailable', 409);
        operation.begin(); showHtml(run, npc, utils.parseRawFile(filename), 'native_linked_html'); operation.complete({ page: row.page }, 'native_page_opened');
    } else throw fault('native_adapter_unavailable', 409);
}
function summonSkill(run) {
    const { actor, session, input: { command } } = run, Control = invoke('GameServer/Npc/SummonControl');
    const summon = Control.activeSummon(actor);
    if (!summon || !command.skillId) throw fault('summon_skill_required', 409);
    const config = Control.skillActions(summon).find(row => row.skillId === command.skillId && row.target !== 'corpse');
    if (!config) throw fault('summon_skill_adapter_unavailable', 409);
    const legal = run.owner.controller.legalTarget;
    const owner = { ...run.owner, controller: { ...run.owner.controller,
        allowsSkill: skill => skill.fetchSelfId() === command.skillId,
        legalActionTarget: (value, skill) => skill.fetchSelfId() === command.skillId &&
            (config.target === 'self' ? value === summon : config.target === 'owner' ? value === actor : legal(value)) } };
    let target = null;
    if (command.targetId) {
        target = require('../../World/NpcObjectIndex').find(World, command.targetId);
        if (!target || !legal(target)) throw fault('native_target_ineligible', 409);
    }
    run.summon = summon; run.summonOwner = owner; run.lookupPending = true;
    if (!Control.useSkillAction(session, actor, summon, config.actionId, { actionOwner: owner, target })) throw fault('summon_skill_unavailable', 409);
}
function start(run) {
    const { command } = run.input;
    if (command.kind === 'summon' && command.command === 'skill') { summonSkill(run); return true; }
    if (!['interact', 'service', 'craft', 'drop', 'chat', 'party', 'pet_inventory'].includes(command.kind)
        && !(command.kind === 'summon' && ['unsummon', 'mount', 'dismount'].includes(command.command))) return false;
    let selected = null;
    if (command.kind === 'service') {
        selected = Offers.take(run.session, command.revision, command.offerId);
        run.validateAdmission = () => {
            if (run.session.activeNpcTalk !== selected.context.talk) throw fault('npc_context_changed', 409);
            contact(run, selected.context.npc);
        };
    }
    require('./NativeOperation').execute(run, async operation => {
        const { actor, session } = run;
        if (command.kind === 'service') {
            if (!Offers.valid(session, selected.context)) throw fault('offer_context_changed', 409);
            await choice(run, selected.context, selected.row, command.amount, operation);
        } else if (command.kind === 'interact') {
            if (command.npc.kind !== 'npc') throw fault('npc_required', 409);
            const npc = require('./Queries').resolve(actor, command.npc); contact(run, npc);
            run.validateAdmission = () => contact(run, npc);
            Offers.clear(session);
            await World.npcTalk(session, npc, { operation });
            operation.begin(); operation.complete({ npcId: npc.fetchSelfId(), objectId: npc.fetchId(),
                readablePage: session.mcpObservation?.dialogue?.objectId === npc.fetchId() }, 'native_contact_finished');
        } else if (command.kind === 'craft') {
            await require('../../Crafting/RecipeCrafting').craftSelf(session, command.recipeId, Math.random, { operation });
        } else if (command.kind === 'drop') {
            const item = actor.backpack.fetchItemRaw(command.itemId);
            if (!item || item.fetchEquipped() || item.fetchPetLocked?.() || command.amount > item.fetchAmount()) throw fault('drop_item_unavailable', 409);
            const before = item.fetchAmount();
            operation.begin(); let result = null;
            actor.backpack.dropItem(session, command.itemId, command.amount, actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ(), value => { result = value; });
            if (!result) {
                const after = actor.backpack.fetchItemRaw(command.itemId)?.fetchAmount() || 0;
                if (after !== before) { operation.applied({ itemId: command.itemId, before, after }, 'live_applied_persistence_queued'); operation.uncertain('drop_spawn_unconfirmed'); }
                else operation.rolledBack();
                return;
            }
            operation.complete(result, 'native_drop_spawned', 'live_applied_persistence_queued');
        } else if (command.kind === 'chat') {
            if (!command.text.trim()) throw fault('empty_speech', 409);
            if (/^[./]/.test(command.text.trim())) throw fault('chat_commands_unavailable', 409);
            if (command.channel === 'clan' && !actor.fetchClanId?.()) throw fault('clan_required', 409);
            operation.begin();
            await invoke('GameServer/Network/Request/Speak').consume(session, { kind: command.channel === 'clan' ? 4 : 0, text: command.text });
            operation.complete({ channel: command.channel }, 'native_speech_dispatched', 'not_applicable');
        } else if (command.kind === 'pet_inventory') {
            const Inventory = invoke('GameServer/Pets/PetInventory');
            if (command.operation === 'use') {
                if (command.amount !== 1) throw fault('quantity_not_applicable', 409);
                await Inventory.use(session, command.itemId, { operation });
            } else await Inventory.transfer(session, command.itemId, command.amount, command.operation, { operation });
        } else if (command.kind === 'summon') {
            const summon = actor.summon || actor.pet;
            if (!summon || !invoke('GameServer/Effects/EffectRestrictions').canUseBasicAction(actor)) throw fault('summon_unavailable', 409);
            const mounted = actor.fetchMounted?.() || actor.mounted;
            if (command.command === 'mount' && mounted || command.command === 'dismount' && !mounted) throw fault('mount_state_unchanged', 409);
            operation.begin();
            invoke(path.actor).basicAction(session, actor, { actionOwner: run.owner, controlOperation: operation,
                actionId: command.command === 'unsummon' ? (summon.fetchIsPet?.() ? 0x13 : 0x34) : 0x26 });
            const changed = command.command === 'unsummon' ? actor.summon !== summon && actor.pet !== summon
                : !!(actor.fetchMounted?.() || actor.mounted) === (command.command === 'mount');
            if (!changed) { operation.rolledBack(); return; }
            operation.applied({ command: command.command, summonId: summon.fetchId() }, 'live_applied_persistence_queued');
            await summon.teardownTail;
            operation.complete({ command: command.command, summonId: summon.fetchId() }, 'summon_state_changed', 'live_applied_persistence_queued');
        } else if (command.kind === 'party') {
            const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
            if (command.operation === 'leave') {
                const leader = session.followPlayerSession;
                if (!leader || !Party.isActiveCompanion(session, leader)) throw fault('not_a_party_companion', 409);
                operation.begin();
                const detached = await Party.detach(leader, session, { source: 'mcp_native_leave' });
                operation.complete({ detached, member: session.partyCompanion === true }, detached ? 'party_left' : 'native_refused', 'native_context_ready');
            } else if (command.operation === 'accept') {
                const pending = session.pendingPartyInvite;
                if (!pending) throw fault('no_native_invitation', 409);
                operation.begin();
                const accepted = await World.answerForTeamUp(session, actor, { id: 1 }, { isCurrent: run.owner.isCurrent, actionOwner: run.owner });
                operation.complete({ accepted, member: session.followPlayerSession === pending.requestorSession && session.partyCompanion === true },
                    accepted ? 'party_joined' : 'native_refused', 'native_context_ready');
            } else if (command.operation === 'distribution') {
                if (command.distribution === undefined || session.partyCompanion) throw fault('native_party_leader_required', 409);
                operation.begin(); Party.syncClientDistribution(session, command.distribution);
                operation.complete({ distribution: Party.distributionForLeader(session) }, 'party_distribution_set', 'native_context_ready');
            } else {
                if (!command.target || command.target.kind !== 'actor') throw fault('party_target_required', 409);
                const other = require('./Queries').resolve(actor, command.target), record = World.registeredActorById(other.fetchId());
                if (!record || record.session === session || record.session.botSession !== true) throw fault('live_bot_required', 409);
                if (command.operation === 'kick') {
                    if (!Party.isActiveCompanion(record.session, session)) throw fault('native_party_leader_required', 409);
                    operation.begin(); const detached = await Party.detach(session, record.session, { source: 'mcp_native_kick' });
                    operation.complete({ detached, member: Party.isActiveCompanion(record.session, session) }, 'native_party_result', 'native_context_ready');
                } else {
                    if (invoke('GameServer/Bot/Economy/BotMerchantStoreService').needsPartyWithdrawal(record.session)) throw fault('native_custody_busy', 409);
                    operation.begin();
                    const accepted = await World.inviteBotCompanion(session, actor, record.session, command.distribution, 'mcp_native_invite',
                        { isCurrent: run.owner.isCurrent, actionOwner: run.owner });
                    operation.complete({ accepted, member: Party.isActiveCompanion(record.session, session) }, accepted ? 'party_joined' : 'native_refused', 'native_context_ready');
                }
            }
        }
    });
    return true;
}
module.exports = { start, contact };
