const Access = require('./CastellanAccess');
const Lords = require('./LordService');
const Registry = require('./VassalService');
const Kits = require('./StarterKits');
const Areas = require('./GatherAreas');
const Progression = require('../ClassProgression');
const Html = require('../World/Generics/HtmlKit');
const Database = invoke('Database');
const Response = invoke('GameServer/Network/Response');
const PAGE_SIZE = 6;
const RACES = ['Human', 'Elf', 'Dark Elf', 'Orc', 'Dwarf'];
const link = (label, command = '') => Html.link(label, `castellan${command ? ' ' + command : ''}`) + '<br1>';
const back = () => '<br>' + link('Castellan menu');
const className = id => invoke('GameServer/DataCache').classTemplates.find(row => Number(row.classId) === Number(id))?.template.class || `Class ${id}`;
const preference = value => value === undefined || value === '-' ? null : value;
const number = value => /^\d+$/.test(value || '') && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;

const ERRORS = {
    lord_actor_unavailable: 'Your character must be alive, outside combat/trade, not casting and not running a private store.',
    lord_actor_changed: 'Your character changed during the request. Please select the action again.',
    castellan_required: 'Speak to Castellan in Gludio first.',
    castellan_too_far: 'Come closer to Castellan.',
    not_lord: 'Become a Lord first.',
    invalid_lord_owner: 'This character cannot use Lord services.',
    not_eligible_clan_leader: 'You must lead an active clan (level 1 for vassal creation), without a clan penalty.',
    clan_grant_consumed: 'Your free clan grant has already been used.',
    clan_cooldown: 'Your clan cooldown has not expired.',
    clan_full: 'Your clan is full. No vassal was created.',
    name_too_short: 'Use 2-16 letters or digits for the clan name.',
    name_too_long: 'Use 2-16 letters or digits for the clan name.',
    name_invalid: 'Use only Latin letters and digits for the clan name.',
    creation_confirmation_expired: 'This creation confirmation expired. Select the vassal again.',
    invalid_vassal_selection: 'Invalid vassal selection. Start the selection again.',
    invalid_first_profession: 'Select a legal first profession.',
    invalid_loadout: 'Select a legal weapon preference.',
    not_owned_vassal: 'That vassal does not belong to this character.',
    vassal_order_changed: 'The order changed. Reopen the roster before issuing a new order.',
    vassal_in_party: 'Dismiss this vassal from its party before changing its duty.',
    vassal_clan_ineligible: 'Owner and vassal must still belong to the original active level-1+ clan led by the owner.',
    unsuitable_gather_area: 'This area is not suitable for the vassal level.',
    invalid_vassal_order: 'Invalid order.',
    invalid_castellan_request: 'This dialog is no longer valid. Select an action again.',
    warehouse_privilege_required: 'Clan warehouse viewing privilege is required.',
    'a level 1 clan is required': 'Join or create a level-1+ clan before using clan storage.'
};

function clan(session) { return invoke('GameServer/Clan/ClanService').clanForActor(session.actor); }
function eligibleCreator(session) {
    if (!Registry.isLord(session.actor.fetchId())) throw Error('not_lord');
    const current = clan(session);
    if (!current || Number(current.level) < 1 || Number(current.leaderId) !== Number(session.actor.fetchId())
        || Number(current.dissolvingExpiryTime) > Date.now() || Number(current.charPenaltyExpiryTime) > Date.now()) throw Error('not_eligible_clan_leader');
    return current;
}
function selection(race, sex, baseClassId = null, firstClassId = null) {
    const Data = invoke('GameServer/DataCache');
    if (!RACES[race] || ![0, 1].includes(sex)) throw Error('invalid_vassal_selection');
    if (baseClassId !== null) {
        const base = Data.classTemplates.find(row => Number(row.classId) === baseClassId);
        if (!base || Number(base.template.race) !== race || !Progression.firstProfMap[baseClassId]) throw Error('invalid_vassal_selection');
        if (firstClassId !== null && !Progression.firstProfMap[baseClassId].includes(firstClassId)) throw Error('invalid_first_profession');
    }
}
function owned(session, id) {
    const row = Registry.find(id);
    if (!row || !Registry.owns(session.actor.fetchId(), id)) throw Error('not_owned_vassal');
    return row;
}
async function characters(session) {
    const ids = new Set(Registry.roster(session.actor.fetchId()).map(row => row.characterId));
    return (await Database.fetchOwnedVassalCharacters()).filter(row => ids.has(Number(row.id)));
}
function live(id) { return invoke('GameServer/Bot/BotManager').sessions.find(row => Number(row.actor?.fetchId()) === Number(id)); }
function roleName(classId, saved) {
    return Kits.MIXED_CLASSES.has(Number(classId)) && saved.loadoutPreference
        ? saved.loadoutPreference === 'bow' ? 'archer' : 'dagger'
        : invoke('GameServer/Bot/AI/BotRoles').inferRole(Number(classId));
}
function pageNumber(value) {
    const page = value === undefined ? 0 : number(value);
    if (!Number.isSafeInteger(page) || page < 0) throw Error('invalid_castellan_request');
    return page;
}
function publication(result, success) {
    return success + (result.publicationPending
        ? '<br>The operation is committed, but live publication is pending. Retry the same action/confirmation to reload it; do not create a replacement.' : '');
}
function home(session) {
    const lord = Registry.isLord(session.actor.fetchId()), current = clan(session);
    return `${lord ? 'Lord status: active' : 'Welcome to Gludio.'}<br>`
        + (current ? `Clan: ${Html.esc(current.name)} (level ${Number(current.level)})<br>` : 'No clan.<br>')
        + '<br>' + link(lord ? 'Reload Lord grant (no new rewards)' : 'Become a Lord', 'enroll')
        + link('Create / raise clan to level 1', 'clan')
        + link('Create a vassal', 'create') + link('My vassals', 'roster')
        + link('Clan warehouse', 'warehouse') + link('Buy supplies', 'shop')
        + '<br>Physical duties and party integration arrive in P3. Orders saved here do not yet start autonomous travel or gathering.';
}
function enrollment(session, target = null, loadout = null) {
    const source = Number(session.actor.fetchClassId());
    if (Registry.isLord(session.actor.fetchId())) return link('Reload committed grant', `enroll-apply ${source} -`) + back();
    const choices = Progression.firstProfMap[source];
    if (choices && target === null) return 'Select your first profession:<br>'
        + choices.map(id => link(className(id), `enroll ${id}`)).join('') + back();
    target ??= source;
    if (choices ? !choices.includes(target) : target !== source) throw Error('invalid_first_profession');
    if (Kits.MIXED_CLASSES.has(target) && loadout === null) return 'Select your weapon (profession unchanged):<br>'
        + ['bow', 'dagger'].map(kind => link(kind, `enroll ${target} ${kind}`)).join('') + back();
    Kits.loadout(target, loadout);
    return `Become a Lord as ${Html.esc(className(target))}${loadout ? ' (' + loadout + ')' : ''}?<br>`
        + 'Once per character: at least level 20 (never lowered), legal first profession only if still a beginner, level-20 skills, top-D equipment and supplies, 1,000,000 Adena.<br>'
        + 'Existing items and higher professions remain. Reward gear is added unequipped. Repeating this action never grants a second reward.<br><br>'
        + link('Confirm Lord enrollment', `enroll-apply ${target} ${loadout || '-'}`) + back();
}
function creationConfirmation(session, race, sex, baseClassId, firstClassId, loadoutPreference) {
    selection(race, sex, baseClassId, firstClassId);
    if (Kits.MIXED_CLASSES.has(firstClassId) && loadoutPreference === null) return 'Select your vassal weapon:<br>'
        + ['bow', 'dagger'].map(kind => link(kind, `create-class ${race} ${sex} ${baseClassId} ${firstClassId} ${kind}`)).join('') + back();
    const confirmation = Lords.issueCreationConfirmation(session, { race, sex, baseClassId, firstClassId, loadoutPreference });
    return `Create ${RACES[race]}, ${sex ? 'female' : 'male'}, ${Html.esc(className(firstClassId))}${loadoutPreference ? ' (' + loadoutPreference + ')' : ''}?<br>`
        + 'Free level-20 vassal, mid-D equipment, learned starter skills, supplies and 100,000 Adena. A generated name and one clan slot will be used.<br>'
        + 'This confirmation expires in 10 minutes. Retrying it after success returns the same vassal.<br><br>'
        + link('Confirm creation', `create-confirm ${confirmation.id}`) + back();
}
async function roster(session, page) {
    const rows = (await characters(session)).sort((a, b) => Number(a.id) - Number(b.id));
    const start = page * PAGE_SIZE;
    if (page > 0 && start >= rows.length) throw Error('invalid_castellan_request');
    return `Owned vassals: ${rows.length}<br>` + rows.slice(start, start + PAGE_SIZE).map(row => {
        const saved = owned(session, row.id), bot = live(row.id);
        const area = saved.areaId ? Areas.find(saved.areaId)?.name || saved.areaId : null;
        const classId = bot?.actor?.fetchClassId() ?? row.classId;
        return link(`${row.name} - Lv ${bot?.actor?.fetchLevel() ?? row.level} ${className(classId)} (${roleName(classId, saved)})`, `vassal ${row.id}`)
            + `${Html.esc(saved.order)}${area ? ': ' + Html.esc(area) : ''}${bot?.partyCompanion ? ' (in party)' : ''}<br>`;
    }).join('') + (page > 0 ? link('Previous', `roster ${page - 1}`) : '')
        + (start + PAGE_SIZE < rows.length ? link('Next', `roster ${page + 1}`) : '') + back();
}
async function vassal(session, id) {
    const row = owned(session, id), character = (await characters(session)).find(entry => Number(entry.id) === id);
    if (!character) throw Error('not_owned_vassal');
    const bot = live(id), level = bot?.actor?.fetchLevel() ?? character.level;
    const busy = !!(bot?.partyCompanion || bot?.hotBackgroundPartyId || bot?.followPlayerSession);
    const classId = bot?.actor?.fetchClassId() ?? character.classId;
    return `${Html.esc(character.name)} - Lv ${level} ${Html.esc(className(classId))}<br>`
        + `Role: ${Html.esc(roleName(classId, row))}<br>`
        + `Duty: ${Html.esc(row.order)}; revision ${row.orderRevision}<br>`
        + (row.areaId ? `Area: ${Html.esc(Areas.find(row.areaId)?.name || row.areaId)}<br>` : '')
        + (row.loadoutPreference ? `Weapon: ${Html.esc(row.loadoutPreference)}<br>` : '')
        + (row.gatherResumePending ? 'Gather resumption pending after party interruption.<br>' : '')
        + (busy ? 'Dismiss from the party before issuing a duty.<br>' : '<br>'
            + link('Gather resources...', `areas ${id} ${row.orderRevision}`)
            + link('Return to Castellan', `order ${id} ${row.orderRevision} return`)
            + link('End gathering / stay in service', `order ${id} ${row.orderRevision} service`))
        + '<br>Physical execution is pending P3.<br>' + link('My vassals', 'roster') + back();
}
async function areas(session, id, revision) {
    const row = owned(session, id);
    if (row.orderRevision !== revision) throw Error('vassal_order_changed');
    const character = (await characters(session)).find(entry => Number(entry.id) === id);
    const level = live(id)?.actor?.fetchLevel() ?? character?.level;
    return `Gather destination (vassal level ${Number(level)}):<br>` + Areas.list().map(area => {
        const label = `${area.name} (monsters ${area.minLevel}-${area.maxLevel})`;
        return Areas.suitable(area, level) ? link(label, `order ${id} ${revision} gather ${area.id}`) : `${Html.esc(label)} - unsuitable<br>`;
    }).join('') + '<br>Only the selected territory is authorized. Target safety and physical travel are implemented in P3.<br>'
        + link('Vassal', `vassal ${id}`) + back();
}
async function warehouse(session, page = null) {
    const Store = invoke('GameServer/Warehouse/ClanWarehouse');
    const current = Store.clanFor(session);
    if (page === null) return `Clan warehouse: ${Html.esc(current.name)}<br>`
        + link('Deposit items', 'warehouse-deposit')
        + (Store.canView(session, current) ? link('View stored items', 'warehouse-view') : 'Viewing requires the clan warehouse privilege.<br>')
        + (Store.canWithdraw(session, current) ? link('Withdraw items (leader)', 'warehouse-withdraw') : '') + back();
    if (!Store.canView(session, current)) throw Error('warehouse_privilege_required');
    const rows = await Store.list(current.id), start = page * PAGE_SIZE;
    if (page > 0 && start >= rows.length) throw Error('invalid_castellan_request');
    return `Stored items: ${rows.length}<br>` + rows.slice(start, start + PAGE_SIZE)
        .map(item => `${Html.esc(item.fetchName())} x ${item.fetchAmount()}<br>`).join('')
        + (page > 0 ? link('Previous', `warehouse-view ${page - 1}`) : '')
        + (start + PAGE_SIZE < rows.length ? link('Next', `warehouse-view ${page + 1}`) : '')
        + link('Warehouse', 'warehouse') + back();
}

async function handle(session, parts) {
    const actor = session.actor, objectId = session.activeNpcTalk?.objectId;
    const serial = session.castellanDialogRevision = Number(session.castellanDialogRevision || 0) + 1;
    const active = () => session.actor === actor && session.activeNpcTalk?.objectId === objectId
        && session.castellanDialogRevision === serial;
    const send = body => {
        if (!active()) return;
        session.dataSendToMe(Response.npcHtml(objectId, `<html><body>Castellan:<br>${body}</body></html>`));
        session.dataSendToMe(Response.actionFailed());
    };
    try {
        await Registry.init();
        Access.requireContact(session, actor);
        const [command = 'menu', ...args] = parts.slice(1);
        const arity = (min, max = min) => { if (args.length < min || args.length > max) throw Error('invalid_castellan_request'); };
        let body;
        switch (command) {
            case 'menu': arity(0); body = home(session); break;
            case 'enroll': arity(0, 2); body = enrollment(session, args[0] === undefined ? null : number(args[0]), preference(args[1])); break;
            case 'enroll-apply': {
                arity(2);
                const result = await Lords.enroll(session, { firstClassId: number(args[0]), loadoutPreference: preference(args[1]) });
                body = publication(result, 'Lord enrollment is committed. No duplicate rewards on retry.') + back(); break;
            }
            case 'clan':
                arity(0);
                if (!Registry.isLord(actor.fetchId())) throw Error('not_lord');
                body = 'Free clan level 1, once per Lord. An existing level-0 clan must be led by you; a level-1+ clan is not replaced.<br>'
                    + '<br>New clan name (2-16 Latin letters/digits):<br><edit var="name" width=120 height=15><br>'
                    + '<button value="Create" action="bypass -h castellan clan-apply $name" width=80 height=21 back="L2UI_ch3.Btn1_normalOn" fore="L2UI_ch3.Btn1_normal"><br>'
                    + link('Raise / reload my existing clan', 'clan-apply') + back(); break;
            case 'clan-apply': {
                arity(0, 1); const result = await Lords.ensureClan(session, args[0]);
                body = publication(result, 'Clan level 1 is available.') + back(); break;
            }
            case 'create':
                arity(0); eligibleCreator(session);
                body = 'Select race:<br>' + RACES.map((race, id) => link(race, `create-race ${id}`)).join('') + back(); break;
            case 'create-race': {
                arity(1); eligibleCreator(session); const race = number(args[0]); selection(race, 0);
                body = `${RACES[race]} - select sex:<br>` + link('Male', `create-sex ${race} 0`) + link('Female', `create-sex ${race} 1`) + back(); break;
            }
            case 'create-sex': {
                arity(2); eligibleCreator(session); const [race, sex] = args.map(number); selection(race, sex);
                body = 'Select base class:<br>' + invoke('GameServer/DataCache').classTemplates
                    .filter(row => Number(row.template.race) === race && Progression.firstProfMap[row.classId])
                    .map(row => link(row.template.class, `create-base ${race} ${sex} ${row.classId}`)).join('') + back(); break;
            }
            case 'create-base': {
                arity(3); eligibleCreator(session); const [race, sex, base] = args.map(number); selection(race, sex, base);
                body = 'Select first profession:<br>' + Progression.firstProfMap[base]
                    .map(id => link(className(id), `create-class ${race} ${sex} ${base} ${id}`)).join('') + back(); break;
            }
            case 'create-class': {
                arity(4, 5); eligibleCreator(session); const [race, sex, base, first] = args.slice(0, 4).map(number);
                body = creationConfirmation(session, race, sex, base, first, preference(args[4])); break;
            }
            case 'create-confirm': {
                arity(1); const result = await Lords.confirmCreation(session, args[0]);
                body = publication(result, `Vassal ${Html.esc(result.character.name)} is committed${result.replayed ? ' (same confirmation)' : ''}.`)
                    + link('Reload this confirmation', `create-confirm ${args[0]}`) + link('My vassals', 'roster') + back(); break;
            }
            case 'roster': arity(0, 1); body = await roster(session, pageNumber(args[0])); break;
            case 'vassal': arity(1); body = await vassal(session, number(args[0])); break;
            case 'areas': arity(2); body = await areas(session, number(args[0]), number(args[1])); break;
            case 'order': {
                arity(3, 4);
                const row = await Registry.issueOrder(session, { characterId: number(args[0]), revision: number(args[1]), order: args[2], areaId: args[3] ?? null });
                body = 'Order saved. Physical duty execution is pending P3.<br>' + link('Vassal', `vassal ${row.characterId}`) + back(); break;
            }
            case 'warehouse': arity(0); body = await warehouse(session); break;
            case 'warehouse-view': arity(0, 1); body = await warehouse(session, pageNumber(args[0])); break;
            case 'warehouse-deposit': case 'warehouse-withdraw':
                arity(0);
                if (command === 'warehouse-withdraw' && !invoke('GameServer/Warehouse/ClanWarehouse').canWithdraw(session)) throw Error('warehouse_privilege_required');
                return await invoke('GameServer/World/Generics/NpcBypasses/Warehouse')(session, ['warehouse', command === 'warehouse-deposit' ? 'clan-deposit' : 'clan-withdraw']);
            case 'shop':
                arity(0); return invoke('GameServer/World/Generics/NpcBypasses/BuyShop')(session, ['buy-shop', 'npc']);
            default: throw Error('invalid_castellan_request');
        }
        // Async reads must not publish into another NPC/character dialog.
        Access.requireContact(session, actor);
        send(body);
    } catch (error) {
        const message = ERRORS[error.message] || (/UNIQUE constraint failed: clans\.name/i.test(error.message)
            ? 'That clan name is already taken.' : 'Request could not be completed or displayed. Reopen the dialog or retry the same action/confirmation to reload its result.');
        if (active()) {
            if (Number(session.activeNpcTalk?.selfId) === Access.npcId) send(Html.esc(message) + back());
            else session.dataSendToMe(Response.actionFailed());
        }
        utils.infoWarn('Castellan', 'request rejected: %s', error.message);
    }
}
module.exports = { handle };
