const ALEXIS = 7842,
  LEIKAR = 8520,
  JEREMY = 8521,
  MIST = 8627,
  CLOTH = 7076,
  BOX = 7077,
  KIT = 7078,
  SHOES = 7113,
  RING = 7164,
  WINE = 7160,
  COOKIES = 7159,
  WEAR = 6408;
const { count, page } = require("./FormalWear");
const A = "ItemSound.quest_accept",
  M = "ItemSound.quest_middle",
  F = "ItemSound.quest_finish";
function steps() {
  return invoke("GameServer/Quest/QuestStep");
}
function hasComponents(s) {
  return count(s, BOX) >= 1 && count(s, CLOTH) >= 1 && count(s, KIT) >= 1;
}
module.exports = {
  id: 37,
  name: "Make Formal Wear",
  npcs: [ALEXIS, LEIKAR, JEREMY, MIST],
  startNpcs: [ALEXIS],
  questItems: [RING, WINE, COOKIES],
  eventNpc: (e) =>
    ({
      start: ALEXIS,
      ring: LEIKAR,
      wine: JEREMY,
      mist: MIST,
      cookies: JEREMY,
      components: LEIKAR,
      shoes: LEIKAR,
      reward: LEIKAR,
    })[e] ?? null,
  async onEvent(s, e) {
    if (e === "start" && !s.isStarted() && !s.isCompleted()) {
      if (!(Number(s.session.actor.fetchLevel()) >= 60)) return null;
      await steps().apply(s, { variables: { ...s.variables, cond: "1" } });
      s.playSound(A);
      return page("Alexis", "Speak with Maid Leikar in Aden. She can make formal wear for you.");
    }
    if (!s.isStarted()) return null;
    const cond = s.getInt("cond");
    if (e === "ring" && cond === 1) {
      await steps().apply(s, {
        gives: [[RING, 1]],
        variables: { ...s.variables, cond: "2" },
      });
      s.playSound(M);
      return page("Leikar", "Take the Signet Ring to Chef Jeremy at the Hot Springs and bring back my cookies.");
    }
    if (e === "wine" && cond === 2) {
      if (count(s, RING) < 1) return null;
      await steps().apply(s, {
        takes: [[RING, 1]],
        gives: [[WINE, 1]],
        variables: { ...s.variables, cond: "3" },
      });
      s.playSound(M);
      return page("Jeremy", "While the cookies bake, take this Luxury Wine to Information Broker Mist at the Hot Springs.");
    }
    if (e === "mist" && cond === 3) {
      if (count(s, WINE) < 1) return null;
      await steps().apply(s, {
        takes: [[WINE, 1]],
        variables: { ...s.variables, cond: "4" },
      });
      s.playSound(M);
      return page("Mist", "Thank you. Return to Jeremy for Leikar's cookies.");
    }
    if (e === "cookies" && cond === 4) {
      await steps().apply(s, {
        gives: [[COOKIES, 1]],
        variables: { ...s.variables, cond: "5" },
      });
      s.playSound(M);
      return page("Jeremy", "Take this Box of Cookies to Leikar in Aden.");
    }
    if (e === "components" && cond === 5) {
      if (count(s, COOKIES) < 1) return null;
      await steps().apply(s, {
        takes: [[COOKIES, 1]],
        variables: { ...s.variables, cond: "6" },
      });
      s.playSound(M);
      return page("Leikar", "Bring Mysterious Cloth from Radia in Giran, a Jewel Box from Ellie in Giran, and a Sewing kit from Ferris in Aden.");
    }
    if (e === "shoes" && (cond === 5 || cond === 6)) {
      if (!hasComponents(s)) return page("Leikar", "Bring Mysterious Cloth, a Jewel Box and a Sewing kit.");
      // Source accepts already-held components at condition 5 as well as 6;
      // ownership of the items, not completion rows of Q34/Q35/Q36, is proof.
      await steps().apply(s, {
        takes: [[BOX, 1], [CLOTH, 1], [KIT, 1]],
        variables: { ...s.variables, cond: "7" },
      });
      s.playSound(M);
      return page("Leikar", "Now ask Woodley in Aden to make dress shoes and bring me the Dress Shoe Box.");
    }
    if (e === "reward" && cond === 7) {
      if (count(s, SHOES) < 1) return page("Leikar", "Bring the Dress Shoe Box from Woodley.");
      await steps().apply(s, {
        takes: [[SHOES, 1], ...steps().heldItems(s, [RING, WINE, COOKIES])],
        gives: [[WEAR, 1]],
        status: "completed",
      });
      s.playSound(F);
      return page("Leikar", "Your Formal Wear is ready.");
    }
    return null;
  },
  async onTalk(s, n) {
    const id = Number(n.fetchSelfId()),
      c = s.getInt("cond");
    if (s.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === ALEXIS && Number(s.session.actor.fetchLevel()) >= 60
        ? page(
            "Alexis",
            "Would you like formal wear?",
            '<a action="bypass -h quest 37 start">Accept.</a>',
          )
        : page("Alexis", "Come back at level 60.");
    if (id === ALEXIS) return page("Alexis", "Speak with Maid Leikar in Aden.");
    if (id === JEREMY) {
      if (c === 2)
        return page(
          "Jeremy",
          "Give me the Signet Ring.",
          '<a action="bypass -h quest 37 wine">Exchange it.</a>',
        );
      if (c === 4)
        return page(
          "Jeremy",
          "I have cookies for Leikar.",
          '<a action="bypass -h quest 37 cookies">Receive the cookies.</a>',
        );
      return page("Jeremy", c === 3 ? "Take the Luxury Wine to Mist at the Hot Springs." : "Continue your errand for Leikar.");
    }
    if (id === MIST)
      return c === 3
        ? page(
            "Mist",
            "Give me the Luxury Wine.",
            '<a action="bypass -h quest 37 mist">Hand it over.</a>',
          )
        : page("Mist", "Speak with Jeremy at the Hot Springs.");
    if (c === 1)
      return page(
        "Leikar",
        "Take this ring to Chef Jeremy at the Hot Springs.",
        '<a action="bypass -h quest 37 ring">Receive the ring.</a>',
      );
    if ((c === 5 || c === 6) && hasComponents(s))
      return page(
        "Leikar",
        "You have the Mysterious Cloth, Jewel Box and Sewing kit.",
        '<a action="bypass -h quest 37 shoes">Hand over the three components.</a>',
      );
    if (c === 5)
      return page(
        "Leikar",
        "Give me the cookies.",
        '<a action="bypass -h quest 37 components">Hand them over.</a>',
      );
    if (c === 6)
      return page("Leikar", "Bring Mysterious Cloth from Radia in Giran, a Jewel Box from Ellie in Giran, and a Sewing kit from Ferris in Aden.");
    if (c === 7)
      return page(
        "Leikar",
        "Bring the Dress Shoe Box from Woodley in Aden.",
        '<a action="bypass -h quest 37 reward">Receive Formal Wear.</a>',
      );
    return page("Leikar", "Continue your errands for Jeremy at the Hot Springs.");
  },
};
