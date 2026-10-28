const HIERARCH = 8517;
const ALTARS = [8512, 8513, 8514, 8515, 8516];
const CRYSTAL = 7167;
const SOUND_ACCEPT = "ItemSound.quest_accept";
const SOUND_MIDDLE = "ItemSound.quest_middle";
const SOUND_FINISH = "ItemSound.quest_finish";
function steps() {
  return invoke("GameServer/Quest/QuestStep");
}
function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}

async function finish(state) {
  await steps().apply(state, {
    takes: steps().heldItems(state, [CRYSTAL]),
    status: "completed",
    exp: 221958,
  });
  state.playSound(SOUND_FINISH);
  return page("Hierarch", "You have broken all five seals. Welcome to the Benandanti Cartel, brother! Accept your reward.");
}

module.exports = {
  id: 16,
  name: "The Coming Darkness",
  npcs: [HIERARCH, ...ALTARS],
  startNpcs: [HIERARCH],
  eventNpc(event) {
    if (event === "start" || event === "reward") return HIERARCH;
    const step = Number(String(event).replace("altar", ""));
    return Number.isInteger(step) && step >= 1 && step <= ALTARS.length
      ? ALTARS[step - 1]
      : null;
  },
  async onEvent(state, event) {
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (!(Number(actor.fetchLevel()) >= 62)) return null;
      await steps().apply(state, {
        gives: [[CRYSTAL, 5]],
        variables: { ...state.variables, cond: "1" },
      });
      state.playSound(SOUND_ACCEPT);
      return page("Hierarch", "Use these five Crystals of Seal to break the seals at the Evil Altars in order, beginning near the entrance to the Valley of Saints. Then return to me.");
    }
    const step = Number(String(event).replace("altar", ""));
    if (
      Number.isInteger(step) &&
      step >= 1 &&
      step <= ALTARS.length &&
      state.isStarted() &&
      state.getInt("cond") === step
    ) {
      if (!steps().heldItems(state, [CRYSTAL]).length)
        return page(`Evil Altar ${step}`, "You need a Crystal of Seal. Return to Hierarch if you have lost the crystals.");
      await steps().apply(state, {
        takes: [[CRYSTAL, 1]],
        variables: { ...state.variables, cond: String(step + 1) },
      });
      state.playSound(SOUND_MIDDLE);
      return page(`Evil Altar ${step}`, "The crystal breaks the seal.");
    }
    if (event === "reward" && state.isStarted() && state.getInt("cond") === 6)
      return finish(state);
    return null;
  },
  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted())
      return npcId === HIERARCH
        ? Number(actor.fetchLevel()) >= 62
          ? page(
              "Hierarch",
              "We trust you with an important mission. Will you use our crystals to break the seals in the Valley of Saints?",
              '<a action="bypass -h quest 16 start">Accept.</a>',
            )
          : page("Hierarch", "This quest requires level 62 or above.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    const cond = state.getInt("cond");
    if (npcId === HIERARCH) {
      // The last altar legitimately uses the final crystal. Complete that
      // stage before interpreting an empty inventory as a lost-item failure.
      if (cond === 6) return finish(state);
      if (!steps().heldItems(state, [CRYSTAL]).length) {
        await steps().abandon(state, [CRYSTAL]);
        return page("Hierarch", "You lost the crystals and betrayed our trust! You are no longer our brother. This mission has ended without a reward.");
      }
      return page("Hierarch", "Continue to the next Evil Altar and break its seal.");
    }
    const step = ALTARS.indexOf(npcId) + 1;
    if (cond === step && !steps().heldItems(state, [CRYSTAL]).length)
      return page(`Evil Altar ${step}`, "You need a Crystal of Seal. Return to Hierarch if you have lost the crystals.");
    if (cond === step)
      return page(
        `Evil Altar ${step}`,
        "Use a Crystal of Seal.",
        `<a action="bypass -h quest 16 altar${step}">Break the seal.</a>`,
      );
    return page(
      `Evil Altar ${step}`,
      cond > step
        ? "This seal has already been broken."
        : "Break the previous seal first.",
    );
  },
};
