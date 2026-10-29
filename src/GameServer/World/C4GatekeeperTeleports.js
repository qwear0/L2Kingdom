require('../Geodata/JourneyGeometryIdentity.js').define(module, require, function (module, exports, require, __filename, __dirname) {
const DiamondCatalog = require('../Items/DimensionalDiamondCatalog');
const ServiceIndex = require('../Knowledge/NativeServiceIndex');
const destinationIndex = ServiceIndex.currentIndex(['0'], rows =>
    new Set(rows.map(([id]) => id)));
const { destinations: DESTINATIONS, lists: LISTS } = loadCatalogue();

function loadCatalogue() {
    try {
        const data = require('../../../data/Teleports/gatekeepers.json');
        const schema = require('../../../data/Teleports/.schema.json');
        require('jsonschema').validate(data, schema, { throwFirst: true });

        // Keep ordinary mutable objects: callers rely on raw property lookup and
        // integer-key enumeration for provider order and equal-cost routes.
        const destinations = {}, lists = {};
        const destinationIds = new Set(), npcIds = new Set();
        for (const [index, { id, locX, locY, locZ, price }] of data.destinations.entries()) {
            if (destinationIds.has(id)) throw new Error(`destinations[${index}].id: duplicate destination ${id}`);
            destinationIds.add(id);
            destinations[id] = [locX, locY, locZ, price];
        }
        for (const [index, { npcId, routes }] of data.gatekeepers.entries()) {
            const context = `gatekeepers[${index}] (NPC ${npcId})`;
            if (npcIds.has(npcId)) throw new Error(`${context}: duplicate NPC ID`);
            npcIds.add(npcId);
            const offers = new Set(), rows = [];
            for (const [routeIndex, { destinationId, label }] of routes.entries()) {
                const route = `${context}.routes[${routeIndex}] (destination ${destinationId})`;
                if (!destinationIds.has(destinationId)) throw new Error(`${route}: missing destination`);
                if (offers.has(destinationId)) throw new Error(`${route}: duplicate offer`);
                // Labels enter both visible text and msg="811;..." unchanged.
                // Reject markup, attribute/message delimiters and controls, not escape them.
                if (!/\S/u.test(label) || /["<>&;\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(label)) {
                    throw new Error(`${route}.label: expected nonblank literal text without markup, delimiters or controls`);
                }
                offers.add(destinationId);
                rows.push([destinationId, label]);
            }
            lists[npcId] = rows;
        }
        return { destinations, lists };
    } catch (error) {
        const detail = error.errors?.[0]?.stack ?? error.message;
        throw new Error(`Invalid data/Teleports/gatekeepers.json (schema: data/Teleports/.schema.json): ${detail.slice(0, 400)}`);
    }
}

function destination(npcId, id) {
    const rows = LISTS[npcId];
    if (rows == null) return null;
    let allowed;
    if (id && ['object', 'function'].includes(typeof id)) {
        allowed = rows.some(([candidate]) => candidate === Number(id));
    } else {
        const index = destinationIndex(rows);
        if (!index) allowed = rows.some(([candidate]) => candidate === Number(id));
        else if (rows.length) {
            const numericId = Number(id);
            allowed = !Number.isNaN(numericId) && index.has(numericId);
        }
    }
    if (!allowed) return null;
    const data = DESTINATIONS[id];
    if (!data) return null;
    const [locX, locY, locZ, price] = data;
    return { locX, locY, locZ, price };
}

function html(npcId) {
    const rows = LISTS[npcId];
    if (!rows) return null;
    const links = rows.map(([id, label]) => {
        const price = DESTINATIONS[id][3];
        const suffix = price > 0 ? ` - ${price} Adena` : '';
        return `<a action="bypass -h gatekeeper-teleport ${id}" msg="811;${label}">${label}${suffix}</a><br1>`;
    });
    return `<html><body>Region where teleporting is possible<br>${links.join('')}<br></body></html>`;
}

function menu(npcId, hasQuest) {
    if (!LISTS[npcId]) return null;
    const quest = hasQuest
        ? '<a action="bypass -h gatekeeper-quest">Quest</a><br1>'
        : '';
    const diamonds = DiamondCatalog.hasNpc(Number(npcId))
        ? '<a action="bypass -h diamond-exchange">Exchange Dimensional Diamonds</a><br1>' : '';
    return `<html><body>How can I help you?<br><br><a action="bypass -h gatekeeper-teleport">Teleport</a><br1>${diamonds}${quest}</body></html>`;
}

module.exports = { destination, html, menu, lists: LISTS };
return [[require.resolve('../Knowledge/NativeServiceIndex'), ServiceIndex]];
});
