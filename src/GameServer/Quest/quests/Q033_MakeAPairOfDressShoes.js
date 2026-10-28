const WOODLEY = 7838,
  IAN = 7164,
  LEIKAR = 8520,
  LEATHER = 1882,
  THREAD = 1868,
  ADENA = 57,
  SHOES = 7113;
const { count, page, formalCondition } = require("./FormalWear");
const A = "ItemSound.quest_accept",
  M = "ItemSound.quest_middle",
  F = "ItemSound.quest_finish";
function steps() {
  return invoke("GameServer/Quest/QuestStep");
}
module.exports = {
  id: 33,
  name: "Make a Pair of Dress Shoes",
  npcs: [WOODLEY, IAN, LEIKAR],
  startNpcs: [WOODLEY],
  questItems: [],
  eventNpc: (e) =>
    ({
      start: WOODLEY,
      leikar: LEIKAR,
      reply: WOODLEY,
      materials: WOODLEY,
      payment: IAN,
      reward: WOODLEY,
    })[e] ?? null,
  async onEvent(s, e) {
    if (e === "start" && !s.isStarted() && !s.isCompleted()) {
      if (
        !(Number(s.session.actor.fetchLevel()) >= 60) ||
        formalCondition(s.session) !== 7
      )
        return null;
      await steps().apply(s, { variables: { ...s.variables, cond: "1" } });
      s.playSound(A);
      return page("Woodley", "Ask Leikar in Aden for a fabric sample so I can match the shoes.");
    }
    if (!s.isStarted()) return null;
    const cond = s.getInt("cond");
    if (e === "leikar" && cond === 1) {
      await steps().apply(s, { variables: { ...s.variables, cond: "2" } });
      s.playSound(M);
      return page("Leikar", "There is no fabric to spare. Ask Woodley to match the color of my outfit.");
    }
    if (e === "reply" && cond === 2) {
      await steps().apply(s, { variables: { ...s.variables, cond: "3" } });
      s.playSound(M);
      return page("Woodley", "Bring 200 Leather, 600 Thread and 200,000 Adena.");
    }
    if (e === "materials" && cond === 3) {
      if (
        count(s, LEATHER) < 200 ||
        count(s, THREAD) < 600 ||
        count(s, ADENA) < 200000
      )
        return page("Woodley", "You need 200 Leather, 600 Thread and 200,000 Adena.");
      await steps().apply(s, {
        takes: [[ADENA, 200000], [LEATHER, 200], [THREAD, 600]],
        variables: { ...s.variables, cond: "4" },
      });
      s.playSound(M);
      return page("Woodley", "Pay Trader Ian in Ivory Tower 300,000 Adena, then return here.");
    }
    if (e === "payment" && cond === 4) {
      if (count(s, ADENA) < 300000)
        return page("Ian", "You need 300,000 Adena.");
      await steps().apply(s, {
        takes: [[ADENA, 300000]],
        variables: { ...s.variables, cond: "5" },
      });
      s.playSound(M);
      return page("Ian", "Return to Woodley in Aden.");
    }
    if (e === "reward" && cond === 5) {
      await steps().apply(s, { gives: [[SHOES, 1]], status: "completed" });
      s.playSound(F);
      return page("Woodley", "Here is the Dress Shoe Box. Take it to Leikar.");
    }
    return null;
  },
  async onTalk(s, n) {
    const id = Number(n.fetchSelfId());
    if (s.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === WOODLEY
        ? Number(s.session.actor.fetchLevel()) >= 60 &&
          formalCondition(s.session) === 7
          ? page(
              "Woodley",
              "I can make dress shoes to match Leikar's formal wear.",
              '<a action="bypass -h quest 33 start">Accept.</a>',
            )
          : page("Woodley", "You must be level 60 or above and have Leikar's order for dress shoes.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    const c = s.getInt("cond");
    if (id === LEIKAR)
      return c === 1
        ? page(
            "Leikar",
            "Woodley sent you for a fabric sample?",
            '<a action="bypass -h quest 33 leikar">Ask for a sample.</a>',
          )
        : page("Leikar", "Return to Woodley.");
    if (id === IAN)
      return c === 4
        ? page(
            "Ian",
            "Pay 300,000 Adena.",
            '<a action="bypass -h quest 33 payment">Pay.</a>',
          )
        : page("Ian", c === 5 ? "I received your payment. Return to Woodley." : "Woodley will send you when ready.");
    if (c === 1)
      return page("Woodley", "Ask Leikar in Aden for a fabric sample.");
    if (c === 2)
      return page(
        "Woodley",
        "What did Leikar say?",
        '<a action="bypass -h quest 33 reply">Reply.</a>',
      );
    if (c === 3)
      return page(
        "Woodley",
        "Bring 200 Leather, 600 Thread and 200,000 Adena.",
        '<a action="bypass -h quest 33 materials">Hand them over.</a>',
      );
    return c === 5
      ? page(
          "Woodley",
          "Your shoes are ready.",
          '<a action="bypass -h quest 33 reward">Receive the Dress Shoe Box.</a>',
        )
      : page("Woodley", "Pay Trader Ian in Ivory Tower 300,000 Adena.");
  },
};
