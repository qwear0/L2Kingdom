const MAXIMILIAN = 7120;
const GENTLER = 7094;
const MIKI = 8706;
const ALLIGATOR = 135;
const MAP = 7165;
const HERB = 7166;
const SUEDE = 1866;
const THREAD = 1868;
const SPIRIT_ORE = 3031;
const REWARDS = { cat: 6843, racoon: 7680, rabbit: 7683 };
const SOUND_ACCEPT = "ItemSound.quest_accept";
const SOUND_ITEMGET = "ItemSound.quest_itemget";
const SOUND_MIDDLE = "ItemSound.quest_middle";
const SOUND_FINISH = "ItemSound.quest_finish";
function steps() {
  return invoke("GameServer/Quest/QuestStep");
}
function count(state, itemId) {
  return (
    state.session.actor.backpack.fetchItemFromSelfId(itemId)?.fetchAmount() || 0
  );
}
function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}

module.exports = {
  id: 32,
  name: "An Obvious Lie",
  npcs: [MAXIMILIAN, GENTLER, MIKI],
  startNpcs: [MAXIMILIAN],
  killNpcs: [ALLIGATOR],
  questItems: [MAP, HERB],
  partyKill: { condition: 3, killerWeight: 3, rangeAfterSelection: true },
  eventNpc: (event) =>
    ({
      start: MAXIMILIAN,
      map: GENTLER,
      miki: MIKI,
      herbs: GENTLER,
      ore: GENTLER,
      message: MIKI,
      return: GENTLER,
      cat: GENTLER,
      racoon: GENTLER,
      rabbit: GENTLER,
    })[event] ?? null,
  async onEvent(state, event) {
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (!(Number(actor.fetchLevel()) >= 45)) return null;
      await steps().apply(state, { variables: { ...state.variables, cond: "1" } });
      state.playSound(SOUND_ACCEPT);
      return page("Maximilian", "Visit Gentler at the magic shop in Giran.");
    }
    if (!state.isStarted()) return null;
    const cond = state.getInt("cond");
    if (event === "map" && cond === 1) {
      await steps().apply(state, {
        gives: [[MAP, 1]],
        variables: { ...state.variables, cond: "2" },
      });
      state.playSound(SOUND_MIDDLE);
      return page("Gentler", "Take this map to Miki the Cat on Alligator Island.");
    }
    if (event === "miki" && cond === 2) {
      if (count(state, MAP) < 1) return null;
      await steps().apply(state, {
        takes: [[MAP, 1]],
        variables: { ...state.variables, cond: "3" },
      });
      state.playSound(SOUND_MIDDLE);
      return page("Miki the Cat", "Gather 20 Medicinal Herbs from Alligators and take them to Gentler.");
    }
    if (event === "herbs" && cond === 4) {
      if (count(state, HERB) < 20) return null;
      await steps().apply(state, {
        takes: [[HERB, 20]],
        variables: { ...state.variables, cond: "5" },
      });
      state.playSound(SOUND_MIDDLE);
      return page("Gentler", "Bring me 500 Spirit Ore.");
    }
    if (event === "ore" && cond === 5) {
      if (count(state, SPIRIT_ORE) < 500)
        return page("Gentler", "You still need 500 Spirit Ore.");
      await steps().apply(state, {
        takes: [[SPIRIT_ORE, 500]],
        variables: { ...state.variables, cond: "6" },
      });
      state.playSound(SOUND_MIDDLE);
      return page("Gentler", "Miki was to pay for the materials. Return to him on Alligator Island.");
    }
    if (event === "message" && cond === 6) {
      await steps().apply(state, { variables: { ...state.variables, cond: "7" } });
      state.playSound(SOUND_MIDDLE);
      return page("Miki the Cat", "Gentler promised to make you an accessory. Ask him for it!");
    }
    if (event === "return" && cond === 7) {
      await steps().apply(state, { variables: { ...state.variables, cond: "8" } });
      state.playSound(SOUND_MIDDLE);
      return page("Gentler", "Bring 500 Suede and 1,000 Thread, then choose your ears.");
    }
    if (Object.hasOwn(REWARDS, event) && cond === 8) {
      if (count(state, SUEDE) < 500 || count(state, THREAD) < 1000)
        return page("Gentler", "You need 500 Suede and 1,000 Thread.");
      await steps().apply(state, {
        takes: [[SUEDE, 500], [THREAD, 1000], ...steps().heldItems(state, [MAP, HERB])],
        gives: [[REWARDS[event], 1]],
        status: "completed",
      });
      state.playSound(SOUND_FINISH);
      return page("Gentler", "Your custom ears are ready.");
    }
    return null;
  },
  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted())
      return npcId === MAXIMILIAN
        ? Number(actor.fetchLevel()) >= 45
          ? page(
              "Maximilian",
              "Will you investigate an obvious lie?",
              '<a action="bypass -h quest 32 start">Accept.</a>',
            )
          : page("Maximilian", "This task requires level 45 or above.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    const cond = state.getInt("cond");
    if (npcId === MAXIMILIAN) return page("Maximilian", "Speak with Gentler in Giran.");
    if (npcId === MIKI) {
      if (cond === 2)
        return page(
          "Miki the Cat",
          "You brought Gentler's map.",
          '<a action="bypass -h quest 32 miki">Give Miki the map.</a>',
        );
      if (cond === 6)
        return page(
          "Miki the Cat",
          "I have a message for Gentler.",
          '<a action="bypass -h quest 32 message">Receive Miki\u2019s message.</a>',
        );
      return page(
        "Miki the Cat",
        cond === 3
          ? `Keep gathering herbs (${count(state, HERB)}/20).`
          : "Return to Gentler.",
      );
    }
    if (cond === 1)
      return page(
        "Gentler",
        "Take this map to Miki the Cat on Alligator Island.",
        '<a action="bypass -h quest 32 map">Receive the map.</a>',
      );
    if (cond === 4)
      return page(
        "Gentler",
        `You have ${count(state, HERB)}/20 herbs.`,
        '<a action="bypass -h quest 32 herbs">Hand over the herbs.</a>',
      );
    if (cond === 5)
      return page(
        "Gentler",
        `You have ${count(state, SPIRIT_ORE)}/500 Spirit Ore.`,
        '<a action="bypass -h quest 32 ore">Hand over the ore.</a>',
      );
    if (cond === 7)
      return page(
        "Gentler",
        "What did Miki say?",
        '<a action="bypass -h quest 32 return">Deliver Miki\u2019s message.</a>',
      );
    if (cond === 8)
      return page(
        "Gentler",
        "For 500 Suede and 1,000 Thread, which ears would you like?",
        '<a action="bypass -h quest 32 cat">Cat ears.</a><br><a action="bypass -h quest 32 racoon">Raccoon ears.</a><br><a action="bypass -h quest 32 rabbit">Rabbit ears.</a>',
      );
    return page("Gentler", "Continue your errand for Miki on Alligator Island.");
  },
  async onKill(state) {
    if (!state.isStarted() || state.getInt("cond") !== 3) return;
    const current = count(state, HERB);
    const amount = Math.max(0, Math.min(1, 20 - current));
    const done = current + amount >= 20;
    await steps().apply(state, {
      gives: amount ? [[HERB, amount]] : [],
      variables: { ...state.variables, cond: done ? "4" : "3" },
    });
    state.playSound(done ? SOUND_MIDDLE : SOUND_ITEMGET);
  },
};
