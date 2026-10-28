const ServerResponse = invoke('GameServer/Network/Response');

function npcTalk(session, npc, options = {}) {
    options.operation?.check();
    if (session.mcpObservation) require('../../Bot/Control/Offers').clear(session);
    const title = npc.fetchTitle?.() || '';

    session.activeNpcShop = null;
    session.activeNpcSellShop = null;
    session.activeMultiSell = null;
    session.activeWarehouse = null;
    session.activePetExchange = null;
    session.activeWeaponSA = null;
    session.activeCrystallization = null;
    session.activeNpcTalk = {
        selfId: npc.fetchSelfId(),
        objectId: npc.fetchId(),
        name: npc.fetchName(),
        title
    };
    if (session.mcpObservation) {
        session.mcpObservation.dialogue = null;
        session.mcpObservation.emit('npc_contact', 'native_npc_talk', session.activeNpcTalk);
    }

    if (Number(npc.fetchSelfId()) === require('../../Lord/CastellanAccess').npcId) {
        return invoke('GameServer/World/Generics/NpcBypasses/Castellan')(session, ['castellan']);
    }

    const ClanHallNpc = require('../../ClanHall/Npc');
    if (ClanHallNpc.handles(npc.fetchSelfId())) {
        return ClanHallNpc.render(session).catch(error => {
            if (options.operation) throw error;
            utils.infoWarn('ClanHall', 'NPC dialog failed: %s', error.message);
        });
    }

    if (Number(npc.fetchSelfId()) === require('../GiranCrystallizationStation').npcId) {
        return invoke('GameServer/World/Generics/NpcBypasses/CrystallizationStation')(session, ['crystallization-station']);
    }

    if (Number(npc.fetchSelfId()) === 8126) {
        invoke('GameServer/Items/MammonUnsealService').menu(session);
        return;
    }

    // The C4 Arena Manager is a normal warehouse-shaped NPC in the source
    // datapack, but this server exposes the duel menu through a runtime
    // service. Keep it ahead of generic warehouse/quest routing.
    if (Number(npc.fetchSelfId?.()) === 8225) {
        invoke('GameServer/World/ArenaDuelService').render(session);
        return;
    }

    const CrumaTowerTeleports = invoke('GameServer/World/C4CrumaTowerTeleports');
    const crumaTowerTeleportHtml = CrumaTowerTeleports.html(npc.fetchSelfId());
    if (crumaTowerTeleportHtml) {
        session.dataSendToMe(ServerResponse.npcHtml(npc.fetchId(), crumaTowerTeleportHtml));
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const SevenSignsDungeonTeleports = invoke('GameServer/World/C4SevenSignsDungeonTeleports');
    const dungeonTeleportHtml = SevenSignsDungeonTeleports.html(npc.fetchSelfId());
    if (dungeonTeleportHtml) {
        session.dataSendToMe(ServerResponse.npcHtml(npc.fetchId(), dungeonTeleportHtml));
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const C4GatekeeperTeleports = invoke('GameServer/World/C4GatekeeperTeleports');
    if (C4GatekeeperTeleports.html(npc.fetchSelfId())) {
        // A gatekeeper can simultaneously be a quest NPC.  Do not let quest
        // progress replace travel: offer the player both branches first.
        const QuestService = invoke('GameServer/Quest/QuestService');
        return QuestService.hasTalk(session, npc).then((hasQuest) => {
            options.operation?.check();
            showGatekeeperTalk(session, npc, hasQuest);
        }).catch((error) => {
            if (options.operation) throw error;
            utils.infoWarn('Quest', 'failed to inspect gatekeeper quests: %s', error.message);
            showGatekeeperTalk(session, npc, false);
        });
        return;
    }

    // A merchant can also be a quest NPC. Keep the merchant's main dialog
    // reachable; its Quest link is routed through NpcTalkResponse so the
    // quest service can still render the stateful branch on demand.
    const QuestService = invoke('GameServer/Quest/QuestService');
    const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
    const NpcExchangeShopLists = invoke('GameServer/World/Generics/NpcExchangeShopLists');
    const hasNpcShop = NpcShopBuyLists.fetchForNpc(npc.fetchSelfId()).length > 0
        || NpcExchangeShopLists.fetchForNpc(npc.fetchSelfId()).length > 0
        || !!invoke('GameServer/Items/C4WeaponSAExchange').station(npc.fetchSelfId());
    // Temple priests lead with the town Class Transfer/Clan dialog, mirroring
    // the merchant pattern; any quest branch stays reachable through a
    // Quest link routed via NpcTalkResponse.
    const templePriest = invoke('GameServer/World/C4TemplePriests').handles(npc.fetchSelfId());
    // Quest registration must not hide personal/clan storage. The default
    // warehouse menu already exposes its quest branch when requested.
    const warehouse = /^Warehouse (Keeper|Chief|Freightman)$/i.test(title);
    if (!QuestService.handlesNpc(npc) || hasNpcShop || templePriest || warehouse) {
        showDefaultTalk(session, npc, {
            questLink: (hasNpcShop || templePriest || warehouse) && QuestService.handlesNpc(npc)
        });
        return;
    }
    return QuestService.onTalk(session, npc, options).then((handled) => {
        options.operation?.check();
        if (!handled) showDefaultTalk(session, npc);
    }).catch((error) => {
        if (options.operation) throw error;
        utils.infoWarn('Quest', 'failed to open NPC quest dialog: %s', error.message);
        showDefaultTalk(session, npc);
    });
}

function showGatekeeperTalk(session, npc, hasQuest) {
    const C4GatekeeperTeleports = invoke('GameServer/World/C4GatekeeperTeleports');
    const html = C4GatekeeperTeleports.menu(npc.fetchSelfId(), hasQuest);
    if (session.mcpObservation) require('../../Bot/Control/Journal').dialogue(session, npc.fetchId(), html, 'native_gatekeeper_menu');
    session.dataSendToMe(ServerResponse.npcHtml(npc.fetchId(), html));
    session.dataSendToMe(ServerResponse.actionFailed());
}

function showDefaultTalk(session, npc, options = {}) {
    const path = 'data/Html/';
    const filename = path + npc.fetchSelfId() + '.html';
    const title = npc.fetchTitle?.() || '';
    const secondProfession = invoke('GameServer/SecondProfession').handles(npc.fetchSelfId());
    if (/^Warehouse (Keeper|Chief|Freightman)$/i.test(title)) {
        const clan = session.actor.fetchClan?.();
        const clanLinks = clan && Number(clan.level) >= 1 ? [
            '<br>Clan Warehouse<br><br>',
            '<a action="bypass -h warehouse clan-deposit">Deposit item</a><br>',
            '<a action="bypass -h warehouse clan-withdraw">Withdraw item</a>'
        ] : [];
        const html = [
            '<html><body><center><br>Personal Warehouse<br><br>',
            '<a action="bypass -h warehouse deposit">Deposit item</a><br>',
            '<a action="bypass -h warehouse withdraw">Withdraw item</a>',
            ...clanLinks,
            ...(secondProfession
                ? ['<br><a action="bypass -h second-profession">Second profession trials</a><br>'] : []),
            ...(options.questLink ? [`<a action="bypass -h html ${npc.fetchSelfId()}-quest">Quest</a><br>`] : []),
            '</center></body></html>'
        ].join('');
        if (session.mcpObservation) require('../../Bot/Control/Journal').dialogue(session, npc.fetchId(), html, 'native_warehouse_menu');
        session.dataSendToMe(ServerResponse.npcHtml(npc.fetchId(), html));
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const weaponServices = invoke('GameServer/Items/C4WeaponSAExchange');
    let html = utils.fileExists(filename) ? utils.parseRawFile(filename)
        : secondProfession ? '<html><body>I can help you advance to your second profession. Bring the three trial marks when you reach level 40.<br></body></html>'
        : weaponServices.station(npc.fetchSelfId())
            ? '<html><body>I can help you with weapon special abilities.<br></body></html>'
            : utils.parseRawFile(path + 'noquest.html');
    if (options.questLink) html = withQuestLink(html, npc.fetchSelfId());
    if (secondProfession) {
        html = html.replace(/<\/body>/i, '<br><a action="bypass -h second-profession">Second profession trials</a><br></body>');
    }
    html = html.replace(/<\/body>/i, weaponServices.links(npc.fetchSelfId()) + '</body>');
    if (invoke('GameServer/Pets/PetExchangeData').managers.has(npc.fetchSelfId())) {
        html = html.replace(/<\/body>/i, '<br><a action="bypass -h pet-exchange">Exchange a Pet Ticket</a><br></body>');
    }

    if (session.mcpObservation) require('../../Bot/Control/Journal').dialogue(session, npc.fetchId(), html, 'native_default_talk');
    session.dataSendToMe(ServerResponse.npcHtml(npc.fetchId(), html));
    // C4 keeps the interaction pending until the response is terminated.
    // Without this, closing the HTML leaves movement blocked while the NPC
    // remains selected.
    session.dataSendToMe(ServerResponse.actionFailed());
}

function withQuestLink(html, npcId) {
    const questAction = `<a action="bypass -h html ${npcId}-quest">Quest</a>`;
    const questLink = /<a action="bypass -h html (?:noquest|\d+-quest)">Quest<\/a>/i;
    if (questLink.test(html)) return html.replace(questLink, questAction);
    return html.replace(/<\/body>/i, `${questAction}<br>\n</body>`);
}

module.exports = npcTalk;
