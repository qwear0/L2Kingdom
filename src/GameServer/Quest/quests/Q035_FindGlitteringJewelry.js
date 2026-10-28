const ELLIE = 7091,
  FELTON = 7879,
  ALLIGATOR = 135,
  ROUGH = 7162,
  ORIHARUKON = 1893,
  NUGGET = 1873,
  THONS = 4044,
  BOX = 7077;
const { count, page, formalCondition } = require("./FormalWear");
const A = "ItemSound.quest_accept",
  I = "ItemSound.quest_itemget",
  M = "ItemSound.quest_middle",
  F = "ItemSound.quest_finish";
function steps() {
  return invoke("GameServer/Quest/QuestStep");
}
module.exports = {
  id: 35,
  name: "Find Glittering Jewelry",
  npcs: [ELLIE, FELTON],
  startNpcs: [ELLIE],
  killNpcs: [ALLIGATOR],
  questItems: [ROUGH],
  partyKill: { condition: 2, killerWeight: 1, rangeAfterSelection: false },
  eventNpc: (e) =>
    ({ start: ELLIE, felton: FELTON, ellie: ELLIE, reward: ELLIE })[e] ?? null,
  async onEvent(s, e) {
    if (e === "start" && !s.isStarted() && !s.isCompleted()) {
      if (
        !(Number(s.session.actor.fetchLevel()) >= 60) ||
        formalCondition(s.session) !== 6
      )
        return null;
      await steps().apply(s, { variables: { ...s.variables, cond: "1" } });
      s.playSound(A);
      return page("Ellie", "Find Wharf Manager Felton in Giran Harbor. My jewel shipment has gone missing.");
    }
    if (!s.isStarted()) return null;
    const cond = s.getInt("cond");
    if (e === "felton" && cond === 1) {
      await steps().apply(s, { variables: { ...s.variables, cond: "2" } });
      s.playSound(M);
      return page("Felton", "Hunt Alligators on Alligator Island for 10 Rough Jewels and take them to Ellie.");
    }
    if (e === "ellie" && cond === 3) {
      if (count(s, ROUGH) < 10) return null;
      await steps().apply(s, {
        takes: [[ROUGH, 10]],
        variables: { ...s.variables, cond: "4" },
      });
      s.playSound(M);
      return page("Ellie", "Bring 5 Oriharukon, 500 Silver Nuggets and 150 Thons.");
    }
    if (e === "reward" && cond === 4) {
      if (
        count(s, ORIHARUKON) < 5 ||
        count(s, NUGGET) < 500 ||
        count(s, THONS) < 150
      )
        return page("Ellie", "You need 5 Oriharukon, 500 Silver Nuggets and 150 Thons.");
      await steps().apply(s, {
        takes: [[ORIHARUKON, 5], [NUGGET, 500], [THONS, 150], ...steps().heldItems(s, [ROUGH])],
        gives: [[BOX, 1]],
        status: "completed",
      });
      s.playSound(F);
      return page("Ellie", "Here is the Jewel Box. Take it to Leikar in Aden.");
    }
    return null;
  },
  async onTalk(s, n) {
    const id = Number(n.fetchSelfId()),
      c = s.getInt("cond");
    if (s.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === ELLIE &&
        Number(s.session.actor.fetchLevel()) >= 60 &&
        formalCondition(s.session) === 6
        ? page(
            "Ellie",
            "I can make the jewelry for Leikar's formal wear.",
            '<a action="bypass -h quest 35 start">Accept.</a>',
          )
        : page("Ellie", "Come at level 60 or above with Leikar's order for the formal-wear components.");
    if (id === FELTON)
      return c === 1
        ? page(
            "Felton",
            "The shipment was lost near Alligator Island. Alligators swallowed the Rough Jewels.",
            '<a action="bypass -h quest 35 felton">Find the jewels.</a>',
          )
        : page("Felton", `Rough Jewels: ${count(s, ROUGH)}/10. Take them to Ellie when you have ten.`);
    return c === 3
      ? page(
          "Ellie",
          "You have the jewels.",
          '<a action="bypass -h quest 35 ellie">Hand them over.</a>',
        )
      : c === 4
        ? page(
            "Ellie",
            "Bring 5 Oriharukon, 500 Silver Nuggets and 150 Thons.",
            '<a action="bypass -h quest 35 reward">Receive the box.</a>',
          )
        : page("Ellie", c === 1 ? "Speak with Felton in Giran Harbor." : `Hunt Alligators on Alligator Island. Rough Jewels: ${count(s, ROUGH)}/10.`);
  },
  async onKill(s) {
    if (!s.isStarted() || s.getInt("cond") !== 2 || Math.random() >= 0.5) return;
    const current = count(s, ROUGH);
    const amount = Math.max(0, Math.min(1, 10 - current));
    const done = current + amount >= 10;
    await steps().apply(s, {
      gives: amount ? [[ROUGH, amount]] : [],
      variables: { ...s.variables, cond: done ? "3" : "2" },
    });
    s.playSound(done ? M : I);
  },
};
