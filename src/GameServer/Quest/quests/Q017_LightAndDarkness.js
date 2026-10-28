const HIERARCH = 8517;
const ALTARS = [8508, 8509, 8510, 8511];
const BLOOD = 7168;
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
  id: 17,
  name: "Light and Darkness",
  npcs: [HIERARCH, ...ALTARS],
  startNpcs: [HIERARCH],
  eventNpc(event) {
    if (event === "start") return HIERARCH;
    const step = Number(String(event).replace("altar", ""));
    return Number.isInteger(step) && step >= 1 && step <= ALTARS.length
      ? ALTARS[step - 1]
      : null;
  },
  async onEvent(state, event) {
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (!(Number(actor.fetchLevel()) >= 61)) return null;
      await steps().apply(state, {
        gives: [[BLOOD, 4]],
        variables: { ...state.variables, cond: "1" },
      });
      state.playSound(SOUND_ACCEPT);
      return page("Hierarch", "Prove your faith by sprinkling this Blood of Saint on the four Altars of Saints in order. Begin by the path at the entrance to the Valley of Saints, then return to me.");
    }
    const step = Number(String(event).replace("altar", ""));
    if (
      Number.isInteger(step) &&
      step >= 1 &&
      step <= ALTARS.length &&
      state.isStarted() &&
      state.getInt("cond") === step
    ) {
      if (!steps().heldItems(state, [BLOOD]).length)
        return page(`Saint Altar ${step}`, "You need the Blood of Saint. Return to Hierarch if you have lost it.");
      await steps().apply(state, {
        takes: [[BLOOD, 1]],
        variables: { ...state.variables, cond: String(step + 1) },
      });
      state.playSound(SOUND_MIDDLE);
      return page(`Saint Altar ${step}`, "You sprinkle the Blood of Saint on the altar.");
    }
    return null;
  },
  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted())
      return npcId === HIERARCH
        ? Number(actor.fetchLevel()) >= 61
          ? page(
              "Hierarch",
              "Are you ready to prove your faith in our work? Sprinkle the Blood of Saint on the Altars of Saints and return to me.",
              '<a action="bypass -h quest 17 start">Accept.</a>',
            )
          : page("Hierarch", "This quest requires level 61 or above.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    const cond = state.getInt("cond");
    if (npcId === HIERARCH) {
      // All blood is normally spent by the last altar, so the terminal
      // stage must win over the unfinished ritual's lost-item reset.
      if (cond === 5) {
        await steps().apply(state, {
          takes: steps().heldItems(state, [BLOOD]),
          status: "completed",
          exp: 105527,
        });
        state.playSound(SOUND_FINISH);
        return page("Hierarch", "Well done! Our trust in you has proven well placed. Someday you may truly be one of us. Accept your reward.");
      }
      if (!steps().heldItems(state, [BLOOD]).length) {
        await steps().abandon(state, [BLOOD]);
        return page("Hierarch", "You lost the Blood of Saint and betrayed our trust! You are no longer our brother. This mission has ended without a reward.");
      }
      return page("Hierarch", "Continue to the next Altar of Saints.");
    }
    const step = ALTARS.indexOf(npcId) + 1;
    if (cond === step && !steps().heldItems(state, [BLOOD]).length)
      return page(`Saint Altar ${step}`, "You need the Blood of Saint. Return to Hierarch if you have lost it.");
    if (cond === step)
      return page(
        `Saint Altar ${step}`,
        "Offer the Blood of a Saint.",
        `<a action="bypass -h quest 17 altar${step}">Sprinkle the blood.</a>`,
      );
    return page(
      `Saint Altar ${step}`,
      cond > step
        ? "You have already sprinkled blood on this altar."
        : "Sprinkle blood on the previous altar first.",
    );
  },
};
