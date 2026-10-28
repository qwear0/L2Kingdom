const CADMON = 8296;
const LEON = 8256;
const WAHKAN = 8371;
const MUNITIONS_BOX = 7231;
const SOUND_ACCEPT = "ItemSound.quest_accept";
const SOUND_MIDDLE = "ItemSound.quest_middle";
const SOUND_FINISH = "ItemSound.quest_finish";
function step(state, changes) {
  return invoke("GameServer/Quest/QuestStep").apply(state, changes);
}
function hasBox(state) {
  return state.session.actor.backpack.fetchItems().some((item) =>
    item.fetchSelfId() === MUNITIONS_BOX && !item.fetchEquipped() && item.fetchAmount() >= 1,
  );
}
function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}
module.exports = {
  id: 11,
  name: "Secret Meeting With Ketra Orcs",
  npcs: [CADMON, LEON, WAHKAN],
  startNpcs: [CADMON],
  eventNpc: (event) =>
    ({ start: CADMON, supplies: LEON, reward: WAHKAN })[event] ?? null,
  async onEvent(state, event) {
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (!(Number(actor.fetchLevel()) >= 74)) return null;
      await step(state, { variables: { ...state.variables, cond: "1" } });
      state.playSound(SOUND_ACCEPT);
      return page("Cadmon", "Meet Leon to collect the munitions.");
    }
    if (
      event === "supplies" &&
      state.isStarted() &&
      state.getInt("cond") === 1
    ) {
      await step(state, {
        gives: [[MUNITIONS_BOX, 1]],
        variables: { ...state.variables, cond: "2" },
      });
      state.playSound(SOUND_MIDDLE);
      return page("Leon", "Deliver the box to Wahkan.");
    }
    if (event === "reward" && state.isStarted() && state.getInt("cond") === 2) {
      if (!hasBox(state)) return null;
      await step(state, {
        takes: [[MUNITIONS_BOX, 1]],
        status: "completed",
        exp: 79761,
      });
      state.playSound(SOUND_FINISH);
      return page("Wahkan", "The Ketra Orcs thank you.");
    }
    return null;
  },
  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted())
      return npcId === CADMON
        ? Number(actor.fetchLevel()) >= 74
          ? page(
              "Cadmon",
              "The Ketra Orcs are dangerous, but delivering supplies could earn their trust. Will you help Trader Leon?",
              '<a action="bypass -h quest 11 start">Accept.</a>',
            )
          : page("Cadmon", "This quest requires level 74 or above.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    const cond = state.getInt("cond");
    if (npcId === CADMON)
      return page("Cadmon", cond === 1 ? "Meet Trader Leon in Goddard."
        : "Deliver Leon's munitions box to Wahkan at the Ketra Orc Outpost.");
    if (npcId === LEON)
      return cond === 1
        ? page(
            "Leon",
            "Take this box of supplies to Wahkan, the messenger at the Ketra Orc Outpost.",
            '<a action="bypass -h quest 11 supplies">Receive the box.</a>',
          )
        : page("Leon", "Deliver it to Wahkan.");
    if (cond === 2 && !hasBox(state))
      return page("Wahkan", "Bring the munitions box entrusted to you by Leon.");
    return cond === 2
      ? page(
          "Wahkan",
          "Have you brought the supplies from Trader Leon?",
          '<a action="bypass -h quest 11 reward">Deliver the box.</a>',
        )
      : page("Wahkan", "Speak with Leon first.");
  },
};
