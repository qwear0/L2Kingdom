'use strict';

const { randomUUID } = require('crypto');
const { fault } = require('../../../Mcp/Contracts');
const text = value => String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 128);
function clear(session) {
    delete session.mcpOffers;
    if (session.mcpObservation?.dialogue) session.mcpObservation.dialogue.choicesStale = true;
}
function open(session, kind, rows) {
    if (!session.mcpObservation) return null;
    clear(session);
    const context = { revision: randomUUID(), kind, actor: session.actor, talk: session.activeNpcTalk,
        npc: require('../../World/NpcObjectIndex').find(invoke('GameServer/World/World'), session.activeNpcTalk?.objectId),
        generation: session.mcpControlGeneration, expiresAt: Date.now() + 60000, rows, tokens: new Map() };
    session.mcpOffers = context;
    return context;
}
function valid(session, context) {
    return !!context && session.mcpOffers === context && session.actor === context.actor && session.activeNpcTalk === context.talk
        && context.generation === session.mcpControlGeneration && Date.now() < context.expiresAt && context.npc && !context.npc.isDead?.()
        && require('../../World/NpcObjectIndex').find(invoke('GameServer/World/World'), context.talk?.objectId) === context.npc;
}
function mint(context, row) {
    if (!context) return null;
    const offerId = randomUUID();
    while (context.tokens.size >= 64) context.tokens.delete(context.tokens.keys().next().value);
    context.tokens.set(offerId, row);
    return { offerId, revision: context.revision, kind: row.type, label: row.label || row.type, ...row.display };
}
function take(session, revision, offerId) {
    const context = session.mcpOffers;
    if (!valid(session, context) || revision !== context.revision) throw fault('offer_context_changed', 409);
    const row = context.tokens.get(offerId);
    if (!row) throw fault('offer_expired', 410);
    return { context, row };
}
function decode(link) {
    let match;
    if ((match = /^quest (\d{1,8}) ([A-Za-z0-9_.-]{1,80})$/.exec(link))) return { type: 'quest', questId: Number(match[1]), event: match[2] };
    if ((match = /^html ([A-Za-z0-9_-]{1,64})$/.exec(link))) return { type: 'html', page: match[1] };
    if ((match = /^buy-shop ([a-z]{1,20})$/.exec(link))) return { type: 'buy_window', list: match[1] };
    if (link === 'sell-shop') return { type: 'sell_window' };
    if ((match = /^warehouse (deposit|withdraw|clan-deposit|clan-withdraw)$/.exec(link))) return { type: 'warehouse_window', mode: match[1] };
    if ((match = /^(?:multisell|exchange-shop) (\d{1,8})$/.exec(link))) return { type: 'multisell_window', listId: Number(match[1]) };
    if (link === 'gatekeeper-teleport') return { type: 'gatekeeper_window' };
    if (link === 'gatekeeper-quest') return { type: 'quest_window' };
    if ((match = /^gatekeeper-teleport (\d{1,8})$/.exec(link))) return { type: 'gatekeeper', destinationId: Number(match[1]) };
    return null;
}
function capture(session, objectId, html) {
    if (session.activeNpcTalk?.objectId !== objectId) return null;
    const choices = [], rows = []; let choiceBytes = 0, truncated = false;
    const push = choice => {
        const bytes = Buffer.byteLength(JSON.stringify(choice));
        if (choiceBytes + bytes > 16000) { truncated = true; return false; }
        choiceBytes += bytes; choices.push(choice); return true;
    };
    const context = open(session, 'dialogue', () => rows.values());
    if (!context) return null;
    const pattern = /<(?:a|button)\b[^>]*\baction="bypass(?: -h)? ([^"]+)"[^>]*>([^<]*)/gi;
    for (const match of String(html).slice(0, 16384).matchAll(pattern)) {
        if (choices.length >= 50) break;
        const parsed = decode(match[1]);
        const label = text(match[2] || /\bvalue="([^"]*)"/i.exec(match[0])?.[1] || 'Native choice');
        if (!parsed || parsed.type === 'buy_window' && parsed.list !== 'npc') {
            if (!push({ label, adapterSupported: false, reason: 'native_adapter_unavailable' })) break;
            continue;
        }
        const row = { ...parsed, label };
        if (parsed.type === 'quest') row.display = { questId: parsed.questId, event: parsed.event };
        if (parsed.type === 'gatekeeper') {
            const destination = require('../../World/C4GatekeeperTeleports').destination(session.activeNpcTalk.selfId, parsed.destinationId);
            if (!destination) { if (!push({ label, adapterSupported: false, reason: 'offer_unavailable' })) break; continue; }
            row.expected = { fee: destination.price, landing: { locX: destination.locX, locY: destination.locY, locZ: destination.locZ } };
            row.display = { fee: destination.price, landing: row.expected.landing };
        }
        rows.push(row);
        if (!push({ ...mint(context, row), adapterSupported: true, eligibility: 'native_revalidation_required' })) break;
    }
    return { revision: context.revision, expiresAt: context.expiresAt, choices, partial: truncated || String(html).length > 16384 || choices.length === 50 };
}
function* steps(session) {
    const context = session.mcpOffers;
    if (!valid(session, context)) return;
    for (const entry of context.rows()) yield { context, entry };
}
function project(value) {
    const result = mint(value.context, value.entry);
    if (value.entry.selfId) {
        const template = require('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, value.entry.selfId);
        result.name = String(template?.template?.name || '').slice(0, 64);
    }
    return result;
}
function summary(session) {
    const context = session.mcpOffers;
    return context ? { kind: context.kind, revision: context.revision, expiresAt: context.expiresAt,
        contextCurrent: valid(session, context), eligibility: 'native_revalidation_required', activeTokens: context.tokens.size } : null;
}
module.exports = { clear, open, valid, take, capture, steps, project, summary };
