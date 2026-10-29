const BABENCO = 7334;
const BATHIS = 7332;
const BLACK = 7178;
const RED = 7179;
const INCENSE = 7180;
const GEM = 7181;
const QUEST_ITEMS = [BLACK, RED, INCENSE, GEM];
const FIRST_DROPS = {
  919: [BLACK, RED, 1],
  920: [BLACK, RED, 1],
  921: [RED, BLACK, 1],
};
const SECOND_DROPS = {
  925: [GEM, INCENSE, 0.5],
  921: [INCENSE, GEM, 0.3],
  920: [INCENSE, GEM, 0.25],
};
const ACCEPT = "ItemSound.quest_accept";
const ITEMGET = "ItemSound.quest_itemget";
const MIDDLE = "ItemSound.quest_middle";
const FINISH = "ItemSound.quest_finish";
function steps() {
  return invoke("GameServer/Quest/QuestStep");
}
function count(state, itemId) {
  let amount = 0;
  for (const item of state.session.actor.backpack.fetchItems()) {
    if (item.fetchSelfId() === itemId && !item.fetchEquipped()) amount += item.fetchAmount();
  }
  return amount;
}
function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}
function necklaceProgress(state, title = "Bathis") {
  return page(title, `Bathis needs 100 Black Bone Necklaces and 100 Red Bone Necklaces from the Maille Lizardmen, Scouts and Guards on the plains west of Gludio Castle Town. You have ${count(state, BLACK)}/100 black and ${count(state, RED)}/100 red. Keep your necklaces and gather the missing ones.`);
}
function incenseProgress(state) {
  return page("Bathis", `Bring 30 Incense Pouches from Maille Lizardman Scouts and Guards, and 30 Gems of Maille Lizardman from Giant Araneids at the Maille Lizardmen Barracks. You have ${count(state, INCENSE)}/30 incense and ${count(state, GEM)}/30 gems.`);
}
async function repairLegacyNecklaces(state) {
  // The old handler reached cond 3 with only 100 necklaces combined. Reopen
  // collection without consuming progress; later hand-ins and completion stand.
  if (!state.isStarted() || state.getInt("cond") !== 3) return false;
  if (count(state, BLACK) >= 100 && count(state, RED) >= 100) return false;
  await steps().apply(state, { variables: { ...state.variables, cond: "2" } });
  return true;
}

module.exports = {
  id: 39,
  name: "Red-Eyed Invaders",
  npcs: [BABENCO, BATHIS],
  startNpcs: [BABENCO],
  killNpcs: [919, 920, 921, 925],
  questItems: QUEST_ITEMS,
  partyKill: {
    killerWeight: 3,
    rangeAfterSelection: true,
    stages: [
      { condition: 2, excludedNpcs: [925] },
      { condition: 4, excludedNpcs: [919] },
    ],
  },
  eventNpc: (event) => ({ start: BABENCO, bathis: BATHIS, necklaces: BATHIS, finish: BATHIS })[event] ?? null,
  async onEvent(state, event) {
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (!(Number(state.session.actor.fetchLevel()) >= 20)) return null;
      await steps().apply(state, { variables: { ...state.variables, cond: "1" } });
      state.playSound(ACCEPT);
      return page("Babenco", "Thank you for your help. Report to Captain Bathis at the northern entrance of Gludio Castle Town for your orders.");
    }
    if (!state.isStarted()) return null;
    if (await repairLegacyNecklaces(state)) return necklaceProgress(state);
    const cond = state.getInt("cond");
    if (event === "bathis" && cond === 1) {
      await steps().apply(state, { variables: { ...state.variables, cond: "2" } });
      state.playSound(MIDDLE);
      return necklaceProgress(state);
    }
    if (event === "necklaces" && cond === 3) {
      if (count(state, BLACK) < 100 || count(state, RED) < 100) return necklaceProgress(state);
      await steps().apply(state, {
        takes: steps().heldItems(state, [BLACK, RED]),
        variables: { ...state.variables, cond: "4" },
      });
      state.playSound(MIDDLE);
      return page("Bathis", "Good work! Now investigate the alliance between the Maille Lizardmen and Giant Araneids. Bring 30 Incense Pouches from the Scouts and Guards, and 30 Gems of Maille Lizardman from Giant Araneids at the Maille Lizardmen Barracks.");
    }
    if (event === "finish" && cond === 5) {
      if (count(state, INCENSE) < 30 || count(state, GEM) < 30) return incenseProgress(state);
      await steps().apply(state, {
        takes: steps().heldItems(state, QUEST_ITEMS),
        gives: [[6521, 60], [6529, 1], [6535, 500]],
        status: "completed",
      });
      state.playSound(FINISH);
      return page("Bathis", "You have proven the conspiracy between the Maille Lizardmen and the giant spiders. Thank you for your help! Please accept this fishing rod, 60 high-grade green lures and 500 non-grade fishing shots as a token of our appreciation.");
    }
    return null;
  },
  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    if (state.isCompleted()) return page("Quest", "You have already completed this quest.");
    if (!state.isStarted())
      return npcId === BABENCO
        ? Number(state.session.actor.fetchLevel()) >= 20
          ? page("Babenco", "An army of Maille Lizardmen is gathering west of Gludio Castle Town. Captain Bathis is recruiting militiamen. Will you help us?", '<a action="bypass -h quest 39 start">I will help.</a>')
          : page("Babenco", "This mission is too dangerous for beginners. Return at level 20 or above.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    if (await repairLegacyNecklaces(state)) return necklaceProgress(state, npcId === BABENCO ? "Babenco" : "Bathis");
    if (npcId === BABENCO) return page("Babenco", "Report to Captain Bathis at the northern entrance of Gludio Castle Town.");
    if (npcId !== BATHIS) return null;
    const cond = state.getInt("cond");
    if (cond === 1)
      return page("Bathis", "Did Guard Babenco send you? This is a critical mission. Listen carefully.", '<a action="bypass -h quest 39 bathis">I am listening.</a>');
    if (cond === 2) return necklaceProgress(state);
    if (cond === 3)
      return page("Bathis", `You have ${count(state, BLACK)} black and ${count(state, RED)} red necklaces. Will you help us investigate the giant spiders fighting alongside the lizardmen?`, '<a action="bypass -h quest 39 necklaces">Hand over the necklaces and continue.</a>');
    if (cond === 4) return incenseProgress(state);
    if (cond === 5)
      return page("Bathis", `You have ${count(state, INCENSE)} incense pouches and ${count(state, GEM)} gems. These will help Magister Rohmer investigate the conspiracy.`, '<a action="bypass -h quest 39 finish">Is my mission over?</a>');
    return page("Bathis", "Continue your investigation of the Maille Lizardmen.");
  },
  async onKill(state, npc) {
    if (!state.isStarted()) return;
    const cond = state.getInt("cond");
    const drop = (cond === 2 ? FIRST_DROPS : cond === 4 ? SECOND_DROPS : null)?.[Number(npc.fetchSelfId())];
    if (!drop) return;
    const [itemId, otherId, chance] = drop;
    const limit = cond === 2 ? 100 : 30;
    const current = count(state, itemId);
    let amount = 0;
    if (current < limit) {
      if (Math.random() >= chance) return;
      amount = Math.min(1, limit - current);
    }
    const done = current + amount >= limit && count(state, otherId) >= limit;
    if (!amount && !done) return;
    await steps().apply(state, {
      gives: amount ? [[itemId, amount]] : [],
      variables: { ...state.variables, cond: String(done ? cond + 1 : cond) },
    });
    state.playSound(done ? MIDDLE : ITEMGET);
  },
};
