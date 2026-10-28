const ABERCROMBIE = 8555;
const MONUMENTS = [8661, 8662, 8663, 8664];
const MONUMENT_CLUES = [
  "The carved diagrams form a map to the second monument somewhere in the marshland.",
  "The intersection of the lines marks the approximate location of the third monument on your map.",
  "The fourth monument lies in the most dangerous part of the Swamp of Screams.",
  "The four monuments track the moon at the spring and fall equinoxes and the summer and winter solstices. There are no more monuments here. Report to Abercrombie.",
];
const CORPSE_OF_DWARF = 8665;
const KRORIN_JOURNAL = 7252;
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
  id: 31,
  name: "Secret Buried in the Swamp",
  npcs: [ABERCROMBIE, CORPSE_OF_DWARF, ...MONUMENTS],
  startNpcs: [ABERCROMBIE],
  eventNpc(event) {
    if (event === "start" || event === "report" || event === "reward")
      return ABERCROMBIE;
    if (event === "journal") return CORPSE_OF_DWARF;
    const step = Number(String(event).replace("monument", ""));
    return Number.isInteger(step) && step >= 1 && step <= MONUMENTS.length
      ? MONUMENTS[step - 1]
      : null;
  },
  async onEvent(state, event) {
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (!(Number(actor.fetchLevel()) >= 66)) return null;
      await steps().apply(state, { variables: { ...state.variables, cond: "1" } });
      state.playSound(SOUND_ACCEPT);
      return page("Abercrombie", "Krorin disappeared in the Swamp of Screams. Look for him there. If he is dead, find his diary: it may explain the ancient monuments.");
    }
    if (
      event === "journal" &&
      state.isStarted() &&
      state.getInt("cond") === 1
    ) {
      await steps().apply(state, {
        gives: [[KRORIN_JOURNAL, 1]],
        variables: { ...state.variables, cond: "2" },
      });
      state.playSound(SOUND_MIDDLE);
      return page("Corpse of a Dwarf", "You find Krorin’s journal.");
    }
    if (event === "report" && state.isStarted() && state.getInt("cond") === 2) {
      await steps().apply(state, { variables: { ...state.variables, cond: "3" } });
      state.playSound(SOUND_MIDDLE);
      return page(
        "Abercrombie",
        "Krorin's diary describes four monuments used by Elmoreden priests for astronomical observation. Begin with the first monument and decipher its hieroglyphs to find the next.",
      );
    }
    const step = Number(String(event).replace("monument", ""));
    if (
      Number.isInteger(step) &&
      step >= 1 &&
      step <= MONUMENTS.length &&
      state.isStarted() &&
      state.getInt("cond") === step + 2
    ) {
      await steps().apply(state, {
        variables: { ...state.variables, cond: String(step + 3) },
      });
      state.playSound(SOUND_MIDDLE);
      return page(
        `Forgotten Monument ${step}`,
        MONUMENT_CLUES[step - 1],
      );
    }
    if (event === "reward" && state.isStarted() && state.getInt("cond") === 7) {
      const takes = steps().heldItems(state, [KRORIN_JOURNAL]);
      if (!takes.length) return null;
      const adena = Math.floor(40000 * invoke("GameServer/ProgressionRates").profile().questAdena);
      await steps().apply(state, {
        takes,
        gives: adena > 0 ? [[57, adena]] : [],
        status: "completed",
        exp: 130000,
      });
      state.playSound(SOUND_FINISH);
      return page("Abercrombie", "So the monuments are related to astronomy. Krorin would be proud of you! Please accept this token of my thanks.");
    }
    return null;
  },
  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted())
      return npcId === ABERCROMBIE
        ? Number(actor.fetchLevel()) >= 66
          ? page(
              "Abercrombie",
              "There is a secret buried in the swamp.",
              '<a action="bypass -h quest 31 start">Accept.</a>',
            )
          : page("Abercrombie", "This quest requires level 66 or above.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    const cond = state.getInt("cond");
    if (npcId === ABERCROMBIE) {
      if (cond === 2)
        return page(
          "Abercrombie",
          "Show me the journal.",
          '<a action="bypass -h quest 31 report">Report your discovery.</a>',
        );
      if (cond === 7 && !steps().heldItems(state, [KRORIN_JOURNAL]).length)
        return page("Abercrombie", "Bring Krorin's journal before claiming your reward.");
      if (cond === 7)
        return page(
          "Abercrombie",
          "You have followed every monument.",
          '<a action="bypass -h quest 31 reward">Receive the reward.</a>',
        );
      return page(
        "Abercrombie",
        cond === 1
          ? "Examine the Dwarf’s corpse."
          : "Continue to the next forgotten monument.",
      );
    }
    if (npcId === CORPSE_OF_DWARF)
      return cond === 1
        ? page(
            "Corpse of a Dwarf",
            "There is a journal in its hand.",
            '<a action="bypass -h quest 31 journal">Take the journal.</a>',
          )
        : page("Corpse of a Dwarf", "You have already examined the corpse.");
    const step = MONUMENTS.indexOf(npcId) + 1;
    if (cond === step + 2)
      return page(
        `Forgotten Monument ${step}`,
        "Ancient hieroglyphs and diagrams cover the monument. Clean the surface and examine the markings closely.",
        `<a action="bypass -h quest 31 monument${step}">Examine the monument.</a>`,
      );
    return page(
      `Forgotten Monument ${step}`,
      cond > step + 2
        ? "You have already examined this monument."
        : "Examine the previous monument first.",
    );
  },
};
