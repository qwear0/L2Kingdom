const DONAL = 8314;
const DAISY = 8315;
const ABERCROMBIE = 8555;
const SUPPLY_BOX = 7245;
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
  id: 18,
  name: "Meeting with the Golden Ram",
  npcs: [DONAL, DAISY, ABERCROMBIE],
  startNpcs: [DONAL],
  eventNpc: (event) =>
    ({ start: DONAL, supplies: DAISY, reward: ABERCROMBIE })[event] ?? null,
  async onEvent(state, event) {
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (!(Number(actor.fetchLevel()) >= 66)) return null;
      await steps().apply(state, { variables: { ...state.variables, cond: "1" } });
      state.playSound(SOUND_ACCEPT);
      return page("Donal", "Meet Daisy for supplies.");
    }
    if (
      event === "supplies" &&
      state.isStarted() &&
      state.getInt("cond") === 1
    ) {
      await steps().apply(state, {
        gives: [[SUPPLY_BOX, 1]],
        variables: { ...state.variables, cond: "2" },
      });
      state.playSound(SOUND_MIDDLE);
      return page("Daisy", "Take the supply box to Mercenary Supplier Abercrombie at the temporary outpost in the eastern Swamp of Screams. Be careful!");
    }
    if (event === "reward" && state.isStarted() && state.getInt("cond") === 2) {
      const takes = steps().heldItems(state, [SUPPLY_BOX]);
      if (!takes.length) return null;
      const adena = Math.floor(15000 * invoke("GameServer/ProgressionRates").profile().questAdena);
      await steps().apply(state, {
        takes,
        gives: adena > 0 ? [[57, adena]] : [],
        status: "completed",
        exp: 50000,
      });
      state.playSound(SOUND_FINISH);
      return page("Abercrombie", "Welcome to the Golden Ram.");
    }
    return null;
  },
  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted())
      return npcId === DONAL
        ? Number(actor.fetchLevel()) >= 66
          ? page(
              "Donal",
              "Will you meet the Golden Ram?",
              '<a action="bypass -h quest 18 start">Accept.</a>',
            )
          : page("Donal", "This quest requires level 66 or above.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    const cond = state.getInt("cond");
    if (npcId === DONAL) return page("Donal", cond === 1 ? "Speak with Daisy."
      : "Deliver Daisy's supply box to Abercrombie at the Golden Ram camp.");
    if (npcId === DAISY)
      return cond === 1
        ? page(
            "Daisy",
            "Take this supply box.",
            '<a action="bypass -h quest 18 supplies">Receive the box.</a>',
          )
        : page("Daisy", "Deliver it to Abercrombie.");
    if (cond === 2 && !steps().heldItems(state, [SUPPLY_BOX]).length)
      return page("Abercrombie", "Bring the supply box entrusted to you by Daisy.");
    return cond === 2
      ? page(
          "Abercrombie",
          "Have you brought the supplies?",
          '<a action="bypass -h quest 18 reward">Deliver the supplies.</a>',
        )
      : page("Abercrombie", "Speak with Daisy first.");
  },
};
