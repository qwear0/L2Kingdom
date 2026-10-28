const FUNDIN = 8274;
const VULCAN = 8539;
const PACKAGE = 7263;
const SOUND_ACCEPT = "ItemSound.quest_accept";
const SOUND_FINISH = "ItemSound.quest_finish";
function steps() {
  return invoke("GameServer/Quest/QuestStep");
}
function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}
module.exports = {
  id: 13,
  name: "Parcel Delivery",
  npcs: [FUNDIN, VULCAN],
  startNpcs: [FUNDIN],
  eventNpc: (event) => ({ start: FUNDIN, reward: VULCAN })[event] ?? null,
  async onEvent(state, event) {
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (!(Number(actor.fetchLevel()) >= 74)) return null;
      await steps().apply(state, {
        gives: [[PACKAGE, 1]],
        variables: { ...state.variables, cond: "1" },
      });
      state.playSound(SOUND_ACCEPT);
      return page("Fundin", "Deliver this parcel to Vulcan.");
    }
    if (event === "reward" && state.isStarted() && state.getInt("cond") === 1) {
      const takes = steps().heldItems(state, [PACKAGE]);
      if (!takes.length) return null;
      const adena = Math.floor(82656 * invoke("GameServer/ProgressionRates").profile().questAdena);
      await steps().apply(state, {
        takes,
        gives: adena > 0 ? [[57, adena]] : [],
        status: "completed",
      });
      state.playSound(SOUND_FINISH);
      return page("Vulcan", "The parcel has arrived.");
    }
    return null;
  },
  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted())
      return npcId === FUNDIN
        ? Number(actor.fetchLevel()) >= 74
          ? page(
              "Fundin",
              "Will you deliver a parcel?",
              '<a action="bypass -h quest 13 start">Accept.</a>',
            )
          : page("Fundin", "This quest requires level 74 or above.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    if (npcId === VULCAN && !steps().heldItems(state, [PACKAGE]).length)
      return page("Vulcan", "Bring the package entrusted to you by Fundin.");
    return npcId === FUNDIN
      ? page("Fundin", "Deliver the parcel to Vulcan in the Gods' Cauldron area.")
      : page(
          "Vulcan",
          "Have you brought Fundin’s parcel?",
          '<a action="bypass -h quest 13 reward">Deliver the parcel.</a>',
        );
  },
};
