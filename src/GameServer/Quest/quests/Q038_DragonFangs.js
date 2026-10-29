const LUIS = 7386;
const IRIS = 7034;
const ROHMER = 7344;
const FEATHER = 7173;
const TOTEM = 7174;
const DRAGON = 7175;
const IRIS_LETTER = 7176;
const ROHMER_LETTER = 7177;
const QUEST_ITEMS = [FEATHER, TOTEM, DRAGON, IRIS_LETTER, ROHMER_LETTER];
const REWARDS = [[45, 5200], [627, 1500], [1123, 3200], [605, 3200]];
const DROPS = {
  1100: [1, FEATHER, 100, 1],
  357: [1, FEATHER, 100, 1],
  1101: [6, DRAGON, 50, 0.5],
  356: [6, DRAGON, 50, 0.5],
};
const ACCEPT = "ItemSound.quest_accept";
const ITEMGET = "ItemSound.quest_itemget";
const MIDDLE = "ItemSound.quest_middle";
const FINISH = "ItemSound.quest_finish";
function steps() {
  return invoke("GameServer/Quest/QuestStep");
}
function count(state, itemId) {
  return state.session.actor.backpack.fetchItemFromSelfId(itemId)?.fetchAmount() || 0;
}
function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}

module.exports = {
  id: 38,
  name: "Dragon Fangs",
  npcs: [LUIS, IRIS, ROHMER],
  startNpcs: [LUIS],
  killNpcs: [1100, 357, 1101, 356],
  questItems: QUEST_ITEMS,
  eventNpc: (event) => ({
    start: LUIS, feathers: LUIS, iris: IRIS, rohmer: ROHMER,
    returnIris: IRIS, reward: IRIS,
  })[event] ?? null,
  async onEvent(state, event) {
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (!(Number(state.session.actor.fetchLevel()) >= 19)) return null;
      await steps().apply(state, { variables: { ...state.variables, cond: "1" } });
      state.playSound(ACCEPT);
      return page("Luis", "Collect 100 Feather Ornaments from Langk Lizardman Sentinels and Lieutenants along the southern shoreline road.");
    }
    if (!state.isStarted()) return null;
    const cond = state.getInt("cond");
    if (event === "feathers" && cond === 2) {
      if (count(state, FEATHER) < 100)
        return page("Luis", "Bring me 100 Feather Ornaments from Langk Lizardman Sentinels and Lieutenants.");
      await steps().apply(state, {
        takes: [[FEATHER, 100]],
        gives: [[TOTEM, 1]],
        variables: { ...state.variables, cond: "3" },
      });
      state.playSound(MIDDLE);
      return page("Luis", "This tooth carries ominous magic. Show it to Magister Iris at the Temple of Einhasad in Gludin Village.");
    }
    if (event === "iris" && cond === 3) {
      if (count(state, TOTEM) < 1)
        return page("Iris", "Where is the Tooth of Totem? Bring it to me so I can examine its sorcery.");
      await steps().apply(state, {
        takes: [[TOTEM, 1]],
        gives: [[IRIS_LETTER, 1]],
        variables: { ...state.variables, cond: "4" },
      });
      state.playSound(MIDDLE);
      return page("Iris", "Take my letter to Magister Rohmer at the Temple of Einhasad in Gludio Castle Town and bring back his reply.");
    }
    if (event === "rohmer" && cond === 4) {
      if (count(state, IRIS_LETTER) < 1)
        return page("Rohmer", "Bring me the Letter of Iris before I can prepare a reply.");
      await steps().apply(state, {
        takes: [[IRIS_LETTER, 1]],
        gives: [[ROHMER_LETTER, 1]],
        variables: { ...state.variables, cond: "5" },
      });
      state.playSound(MIDDLE);
      return page("Rohmer", "Take these notes back to Magister Iris in Gludin Village. Do not lose the letter!");
    }
    if (event === "returnIris" && cond === 5) {
      if (count(state, ROHMER_LETTER) < 1)
        return page("Iris", "Where is the Letter of Rohmer? We cannot proceed without it.");
      await steps().apply(state, {
        takes: [[ROHMER_LETTER, 1]],
        variables: { ...state.variables, cond: "6" },
      });
      state.playSound(MIDDLE);
      return page("Iris", "Bring 50 dragon teeth from Langk Lizardman Shamans and Leaders in the deepest parts of their dwellings. We need them to cancel the sorcery.");
    }
    if (event === "reward" && cond === 7) {
      if (count(state, DRAGON) < 50)
        return page("Iris", "Bring me 50 dragon teeth from Langk Lizardman Shamans and Leaders.");
      const [itemId, baseAdena] = REWARDS[Math.floor(Math.random() * REWARDS.length)];
      const adena = Math.max(0, Math.floor(baseAdena * invoke("GameServer/ProgressionRates").profile().questAdena));
      const gives = [[itemId, 1]];
      if (adena > 0) gives.push([57, adena]);
      await steps().apply(state, {
        takes: steps().heldItems(state, QUEST_ITEMS),
        gives,
        status: "completed",
      });
      state.playSound(FINISH);
      return page("Iris", "Now I can cancel the Langk Lizardmen's sorcery. Please accept this gift from the guards and me. Thank you for your help!");
    }
    return null;
  },
  async onTalk(state, npc) {
    const id = Number(npc.fetchSelfId());
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted()) {
      if (id !== LUIS) return page("Quest", "You are not on a quest that involves this NPC.");
      return Number(state.session.actor.fetchLevel()) >= 19
        ? page("Luis", "Langk Lizardmen are attacking travelers along the southern shoreline road. Will you help the guards?", '<a action="bypass -h quest 38 start">I will help.</a>')
        : page("Luis", "This task requires level 19 or above.");
    }
    const cond = state.getInt("cond");
    if (id === LUIS) {
      if (cond === 1)
        return page("Luis", `Collect 100 Feather Ornaments from Langk Lizardman Sentinels and Lieutenants (${count(state, FEATHER)}/100).`);
      if (cond === 2)
        return page("Luis", "Let me examine the Feather Ornaments. Will you take this mysterious tooth to Magister Iris?", '<a action="bypass -h quest 38 feathers">Give Luis the ornaments.</a>');
      return page("Luis", "Show the mysterious tooth to Magister Iris at the Temple of Einhasad in Gludin Village.");
    }
    if (id === ROHMER) {
      if (cond === 4)
        return page("Rohmer", "Let me read Iris's letter. My notes may help her stop the Langk Lizardmen's sorcery.", '<a action="bypass -h quest 38 rohmer">Give Rohmer the letter.</a>');
      return page("Rohmer", cond > 4
        ? "Take my reply to Magister Iris in Gludin Village. The sorcery grows stronger by the day."
        : "Speak with Magister Iris about the Langk Lizardmen's sorcery.");
    }
    if (id === IRIS) {
      if (cond === 3)
        return page("Iris", "Luis sent you? This tooth carries powerful sorcery. Magister Rohmer in Gludio Castle Town may know how to stop it.", '<a action="bypass -h quest 38 iris">Show Iris the tooth.</a>');
      if (cond === 4)
        return page("Iris", "Take my letter to Magister Rohmer at the Temple of Einhasad in Gludio Castle Town. This is urgent!");
      if (cond === 5)
        return page("Iris", "You have returned! Give me Rohmer's reply so we can prepare to cancel the sorcery.", '<a action="bypass -h quest 38 returnIris">Give Iris the reply.</a>');
      if (cond === 6)
        return page("Iris", `Bring 50 dragon teeth from Langk Lizardman Shamans and Leaders in their dwellings (${count(state, DRAGON)}/50).`);
      if (cond === 7)
        return page("Iris", "With 50 dragon teeth, I can cancel the sorcery. Please give me the ingredients.", '<a action="bypass -h quest 38 reward">Here are the dragon teeth.</a>');
    }
    return page("Quest", "Continue your work for Guard Luis.");
  },
  async onKill(state, npc) {
    if (!state.isStarted()) return;
    const drop = DROPS[Number(npc.fetchSelfId())];
    if (!drop || state.getInt("cond") !== drop[0]) return;
    const [cond, itemId, limit, chance] = drop;
    const current = count(state, itemId);
    const amount = Math.max(0, Math.min(1, limit - current));
    if (amount && chance < 1 && Math.random() >= chance) return;
    const done = current + amount >= limit;
    await steps().apply(state, {
      gives: amount ? [[itemId, amount]] : [],
      variables: { ...state.variables, cond: String(done ? cond + 1 : cond) },
    });
    state.playSound(done ? MIDDLE : ITEMGET);
  },
};
