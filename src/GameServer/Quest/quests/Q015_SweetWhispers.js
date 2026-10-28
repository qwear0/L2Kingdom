const VLADIMIR = 8302;
const HIERARCH = 8517;
const MYSTERIOUS_NECRO = 8518;
const SOUND_ACCEPT = "ItemSound.quest_accept";
const SOUND_MIDDLE = "ItemSound.quest_middle";
const SOUND_FINISH = "ItemSound.quest_finish";
function steps() {
  return invoke("GameServer/Quest/QuestStep");
}
function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}
module.exports = {
  id: 15,
  name: "Sweet Whispers",
  npcs: [VLADIMIR, HIERARCH, MYSTERIOUS_NECRO],
  startNpcs: [VLADIMIR],
  eventNpc: (event) =>
    ({ start: VLADIMIR, message: MYSTERIOUS_NECRO, reward: HIERARCH })[event] ??
    null,
  async onEvent(state, event) {
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (!(Number(actor.fetchLevel()) >= 60)) return null;
      await steps().apply(state, { variables: { ...state.variables, cond: "1" } });
      state.playSound(SOUND_ACCEPT);
      return page("Vladimir", "Find the Mysterious Necromancer at the entrance to the Valley of Saints. He will help you test your fate.");
    }
    if (
      event === "message" &&
      state.isStarted() &&
      state.getInt("cond") === 1
    ) {
      await steps().apply(state, { variables: { ...state.variables, cond: "2" } });
      state.playSound(SOUND_MIDDLE);
      return page(
        "Mysterious Necromancer",
        "You seek the elder? Go past the entrance into the Valley of Saints and enter the cave in its deepest part. You will find Hierarch there.",
      );
    }
    if (event === "reward" && state.isStarted() && state.getInt("cond") === 2) {
      await steps().apply(state, { status: "completed", exp: 60217 });
      state.playSound(SOUND_FINISH);
      return page("Hierarch", "Your message has been received.");
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
        ? Number(actor.fetchLevel()) >= 60
          ? page(
              "Vladimir",
              "A message must be delivered.",
              '<a action="bypass -h quest 15 start">Accept.</a>',
            )
          : page("Vladimir", "This quest requires level 60 or above.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    const cond = state.getInt("cond");
    if (npcId === VLADIMIR)
      return page("Vladimir", "Find the Mysterious Necromancer at the entrance to the Valley of Saints.");
    if (npcId === MYSTERIOUS_NECRO)
      return cond === 1
        ? page(
            "Mysterious Necromancer",
            "I have a message.",
            '<a action="bypass -h quest 15 message">Receive the message.</a>',
          )
        : page("Mysterious Necromancer", "Take the message to the Hierarch.");
    return cond === 2
      ? page(
          "Hierarch",
          "Do you bring a message?",
          '<a action="bypass -h quest 15 reward">Deliver the message.</a>',
        )
      : page("Hierarch", "Speak with the Necromancer first.");
  },
};
