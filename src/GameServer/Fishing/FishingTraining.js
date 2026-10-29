const Data = require('./FishingData');
const Service = require('./FishingService');
const NpcIndex = require('../World/NpcObjectIndex');
const World = invoke('GameServer/World/World');
const Response = invoke('GameServer/Network/Response');
const TRAINERS = new Set([8578, 8579]);
const ACQUIRE_TYPE = 1;

function nearby(session, actor) {
    const talk = session.activeNpcTalk;
    const npc = NpcIndex.find(World, talk?.objectId);
    return Service.available(session, actor) && !actor.fishing && !actor.state.isBlocked()
        && !actor.state.fetchCombats() && !actor.state.inMotion() && !session.moveTimer
        && npc && TRAINERS.has(npc.fetchSelfId()) && npc.fetchSelfId() === talk?.selfId
        && !npc.state?.fetchDead?.() && Math.hypot(actor.fetchLocX() - npc.fetchLocX(), actor.fetchLocY() - npc.fetchLocY()) <= 200
        && Math.abs(actor.fetchLocZ() - npc.fetchLocZ()) <= 200;
}

function eligible(actor) {
    return Data.skillIds.map(id => Data.rank(id, (actor.skillset.fetchSkill(id)?.fetchLevel() || 0) + 1))
        .filter(rank => rank && rank.playerLevel <= actor.fetchLevel());
}

function open(session) {
    const actor = session.actor;
    if (!nearby(session, actor) || actor.fishingMutation) {
        session.activeFishingTraining = null;
        return Service.reject(session, actor, 'Fishing training is unavailable.');
    }
    const ranks = eligible(actor);
    session.activeFishingTraining = { actor, talk: session.activeNpcTalk,
        htmlGeneration: session.npcHtmlGeneration, ranks: new Map(ranks.map(rank => [rank.skillId, rank])) };
    session.dataSendToMe(Response.acquireSkillList(ranks));
    if (!ranks.length) Service.message(session, actor, 'No fishing skills are available at your current level.');
}

function contextCurrent(session, context) {
    return context && session.activeFishingTraining === context && session.actor === context.actor
        && session.activeNpcTalk === context.talk && session.npcHtmlGeneration === context.htmlGeneration
        && nearby(session, context.actor);
}

function selection(session, id, level, type) {
    const context = session.activeFishingTraining;
    const rank = context?.ranks.get(id);
    if (type !== ACQUIRE_TYPE || !contextCurrent(session, context) || !rank || rank.level !== level
        || rank.playerLevel > context.actor.fetchLevel()
        || (context.actor.skillset.fetchSkill(id)?.fetchLevel() || 0) + 1 !== level) throw Error('fishing_training_changed');
    return { context, rank };
}

function info(session, id, level, type) {
    try {
        const { context, rank } = selection(session, id, level, type);
        context.selected = rank;
        session.dataSendToMe(Response.acquireSkillInfo(rank));
    } catch (error) { Service.report(session, session.actor, error); }
}

async function learn(session, id, level, type) {
    const actor = session.actor;
    try {
        const { context, rank } = selection(session, id, level, type);
        if (context.selected !== rank) throw Error('fishing_training_not_issued');
        context.selected = null;
        await Service.settle(session, actor, { kind: 'learn', skillId: id, level }, () => {
            if (!contextCurrent(session, context) || context.ranks.get(id) !== rank
                || (actor.skillset.fetchSkill(id)?.fetchLevel() || 0) + 1 !== level) throw Error('fishing_training_changed');
        });
        if (contextCurrent(session, context)) {
            session.dataSendToMe(Response.acquireSkillDone());
            open(session);
        }
    } catch (error) { Service.report(session, actor, error); }
}

module.exports = { open, info, learn };
