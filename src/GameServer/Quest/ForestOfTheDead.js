// Native adaptation of Mobius C4 a4c31517 Q21–Q23. Scene timers are disposable;
// only verified quest transitions survive reconnect. Never retain a Java-style
// global ghost lock or let a callback borrow a replacement character's state.
const Step = require('./QuestStep');
const World = invoke('GameServer/World/World');
const Index = invoke('GameServer/World/NpcObjectIndex');
const Response = invoke('GameServer/Network/Response');
const Lifecycle = require('../GameplayLifecycle');

const count = (state, id) => state.session.actor.backpack.fetchItems()
    .filter(item => item.fetchSelfId() === id && !item.fetchEquipped())
    .reduce((sum, item) => sum + item.fetchAmount(), 0);
const has = (state, ...ids) => ids.every(id => count(state, id) > 0);
const completed = (state, id) => state.session.questStates?.get(id)?.isCompleted() === true;
const noQuest = () => '<html><body>You are not on a quest involving this NPC.</body></html>';
const done = () => '<html><body>You have already completed this quest.</body></html>';

async function step(state, cond, options = {}) {
    const accepting = !state.isStarted();
    await Step.apply(state, { ...options,
        variables: { ...state.variables, ...options.variables, cond: String(cond) } });
    if (Number(state.session.actor?.fetchId?.()) !== state.actorId || state.session.questStates?.get(state.quest.id) !== state)
        throw Error('Forest quest actor replaced during settlement');
    state.playSound(options.status === 'completed' ? 'ItemSound.quest_finish'
        : accepting ? 'ItemSound.quest_accept' : 'ItemSound.quest_middle');
}

function liveTalk(state, selfId, objectId = state.session.activeNpcTalk?.objectId) {
    const npc = Index.find(World, objectId);
    const actor = state.session.actor;
    if (!npc || npc.fetchSelfId() !== selfId || npc.isDead() || !actor
        || Number(actor.fetchId()) !== state.actorId) return null;
    if (npc.questSpawn && (npc.questSpawn.ownerId !== state.actorId || npc.questSpawn.questId !== state.quest.id)) return null;
    const distance = Math.hypot(actor.fetchLocX() - npc.fetchLocX(), actor.fetchLocY() - npc.fetchLocY(), actor.fetchLocZ() - npc.fetchLocZ());
    return distance <= 300 + npc.fetchRadius() ? npc : null;
}

function canTalk(state, npc) {
    return !!liveTalk(state, npc.fetchSelfId(), npc.fetchId());
}

function eventNpc(event, startNpc, pages) {
    if (event === 'start') return startNpc;
    return Object.hasOwn(pages, event) ? Number(event.slice(0, 5)) - 23000 : null;
}

function view(state, npc, file, pages) {
    if (Number(state.session.actor?.fetchId?.()) !== state.actorId || state.session.questStates?.get(state.quest.id) !== state) return null;
    const raw = pages[file];
    if (!raw) throw Error(`Missing Forest dialogue Q${state.quest.id}/${file}`);
    const objectId = npc.fetchId();
    const events = new Set();
    const html = raw.replace(/bypass(?: -h)? Script Q\d+_\w+ ([\w.-]+\.htm)/g, (_, event) => {
        events.add(event);
        return `bypass -h quest ${state.quest.id} ${event}`;
    });
    state.forestChoices = { objectId, revision: state.getInt('revision'), events };
    return html;
}

// A source page is navigation only when this actor was actually shown its
// link. Consuming the receipt before awaiting prevents double/stale hand-ins;
// durable condition/item guards still arbitrate the subsequent transaction.
function acceptEvent(state, event) {
    const choice = state.forestChoices;
    state.forestChoices = null;
    const talk = state.session.activeNpcTalk;
    return !!(choice && choice.objectId === talk?.objectId
        && choice.revision === state.getInt('revision') && choice.events.has(event)
        && liveTalk(state, Number(talk.selfId)));
}

function scenes(session) {
    return session.forestScenes ||= new Map();
}

function valid(scene) {
    return !scene.closed && !Lifecycle.stopping && World.npc === scene.container
        && scene.session.actor === scene.actor && scene.actor.fetchIsOnline() === true
        && scene.session.questStates?.get(scene.state.quest.id) === scene.state && scene.state.isStarted();
}

function close(scene, removing = null) {
    if (!scene || scene.closed) return;
    scene.closed = true;
    scenes(scene.session).delete(scene.key);
    for (const timer of scene.timers) clearTimeout(timer);
    scene.timers.clear();
    const npcs = [...scene.npcs.values()];
    scene.npcs.clear();
    for (const npc of npcs) {
        npc.automation.abortMovement(npc, { notifyClient: false });
        if (npc !== removing && Index.find(World, npc.fetchId()) === npc) World.despawnQuestNpc(npc, scene.session);
    }
}

function clear(state, key) {
    close(state.session.forestScenes?.get(`${state.quest.id}:${key}`));
}

function dispose(session) {
    for (const scene of [...(session.forestScenes?.values() || [])]) close(scene);
    session.forestScenes = null;
}

function sceneFor(state, key) {
    const fullKey = `${state.quest.id}:${key}`;
    const previous = scenes(state.session).get(fullKey);
    if (previous && valid(previous)) return previous;
    close(previous);
    const scene = { key: fullKey, state, session: state.session, actor: state.session.actor,
        container: World.npc, npcs: new Map(), timers: new Set(), closed: false };
    scenes(state.session).set(fullKey, scene);
    return scene;
}

function existing(scene, selfId) {
    const npc = scene?.npcs.get(selfId);
    return scene && valid(scene) && npc && !npc.isDead() && Index.find(World, npc.fetchId()) === npc ? npc : null;
}

function find(state, key, selfId) {
    return existing(state.session.forestScenes?.get(`${state.quest.id}:${key}`), selfId);
}

function schedule(scene, delay, work) {
    const timer = setTimeout(() => {
        scene.timers.delete(timer);
        if (!valid(scene)) { close(scene); return; }
        const operation = invoke('GameServer/Quest/QuestService').mutate(scene.session, async () => {
            if (!valid(scene)) { close(scene); return; }
            const before = scene.state.getInt('cond');
            await work();
            if (scene.session.actor === scene.actor && before !== scene.state.getInt('cond'))
                invoke('GameServer/Quest/QuestService').syncActiveQuests(scene.session);
        });
        Lifecycle.track(operation).catch(error => {
            close(scene);
            utils.infoWarn('Quest', 'Forest scene Q%d failed: %s', scene.state.quest.id, error.message);
        });
    }, delay);
    timer.unref?.();
    scene.timers.add(timer);
    return timer;
}

function spawn(scene, selfId, coords, lifetime) {
    const previous = existing(scene, selfId);
    if (previous) return previous;
    const [locX, locY, locZ] = coords;
    const npc = scene.state.addSpawn(selfId, { locX, locY, locZ, despawnDelay: lifetime });
    if (!npc) throw Error(`Unable to spawn Forest quest NPC ${selfId}`);
    scene.npcs.set(selfId, npc);
    npc.questSpawn.dispose = () => close(scene, npc);
    npc.questSpawn.timer?.unref?.();
    return npc;
}

function say(scene, npc, text) {
    if (valid(scene) && npc) scene.session.dataSendToMeAndOthers(Response.speak(npc, { kind: 0, text }), npc);
}

function summonDuke(state, escort = false) {
    const guide = sceneFor(state, 'guide');
    const duke = spawn(guide, 8524, [51432, -54570, -3136], 300000);
    if (!guide.greeted) { say(guide, duke, 'Who awoke me?'); guide.greeted = true; }
    if (!escort) return guide;
    // Independent source lifetimes: the page's 90-second expiry must not
    // shorten the duke's 300 seconds or let old walk callbacks move a new page.
    const scene = sceneFor(state, 'escort');
    if (existing(scene, 8525)) return scene;
    const page = spawn(scene, 8525, [51608, -54520, -3168], 90000);
    page.setStateRun(false);
    scene.readyAt = Date.now() + 39000;
    say(scene, page, `My master has instructed me to be your guide, ${scene.actor.fetchName()}.`);
    const finish = async () => {
        if (!existing(scene, 8525) || !scene.arrived || Date.now() < scene.readyAt
            || state.getInt('cond') !== 3 || state.getInt('end_walk')) return;
        await step(state, 3, { variables: { end_walk: '1' } });
        say(scene, page, `Please check this bookcase, ${scene.actor.fetchName()}.`);
    };
    const walk = (coords, last = false) => {
        if (!existing(scene, 8525)) return;
        page.automation.scheduleMoveToCoords(scene.session, page,
            { locX: coords[0], locY: coords[1], locZ: coords[2] }, () => {
                if (last && valid(scene)) { scene.arrived = true; schedule(scene, 0, finish); }
            }, { walking: true });
    };
    schedule(scene, 4000, () => { say(scene, page, 'Follow me...'); walk([51992, -54424, -3160]); });
    schedule(scene, 9000, () => walk([52328, -53400, -3160]));
    schedule(scene, 21000, () => walk([51928, -51656, -3096], true));
    schedule(scene, 39000, finish);
    schedule(scene, 86000, () => say(scene, page, "I'm confused! Maybe it's time to go back."));
    return scene;
}

async function abort(state) {
    await Step.abandon(state, state.quest.questItems);
    for (const scene of [...(state.session.forestScenes?.values() || [])])
        if (scene.state === state) close(scene);
    state.forestChoices = null;
}

module.exports = { count, has, completed, noQuest, done, step, liveTalk, canTalk, eventNpc, view, acceptEvent,
    sceneFor, find, existing, schedule, spawn, say, clear, close, dispose, summonDuke, abort };
