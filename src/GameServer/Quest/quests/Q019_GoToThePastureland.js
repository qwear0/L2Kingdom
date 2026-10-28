const VLADIMIR = 8302;
const TUNATUN = 8537;
const MEAT = 7547;
const SOUND_ACCEPT = "ItemSound.quest_accept";
const SOUND_FINISH = "ItemSound.quest_finish";
function steps() {
  return invoke("GameServer/Quest/QuestStep");
}
function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}

module.exports = {
  id: 19,
  name: "Go to the Pastureland!",
  npcs: [VLADIMIR, TUNATUN],
  startNpcs: [VLADIMIR],
  eventNpc: (event) => ({ start: VLADIMIR, reward: TUNATUN })[event] ?? null,
  async onEvent(state, event) {
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (!(Number(actor.fetchLevel()) >= 63)) return null;
      await steps().apply(state, {
        gives: [[MEAT, 1]],
        variables: { ...state.variables, cond: "1" },
      });
      state.playSound(SOUND_ACCEPT);
      return page("Vladimir", "Take the young wild beast meat to Tunatun.");
    }
    if (event === "reward" && state.isStarted() && state.getInt("cond") === 1) {
      const takes = steps().heldItems(state, [MEAT]);
      if (!takes.length) return null;
      const adena = Math.floor(30000 * invoke("GameServer/ProgressionRates").profile().questAdena);
      await steps().apply(state, {
        takes,
        gives: adena > 0 ? [[57, adena]] : [],
        status: "completed",
      });
      state.playSound(SOUND_FINISH);
      return page("Tunatun", "I will apologize to Vladimir about the poor meat. Take this money as his refund.");
    }
    return null;
  },
  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted())
      return npcId === VLADIMIR
        ? Number(actor.fetchLevel()) >= 63
          ? page(
              "Vladimir",
              "Tunatun sent me poor quality meat! Take it back to him at the Beast Farm and tell him I want a refund.",
              '<a action="bypass -h quest 19 start">Accept.</a>',
            )
          : page("Vladimir", "This quest requires level 63 or above.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    if (npcId === TUNATUN && !steps().heldItems(state, [MEAT]).length)
      return page("Tunatun", "Bring back the meat that Vladimir refused.");
    return npcId === VLADIMIR
      ? page("Vladimir", "Take the meat back to Tunatun and tell him about my complaint.")
      : page(
          "Tunatun",
          "Vladimir is angry about that meat? It was the best I could find. Give it back and I will refund his money.",
          '<a action="bypass -h quest 19 reward">Deliver the meat.</a>',
        );
  },
};
