const ServerResponse = invoke("GameServer/Network/Response");
const Database = invoke("Database");
const DataCache = invoke("GameServer/DataCache");
const QuestState = invoke("GameServer/Quest/QuestState");
const ProgressionRates = invoke("GameServer/ProgressionRates");
const ExperienceReward = invoke("GameServer/Actor/Generics/ExperienceReward");
const ConsoleText = invoke("GameServer/ConsoleText");
const World = invoke("GameServer/World/World");
const ClassTransfer = invoke("GameServer/ClassTransfer");
const QuestRegistry = require("./QuestRegistry");
const NpcObjectIndex = require("../World/NpcObjectIndex");

const quests = QuestRegistry.activeQuests();
const byId = new Map(quests.map((quest) => [quest.id, quest]));
const attackQuests = new Map();
const skillQuests = new Map();
const partyKillQuests = new Map();
for (const quest of quests) if (quest.partyKill) for (const npcId of quest.killNpcs || []) {
  if (!partyKillQuests.has(npcId)) partyKillQuests.set(npcId, []);
  partyKillQuests.get(npcId).push(quest);
}
for (const quest of quests) for (const npcId of quest.skillNpcs || []) {
  if (!skillQuests.has(npcId)) skillQuests.set(npcId, []);
  skillQuests.get(npcId).push(quest);
}
for (const quest of quests) for (const npcId of quest.attackNpcs || []) {
  if (!attackQuests.has(npcId)) attackQuests.set(npcId, []);
  attackQuests.get(npcId).push(quest);
}

function states(session) {
  if (!session.questStates) session.questStates = new Map();
  return session.questStates;
}

// NPC links and kill callbacks can reach the same character back-to-back.
// Keep the read-modify-write quest transition atomic at the session level so
// two kills cannot both observe the same pre-transition inventory/state.
function mutate(session, work) {
  const previous = session.questMutationTail || Promise.resolve();
  session.questMutations = Number(session.questMutations || 0) + 1;
  const next = previous.catch(() => {}).then(work).finally(() => { session.questMutations--; });
  session.questMutationTail = next.catch(() => {});
  return next;
}

async function ensureLoaded(session) {
  if (session.questStatesLoaded) return;
  const actor = session.actor;
  const cache = states(session);
  const rows = await Database.fetchCharacterQuests(actor.fetchId());
  // A response for the previous character must not populate the new cache.
  if (session.actor !== actor || states(session) !== cache) return;
  cache.clear();
  rows.forEach((row) => {
    const quest = byId.get(Number(row.questId));
    if (quest)
      states(session).set(quest.id, new QuestState(session, quest, row));
  });
  session.questStatesLoaded = true;
  if (session.actor.fetchClanId?.()) await invoke("GameServer/Clan/ClanAllianceService").resume(session);
}

function stateFor(session, quest) {
  let state = states(session).get(quest.id);
  if (!state) {
    state = new QuestState(session, quest);
    states(session).set(quest.id, state);
  }
  return state;
}

function talkQuests(npc, session) {
  const npcId = Number(npc.fetchSelfId());
  return quests.filter((quest) => {
    if (!quest.npcs.includes(npcId)) return false;
    const state = stateFor(session, quest);
    if (
      !state.isStarted() &&
      !state.isCompleted() &&
      !(quest.startNpcs || []).includes(npcId)
    )
      return false;
    return !quest.canTalk || quest.canTalk(state, npc);
  });
}

function questForNpc(npc, session) {
  const candidates = talkQuests(npc, session);
  return (
    candidates.find((quest) => stateFor(session, quest).isStarted()) ||
    candidates.find((quest) => !stateFor(session, quest).isCompleted()) ||
    candidates[0]
  );
}

function handlesNpc(npc) {
  const npcId = Number(npc.fetchSelfId?.() ?? npc);
  return quests.some((quest) => quest.npcs.includes(npcId));
}

// Gatekeepers can offer both travel and quest progress.  The caller needs to
// decide whether to expose the quest branch without opening it (talking to a
// quest NPC may itself advance a quest), so keep this check read-only.
async function hasTalk(session, npc) {
  await ensureLoaded(session);
  return Boolean(questForNpc(npc, session));
}

function render(session, npc, html) {
  // Some village masters lead directly with an existing quest (e.g. Jurek's
  // Soul Crystal quest). Add the transfer branch without replacing that page.
  const npcId = npc.fetchSelfId?.() ?? session.activeNpcTalk?.selfId;
  if (invoke('GameServer/SecondProfession').handles(npcId) && !html.includes('bypass -h second-profession')) {
    html = html.replace(/<\/body>/i, '<br><a action="bypass -h second-profession">Second profession trials</a><br></body>');
  }
  if (session.mcpObservation) require('../Bot/Control/Journal').dialogue(session, npc.fetchId(), html, 'native_quest_render');
  session.dataSendToMe(ServerResponse.npcHtml(npc.fetchId(), html));
  session.dataSendToMe(ServerResponse.actionFailed());
}

function syncActiveQuests(session) {
  session.dataSendToMe(ServerResponse.questList(active(session)));
}

function activeQuestSnapshot(session) {
  return JSON.stringify(active(session));
}

// QuestState.giveItems in C4 sends an earned-item SystemMessage after the
// inventory mutation.  Without it the client silently updates its inventory,
// which makes a completed quest look as if it paid nothing.
function transmitItemReceived(session, selfId, amount) {
  const itemId = Number(selfId);
  const count = Math.max(0, Math.floor(Number(amount) || 0));
  if (count <= 0) return;

  if (itemId === 57) {
    ConsoleText.transmit(session, ConsoleText.caption.earnedAdena, [
      { kind: ConsoleText.kind.number, value: count },
    ]);
  } else if (count > 1) {
    ConsoleText.transmit(session, ConsoleText.caption.earnedAmountOf, [
      { kind: ConsoleText.kind.item, value: itemId },
      { kind: ConsoleText.kind.number, value: count },
    ]);
  } else {
    ConsoleText.transmit(session, ConsoleText.caption.earnedItem, [
      { kind: ConsoleText.kind.item, value: itemId },
    ]);
  }
}

function transitionSnapshot(state) {
  return { questId: state.quest.id, state: state.state, condition: state.getInt('cond'), revision: state.getInt('revision') };
}

async function onTalk(session, npc, options = {}) {
  // Work queued for one character is dropped once the connection selected another.
  const actor = session.actor;
  return mutate(session, async () => {
    if (session.actor !== actor) return false;
    await ensureLoaded(session);
    if (session.actor !== actor) return false;
    options.operation?.check();
    const quest = questForNpc(npc, session);
    if (!quest) return false;
    const state = stateFor(session, quest);
    const choices = talkQuests(npc, session).filter(quest => !stateFor(session, quest).isCompleted());
    if (!state.isStarted() && choices.length > 1) {
      options.operation?.begin();
      const html = `<html><body>Available quests:<br><br>${choices.map((quest) => `<a action="bypass -h quest ${quest.id} ${stateFor(session, quest).isStarted() ? 'show_quest' : 'start'}">${quest.name}</a><br>`).join("")}</body></html>`;
      render(session, npc, html);
      return true;
    }
    const before = activeQuestSnapshot(session);
    options.operation?.begin();
    const nativeBefore = options.operation && transitionSnapshot(state);
    let html = await quest.onTalk(state, npc);
    options.operation?.feedback({ before: nativeBefore, after: transitionSnapshot(state), scope: 'selected_live_quest_state_not_reward_receipt' });
    if (!html) return false;
    const alternatives = choices.filter(choice => choice !== quest);
    if (alternatives.length) html = html.replace(/<\/body>/i, '<br>Other quests:<br>'
      + alternatives.map(choice => `<a action="bypass -h quest ${choice.id} show_quest">${choice.name}</a><br>`).join('') + '</body>');
    if (before !== activeQuestSnapshot(session)) syncActiveQuests(session);
    render(session, npc, html);
    return true;
  });
}

async function onEvent(session, event, options = {}) {
  // Work queued for one character is dropped once the connection selected another.
  const actor = session.actor;
  return mutate(session, async () => {
    if (session.actor !== actor) return false;
    await ensureLoaded(session);
    if (session.actor !== actor) return false;
    options.operation?.check();
    const quest = byId.get(Number(event.questId));
    const npc = session.activeNpcTalk;
    const eventName = String(event.name);
    if (!quest || !npc || !quest.npcs.includes(Number(npc.selfId)))
      return false;
    const target = { fetchSelfId: () => Number(npc.selfId), fetchId: () => Number(npc.objectId) };
    const actual = invoke('GameServer/World/NpcObjectIndex').find(World, target.fetchId());
    if (actual?.questSpawn && (actual.questSpawn.ownerId !== session.actor.fetchId()
        || actual.questSpawn.questId !== quest.id)) return false;
    if (quest.personalNpcs?.includes(target.fetchSelfId()) && !quest.canTalk(stateFor(session, quest), target)) return false;
    if (eventName === 'show_quest') {
      if (!talkQuests(target, session).includes(quest)) return false;
      const before = activeQuestSnapshot(session);
      options.operation?.begin();
      const state = stateFor(session, quest), nativeBefore = options.operation && transitionSnapshot(state);
      const html = await quest.onTalk(state, target);
      options.operation?.feedback({ before: nativeBefore, after: transitionSnapshot(state), scope: 'selected_live_quest_state_not_reward_receipt' });
      if (!html) return false;
      if (before !== activeQuestSnapshot(session)) syncActiveQuests(session);
      render(session, target, html);
      return true;
    }
    const eventNpcs = quest.eventNpc?.(eventName);
    const permitted = Array.isArray(eventNpcs)
      ? eventNpcs.includes(Number(npc.selfId)) : eventNpcs === Number(npc.selfId);
    if (!permitted) return false;
    const state = stateFor(session, quest);
    const before = activeQuestSnapshot(session);
    options.operation?.begin();
    const nativeBefore = options.operation && transitionSnapshot(state);
    const html = await quest.onEvent(state, eventName);
    options.operation?.feedback({ before: nativeBefore, after: transitionSnapshot(state), scope: 'selected_live_quest_state_not_reward_receipt' });
    if (!html) return false;
    if (before !== activeQuestSnapshot(session)) syncActiveQuests(session);
    render(session, { fetchId: () => npc.objectId }, html);
    return true;
  });
}

async function giveItem(session, selfId, amount) {
  const backpack = session.actor.backpack;
  const existing = backpack.fetchItemFromSelfId(selfId);
  if (existing?.fetchStackable?.()) {
    const total = existing.fetchAmount() + amount;
    await Database.updateItemAmount(
      session.actor.fetchId(),
      existing.fetchId(),
      total,
    );
    existing.setAmount(total);
  } else {
    // Cache lookup is synchronous and does not call back for unknown IDs.
    // Reject instead of leaving the entire session's quest queue pending.
    let data;
    DataCache.fetchItemFromSelfId(selfId, item => { data = item; });
    if (!data) throw new Error(`Missing quest item template ${selfId}`);
    const result = await Database.setItem(session.actor.fetchId(), {
      selfId,
      name: data.template.name,
      amount,
      equipped: false,
      slot: data.etc.slot,
    });
    backpack.insertItem(Number(result.insertId), selfId, { amount });
  }
  session.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
  transmitItemReceived(session, selfId, amount);
}

async function completeWolfQuest(state) {
  const session = state.session;
  const backpack = session.actor.backpack;
  const result = await Database.completeWolfQuest(session.actor.fetchId());
  backpack.items = backpack.items.filter(item => item.fetchId() !== result.removedItemId);
  backpack.insertItem(result.id, 2375, { amount: 1 });
  state.state = 'created';
  state.variables = {};
  session.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
  transmitItemReceived(session, 2375, 1);
}

async function takeItem(session, selfId, amount = 1) {
  const item = session.actor.backpack.fetchItemFromSelfId(selfId);
  if (!item) return false;
  // L2J's QuestState.takeItems(id, -1) consumes the entire stack. Several
  // source-backed quest hand-ins use that sentinel; subtracting -1 would
  // silently duplicate a quest item instead of clearing it.
  const requested = Number(amount) === -1 ? item.fetchAmount() : Number(amount);
  if (!Number.isFinite(requested) || requested <= 0 || item.fetchAmount() < requested)
    return false;
  const remaining = item.fetchAmount() - requested;
  if (remaining > 0) {
    await Database.updateItemAmount(
      session.actor.fetchId(),
      item.fetchId(),
      remaining,
    );
    item.setAmount(remaining);
  } else {
    await Database.deleteItem(session.actor.fetchId(), item.fetchId());
    session.actor.backpack.items = session.actor.backpack.items.filter(
      (entry) => entry !== item,
    );
  }
  session.dataSendToMe(
    ServerResponse.itemsList(session.actor.backpack.fetchItems()),
  );
  return true;
}

// C4's RateQuestRewardAdena is specific to Adena.  Quest item and equipment
// rewards retain their authored count (for example, one Necklace of Knowledge).
function rewardAdena(session, amount) {
  const rates = questRates();
  return giveItem(
    session,
    57,
    Math.max(0, Math.floor(Number(amount) * rates.questAdena)),
  );
}

function questDropAmount(amount, needed, current) {
  const baseAmount = Math.floor(Math.max(0, Number(amount) || 0));
  if (baseAmount <= 0 || current >= needed) return 0;
  return Math.min(baseAmount, needed - current);
}

function waypointKey(locX, locY, locZ) {
  return `${Number(locX)}:${Number(locY)}:${Number(locZ)}`;
}

// Source QuestState.addRadar sends an arming packet followed by a visible
// waypoint marker. Keep the marker session-local; it is client UI state, not
// durable quest progress.
function addRadar(session, locX, locY, locZ) {
  const coords = [locX, locY, locZ].map(Number);
  if (!session?.dataSendToMe || !coords.every(Number.isFinite)) return false;
  const key = waypointKey(...coords);
  session.questWaypoints ||= new Map();
  session.questWaypoints.set(key, coords);
  session.dataSendToMe(ServerResponse.radarControl(2, 2, ...coords));
  session.dataSendToMe(ServerResponse.radarControl(0, 1, ...coords));
  return true;
}

function removeRadar(session, locX, locY, locZ) {
  const coords = [locX, locY, locZ].map(Number);
  if (!session?.dataSendToMe || !coords.every(Number.isFinite)) return false;
  session.questWaypoints?.delete(waypointKey(...coords));
  session.dataSendToMe(ServerResponse.radarControl(1, 1, ...coords));
  return true;
}

// Mirrors the source QuestState.addSpawn default: spawn at the player's
// location, with no automatic despawn unless a quest explicitly requests it.
function spawnQuestNpc(state, selfId, options = {}) {
  const actor = state?.session?.actor;
  if (!actor?.fetchId) return null;
  const locX = options.locX ?? actor.fetchLocX?.();
  const locY = options.locY ?? actor.fetchLocY?.();
  const locZ = options.locZ ?? actor.fetchLocZ?.();
  return World.spawnQuestNpc({
    selfId,
    locX,
    locY,
    locZ,
    head: options.head ?? actor.fetchHead?.() ?? 0,
    ownerId: actor.fetchId(),
    questId: state.quest?.id,
    despawnDelay: options.despawnDelay ?? 0,
  });
}

// Profession quests call this only from their verified final hand-in. The
// shared transfer commits classId and target skills before the quest can mark
// itself completed, so a database failure cannot consume the final objective.
function awardFirstProfession(state, targetClassId) {
  return ClassTransfer.transfer(state?.session, targetClassId, {
    firstProfessionOnly: true,
  });
}

function rewardExpSp(session, exp, sp) {
  const rates = questRates();
  // ExperienceReward owns UI, persistence, and level-up. Counter its normal
  // mob-rate input so C4's dedicated RateQuestRewardXp/Sp remains the sole
  // server multiplier for an authored quest reward.
  const baseExp =
    Number(rates.exp) > 0 ? (Number(exp) * rates.questExp) / rates.exp : 0;
  const baseSp =
    Number(rates.sp) > 0 ? (Number(sp) * rates.questSp) / rates.sp : 0;
  ExperienceReward(session, session.actor, baseExp, baseSp);
}

function killLocation(actor) {
  return { x: actor.fetchLocX(), y: actor.fetchLocY(), z: actor.fetchLocZ(), radius: actor.fetchRadius() };
}

function inQuestPartyRange(actor, target, collision = false) {
  const radius = 1500 + (collision ? actor.fetchRadius() + target.radius : 0);
  return (actor.fetchLocX() - target.x) ** 2 + (actor.fetchLocY() - target.y) ** 2
    + (actor.fetchLocZ() - target.z) ** 2 <= radius ** 2;
}

function currentKillMember(member) {
  const current = World.registeredActorById(member.actor.fetchId());
  return member.session.actor === member.actor && current?.session === member.session && current.actor === member.actor;
}

function partyKillContext(session, npc) {
  const members = new Set([session]);
  if (session.hotBackgroundPartyId && !session.partyCompanion) {
    for (const member of invoke("GameServer/Bot/AI/HotBackgroundParty").roster(session)) members.add(member);
  } else {
    const leader = session.partyCompanion ? session.followPlayerSession : session;
    if (leader) for (const member of World.pvpPartySessionsForKey(leader)) {
      if (member === leader || (member.partyCompanion && member.followPlayerSession === leader)) members.add(member);
    }
  }
  const actor = session.actor;
  const targetId = Number(actor.fetchDestId());
  const target = targetId === npc.fetchId() ? npc
    : World.registeredActorById(targetId)?.actor || NpcObjectIndex.find(World, targetId) || actor;
  return {
    members: [...members].filter(member => member.actor).map(member => ({ session: member, actor: member.actor })),
    npcLocation: killLocation(npc),
    targetLocation: killLocation(target),
    inParty: members.size > 1,
  };
}

async function partyKill(session, actor, npc, source, handlers, context) {
  // Never hold the killer's queue while awaiting another member's queue:
  // simultaneous kills by opposite members would otherwise deadlock.
  await Promise.all(context.members.map(member => mutate(member.session, async () => {
    if (currentKillMember(member)) await ensureLoaded(member.session);
  })));
  if (session.actor !== actor) return;
  for (const quest of handlers) {
    const { killerWeight, rangeAfterSelection } = quest.partyKill;
    for (const stage of quest.partyKill.stages || [quest.partyKill]) {
      const eligible = member => {
        if (!currentKillMember(member)) return false;
        const state = states(member.session).get(quest.id);
        return state?.isStarted() && state.getInt("cond") === stage.condition;
      };
      const candidates = [];
      for (const member of context.members) {
        if (!eligible(member)) continue;
        if (!rangeAfterSelection && context.inParty && !inQuestPartyRange(member.actor, context.targetLocation)) continue;
        const weight = member.session === session ? killerWeight : 1;
        for (let i = 0; i < weight; i++) candidates.push(member);
      }
      if (!candidates.length) continue;
      const selected = candidates[Math.floor(Math.random() * candidates.length)];
      // Q32/Q39 draw first and check range afterwards, without rerolling.
      // Q35 instead filters around the killer's selected target before drawing.
      if (rangeAfterSelection && !inQuestPartyRange(selected.actor, context.npcLocation, true)) continue;
      if (stage.excludedNpcs?.includes(Number(npc.fetchSelfId()))) continue;
      await mutate(selected.session, async () => {
        if (session.actor !== actor || !eligible(selected)) return;
        const ownerId = Number(npc.questSpawn?.ownerId) || 0;
        if (ownerId && ownerId !== Number(selected.actor.fetchId())) return;
        const before = activeQuestSnapshot(selected.session);
        await quest.onKill(states(selected.session).get(quest.id), npc, source);
        if (before !== activeQuestSnapshot(selected.session)) syncActiveQuests(selected.session);
      });
      // Q39's fallback is an else branch, not another item roll. A matched
      // stage owns this kill even if capped, unlucky, or stale in its queue.
      break;
    }
  }
}

async function onKill(session, npc, source = session?.actor) {
  // Work queued for one character is dropped once the connection selected another.
  const actor = session.actor;
  const spawnedQuestId = Number(npc.questSpawn?.questId) || 0;
  const registered = partyKillQuests.get(Number(npc.fetchSelfId()));
  const handlers = spawnedQuestId ? registered?.filter(quest => spawnedQuestId === quest.id) : registered;
  const context = handlers?.length ? partyKillContext(session, npc) : null;
  const accepted = await mutate(session, async () => {
    if (session.actor !== actor) return false;
    await ensureLoaded(session);
    if (session.actor !== actor) return false;
    await invoke("GameServer/Clan/ClanAllianceService").onKill(session, npc);
    if (session.actor !== actor) return false;
    const ownerId = Number(npc.questSpawn?.ownerId) || 0;
    if (ownerId && ownerId !== Number(session.actor.fetchId())) return false;
    const before = activeQuestSnapshot(session);
    const npcId = Number(npc.fetchSelfId());
    for (const quest of quests) {
      if (quest.partyKill) continue;
      if (spawnedQuestId && spawnedQuestId !== quest.id) continue;
      if (!quest.killNpcs?.includes(npcId)) continue;
      const state = states(session).get(quest.id);
      if (state?.isStarted()) await quest.onKill(state, npc, source);
    }
    if (before !== activeQuestSnapshot(session)) syncActiveQuests(session);
    return true;
  });
  if (accepted && context) await partyKill(session, actor, npc, source, handlers, context);
}

function onAttack(session, npc, source, damage) {
  const handlers = attackQuests.get(npc.fetchSelfId?.());
  if (!handlers || !session?.actor) return Promise.resolve();
  // A foreign attacker can foul another player's personal summoning duel.
  // Deliver the real source to the encounter owner without granting kill credit.
  const ownerId = Number(npc.questSpawn?.ownerId) || 0;
  if (ownerId && ownerId !== Number(session.actor.fetchId())) {
    const owner = (World.user?.sessions || []).find(s => Number(s.actor?.fetchId?.()) === ownerId);
    if (!owner) return Promise.resolve();
    return onAttack(owner, npc, source, damage);
  }
  // Work queued for one character is dropped once the connection selected another.
  const actor = session.actor;
  return mutate(session, async () => {
    if (session.actor !== actor) return;
    await ensureLoaded(session);
    if (session.actor !== actor) return;
    for (const quest of handlers) {
      const state = states(session).get(quest.id);
      if (state?.isStarted()) await quest.onAttack(state, npc, source, damage);
    }
    syncActiveQuests(session);
  });
}

function onSummonDeath(session, pet) {
  if (!session?.actor) return Promise.resolve();
  // Work queued for one character is dropped once the connection selected another.
  const actor = session.actor;
  return mutate(session, async () => {
    if (session.actor !== actor) return;
    await ensureLoaded(session);
    if (session.actor !== actor) return;
    for (const quest of quests) {
      const state = states(session).get(quest.id);
      if (quest.onSummonDeath && state?.isStarted()) await quest.onSummonDeath(state, pet);
    }
    syncActiveQuests(session);
  });
}

function onSkillSee(session, npc, skill, source = session?.actor) {
  const handlers = skillQuests.get(npc.fetchSelfId?.());
  if (!handlers || !session?.actor || source !== session.actor || npc.isDead?.()) return Promise.resolve();
  // Work queued for one character is dropped once the connection selected another.
  const actor = session.actor;
  return mutate(session, async () => {
    if (session.actor !== actor) return;
    await ensureLoaded(session);
    if (session.actor !== actor) return;
    if (npc.questSpawn?.ownerId && npc.questSpawn.ownerId !== session.actor.fetchId()) return;
    for (const quest of handlers) {
      if (npc.questSpawn?.questId && npc.questSpawn.questId !== quest.id) continue;
      const state = states(session).get(quest.id);
      if (state?.isStarted()) await quest.onSkillSee(state, npc, skill);
    }
    syncActiveQuests(session);
  });
}

function active(session) {
  return [...states(session).values()]
    .filter((state) => state.isStarted())
    .map((state) => ({
      id: state.quest.id,
      condition: state.quest.clientCondition?.(state) ?? state.getInt("cond"),
    }));
}

function questRates() {
  return ProgressionRates.profile();
}

module.exports = {
  completeWolfQuest,
  ensureLoaded,
  onTalk,
  onEvent,
  onKill,
  handlesNpc,
  hasTalk,
  mutate,
  stateFor,
  active,
  syncActiveQuests,
  transmitItemReceived,
  giveItem,
  takeItem,
  rewardAdena,
  rewardExpSp,
  questDropAmount,
  onAttack,
  onSummonDeath,
  onSkillSee,
  addRadar,
  removeRadar,
  spawnQuestNpc,
  awardFirstProfession,
  questRates,
  quests: () => quests,
};
