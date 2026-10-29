// Only the carried Q23 documents are readable here. Source player_help links
// contain paths and item IDs; neither is permission to read arbitrary files or
// to advance quest state. Keep the fixed allowlist separate from NPC HTML.
const fs = require('fs');
const path = require('path');
const Response = invoke('GameServer/Network/Response');
const roots = ['7063.htm', '7064.htm'];
const diary = ['02', '03', '04', '05', '06', '06a', '06b', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16']
    .map(page => `lidias_diary/7064-${page}.htm`);
const documents = new Map([...roots, ...diary].map(name => [name, {
    itemId: name === '7063.htm' ? 7063 : 7064,
    html: fs.readFileSync(path.join(__dirname, '../../../../../data/Html/help', name), 'utf8')
}]));

module.exports = function playerHelp(session, parts) {
    const match = /^([^#]+)#(7063|7064)$/.exec(parts[1] || '');
    const document = match && documents.get(match[1]);
    if (!session.actor || parts.length !== 2 || !document || Number(match[2]) !== document.itemId
        || !session.actor.backpack.fetchItems().some(item => item.fetchSelfId() === document.itemId && item.fetchAmount() > 0)) {
        session.dataSendToMe(Response.actionFailed());
        return false;
    }
    session.dataSendToMe(Response.npcHtml(0, document.html));
    session.dataSendToMe(Response.actionFailed());
    return true;
};
