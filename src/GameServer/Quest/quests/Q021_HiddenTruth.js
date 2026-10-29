// Mobius C4 a4c31517, Q00021_HiddenTruth; native personal scenes and atomic steps.
const F = require('../ForestOfTheDead');
const QUEST_ITEMS = [7140];
const START = 8522;
const html = (state, npc, file) => F.view(state, npc, file, PAGES);

module.exports = {
    id: 21, name: 'Hidden Truth', startNpcs: [START],
    npcs: [8522, 8523, 8524, 8525, 8526, 8348, 8349, 8350, 8328],
    questItems: QUEST_ITEMS, questSpawns: [8524, 8525], personalNpcs: [8524, 8525],
    canTalk: F.canTalk, onAbort: F.abort,
    eventNpc: event => F.eventNpc(event, START, PAGES),
    async onEvent(state, event) {
        const npc = F.liveTalk(state, F.eventNpc(event, START, PAGES));
        if (!npc) return null;
        if (event === 'start') return this.onTalk(state, npc);
        if (!F.acceptEvent(state, event) || state.isCompleted()) return null;
        const cond = state.getInt('cond');
        switch (event) {
            case '31522-02.htm':
                if (state.isStarted() || state.session.actor.fetchLevel() < 63) return null;
                await F.step(state, 1); break;
            case '31523-03.htm':
                if (!state.isStarted() || cond !== 1) return null;
                await F.step(state, 2);
                F.summonDuke(state); break;
            case '31524-06.htm':
                if (cond !== 2) return null;
                await F.step(state, 3, { variables: { end_walk: '0' } });
                F.summonDuke(state, true); break;
            case '31526-08.htm':
                if (cond !== 5) return null;
                break;
            case '31526-14.htm':
                if (cond !== 5 || F.has(state, 7140)) return null;
                await F.step(state, 6, { gives: [[7140, 1]] }); break;
            case '31328-05.htm':
                if (cond !== 7 || !F.has(state, 7140)) return null;
                await F.step(state, 0, { takes: [[7140, 1]], gives: [[7141, 1]], status: 'completed' });
                F.clear(state, 'guide'); F.clear(state, 'escort'); break;
            default:
                if (!state.isStarted()) return null;
        }
        return html(state, npc, event);
    },
    async onTalk(state, npc) {
        const id = npc.fetchSelfId(), cond = state.getInt('cond');
        if (!F.canTalk(state, npc)) return null;
        if (state.isCompleted()) return id === 8328 ? html(state, npc, '31328-06.htm') : F.done();
        if (!state.isStarted()) return id === START
            ? html(state, npc, state.session.actor.fetchLevel() >= 63 ? '31522-01.htm' : '31522-03.htm') : F.noQuest();
        let file;
        if (id === START) file = '31522-05.htm';
        else if (id === 8523) {
            if (cond === 1) file = '31523-01.htm';
            else {
                file = '31523-04.htm';
                if (cond === 2 || cond === 3) F.summonDuke(state);
            }
        } else if (id === 8524) {
            file = cond === 2 ? '31524-01.htm' : cond === 3 ? '31524-07.htm' : '31524-07a.htm';
            if (cond === 3 && !state.getInt('end_walk')) F.summonDuke(state, true);
        } else if (id === 8525 && (cond === 3 || cond === 4)) {
            file = state.getInt('end_walk') || cond === 4 ? '31525-02.htm' : '31525-01.htm';
            if (cond === 3 && state.getInt('end_walk')) await F.step(state, 4);
        } else if (id === 8526) {
            if ((cond === 3 && state.getInt('end_walk')) || cond === 4) {
                await F.step(state, 5);
                F.clear(state, 'guide'); F.clear(state, 'escort');
                file = '31526-01.htm';
            } else if (cond === 5) file = '31526-10.htm';
            else if (cond > 5) file = '31526-15.htm';
        } else if ([8348, 8349, 8350].includes(id) && [6, 7].includes(cond) && F.has(state, 7140)) {
            if (cond === 6 && !state.getInt(`priest${id}`)) {
                const variables = { [`priest${id}`]: '1' };
                const all = [8348, 8349, 8350].every(other => other === id || state.getInt(`priest${other}`));
                await F.step(state, all ? 7 : 6, { variables });
            }
            file = `${id + 23000}-01.htm`;
        } else if (id === 8328 && cond === 7 && F.has(state, 7140)) file = '31328-01.htm';
        return file ? html(state, npc, file) : F.noQuest();
    }
};

// Pinned source dialogue bodies are embedded below; only bypass syntax changes.
// Copyright (c) 2013 L2jMobius, MIT; see the attribution accompanying PAGES.

/*
 * Copyright (c) 2013 L2jMobius
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 * WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
 * IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
const PAGES = {
  "31328-01.htm": "<html><body>Innocentin:<br>\nYou came all this way just to find me? Yes, I was once a high priest, until some unfortunate political developments landed me here in this blasted library! But lately, I've seen signs that my luck might be changing...<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31328-02.htm\">\"Check out this crucifix!\"</a>\n</body></html>",
  "31328-02.htm": "<html><body>Innocentin:<br>\nZounds! Where did you find this?<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31328-03.htm\">\"Truthfully, ...\"</a>\n</body></html>",
  "31328-03.htm": "<html><body>Innocentin:<br>\nHe was always a dutiful Warrior, even after his death... may the gods watch over his soul!<br>\n... Why would he have you deliver this to me in person?<br>\nLately I've been having the same dream every night...<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31328-04.htm\">\"What is in your dream?\"</a>\n</body></html>",
  "31328-04.htm": "<html><body>Innocentin:<br>\nIn my dream, I'm looking down upon the Forest of the Dead... Suddenly, huge explosions rock the forest, and an army of undead rush towards me...<br>\nThis is bound to be a message from the gods!<br>\nThat's why I sent the one who held this crucifix there!<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31328-05.htm\">\"But he's dead!\"</a>\n</body></html>",
  "31328-05.htm": "<html><body>Innocentin:<br>\nI've learned much of the ways of the wild since my days at the temple.<br>\nIn times like these, dead souls must be appeased!<br>\n<font color=\"LEVEL\">Take this crucifix to Grand Magister Tifaren of the Dark Elves and ask him to perform necromancy.</font> He should be able to tell us what actually happened in the Forest of the Dead...\n</body></html>",
  "31328-06.htm": "<html><body>Innocentin:<br>\nTake the crucifix to Grand Magister Tifaren of the Dark Elves and perform the necromancy to summon the soul of the priest.<br>\nAsk him what happened in the Forest of the Dead...\n</body></html>",
  "31348-01.htm": "<html><body>High Priest Agripel:<br>\nMaybe he was the guy who long ago was expelled for keeping a devil worshipper with him! He's probably a beggar now. I don't waste my time on such filth.\n</body></html>",
  "31349-01.htm": "<html><body>Benedict:<br>\nMaybe the devil worshippers are hiding in a library somewhere, they still need to acquire knowledge. They couldn't be here in the temple!\n</body></html>",
  "31350-01.htm": "<html><body>Dominic:<br>\nIs Innocentin one of those devil worshippers executed in the old witch trials? I never heard of him, ask someone else.\n</body></html>",
  "31522-01.htm": "<html><body>Mysterious Wizard:<br>\nThere's a ghost hanging around that tombstone that's been bothering me lately.<br>\nCould you help me get rid of it?<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31522-02.htm\">\"I'll handle it.\"</a><br>\n<a action=\"bypass Script Q00021_HiddenTruth 31522-04.htm\">\"Why is it bothering you?\"</a>\n</body></html>",
  "31522-02.htm": "<html><body>Mysterious Wizard:<br>\nYou think you're up to it?<br>\nLook for the ghost in the tombstone.\n</body></html>",
  "31522-03.htm": "<html><body>Mysterious Wizard:<br>\nCome back when the Forest of the Dead won't eat you alive!<br>\n(This quest may only be undertaken by a character of level 63 and above.)\n</body></html>",
  "31522-04.htm": "<html><body>Mysterious Wizard:<br>\nIt may sound funny coming from a Dark Mage, but I don't like dealing with the dead. It's only trouble.<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31522-01.htm\">Back</a>\n</body></html>",
  "31522-05.htm": "<html><body>Mysterious Wizard:<br>\nWhat's this? Weren't you supposed to check the tombstone for that noisy ghost?\n</body></html>",
  "31523-01.htm": "<html><body>Tombstone:<br>\nAfter pushing away the moss, words appear engraved upon the stone. Could these words be used to conjure a ghost?<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31523-02.htm\">Say the words loudly.</a>\n</body></html>",
  "31523-02.htm": "<html><body>Tombstone:<br><br>\n<font color=\"LEVEL\">A jeweled scepter for the King and two Silver Spears for the von Hellmann family who protect him.</font><br>\n<a action=\"bypass Script Q00021_HiddenTruth 31523-03.htm\">Wait.</a>\n</body></html>",
  "31523-03.htm": "<html><body>Tombstone:<br>\nSoon a ghostly being appears...\n</body></html>",
  "31523-04.htm": "<html><body>Tombstone:<br>\nDon't look now, but there's a ghost behind you!\n</body></html>",
  "31524-01.htm": "<html><body>Ghost of von Hellmann:<br>\nWho is calling me? Why am I stuck here? Why can't I sleep?<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31524-02.htm\">\"Who are you? What's wrong?\"</a>\n</body></html>",
  "31524-02.htm": "<html><body>Ghost of von Hellmann:<br>\nI'm Duke Adolf von Hellmann, father of Alfred von Hellmann, who King Astor struck down with his spear.<br>\nWhy can't I rest in peace?! Who dares interrupt my sleep?<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31524-03.htm\">\"Tell me more.\"</a>\n</body></html>",
  "31524-03.htm": "<html><body>Ghost of von Hellmann:<br>\nWoe is me! This was once our home, but now we have no authority! Does this land still belong to the Elmore Kingdom?<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31524-04.htm\">\"Elmore still rules here.\"</a>\n</body></html>",
  "31524-04.htm": "<html><body>Ghost of von Hellmann:<br>\nElmore? Why can't I feel the King's grace? What's happened here?<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31524-05.htm\">\"I don't know.\"</a>\n</body></html>",
  "31524-05.htm": "<html><body>Ghost of von Hellmann:<br>\nFind out what happened here and who has owned this land while I was sleeping! What's become of my family?<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31524-06.htm\">\"I'll find out.\"</a>\n</body></html>",
  "31524-06.htm": "<html><body>Ghost of von Hellmann:<br>\nThank you. Find out what has transpired! Follow my servant and bring me the news!\n</body></html>",
  "31524-07.htm": "<html><body>Ghost of von Hellmann:<br>\nI've repeatedly sent my servants to help you! Find the bookshelf that contains the history of the forest. It's somewhere in the south.\n</body></html>",
  "31524-07a.htm": "<html><body>Ghost of von Hellmann:<br>\nYou haven't found out enough to tell me why I can't rest in peace!<br>\nBe gone!\n</body></html>",
  "31525-01.htm": "<html><body>Ghost of von Hellmann's Page:<br>\nI'm a guide of the Forest of the Dead. By the Lord's order, I'll lead you.\n</body></html>",
  "31525-02.htm": "<html><body>Ghost of von Hellmann's Page:<br>\nFind a book that discusses an old grudge.\n</body></html>",
  "31526-00.htm": "<html><body>Broken Bookshelf:<br>\nThe book that the ghost spoke of was easily found. The padlock was firmly locked.<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-01.htm\">Examine the padlock.</a><br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-02.htm\">Take the book from the sheif.</a>\n</body></html>",
  "31526-01.htm": "<html><body>Broken Bookshelf:<br>\nThe book that the ghost spoke of was easily found. The padlock was firmly locked.<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-02.htm\">Examine the padlock.</a><br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-03.htm\">Take the book from the shelf.</a>\n</body></html>",
  "31526-02.htm": "<html><body>Broken Bookshelf:<br>\nThe padlock is engraved with the mark of the Hellmann family. In spite of it's many years outside, once the outer layer of dust and soil is brushed away, it shines silvery in the light! This lock won't be easy to break.<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-01.htm\">Return</a>\n</body></html>",
  "31526-03.htm": "<html><body>Broken Bookshelf:<br>\nThe book's cover is lambskin that's been discolored by dark, red-colored stains.<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-04.htm\">Try opening the book.</a>\n</body></html>",
  "31526-04.htm": "<html><body>Broken Bookshelf:<br>\nThe dark red stains have damaged the pages of the book as well. Not much text is legible. All the years outside couldn't have helped, either!<br>\nDo you want to read it?<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-05.htm\">Try to read the book.</a>\n</body></html>",
  "31526-05.htm": "<html><body>\"Chapter 5, The Lord of the Forest of the Dead<br>\n... The lord of the Forest of the Dead... has existed from the beginning of...<br>\n... the ruling is, ... the form of taxation...<br>\n... rather than that, life and death itself... under the ruling authority...\"<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-06.htm\">Turn the page.</a>\n</body></html>",
  "31526-06.htm": "<html><body>\"Basically, to her, taxation means... no different from... Due to... who's the master of the Moon Face Flower and the Forest of the Dead... went under her... are vampires<br>\n... this is.... when examining the characteristics of..... sucking... by that one's power... that is... necessary to the subordinate of the lord of the forest...\"<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-07.htm\">Turn the page.</a>\n</body></html>",
  "31526-07.htm": "<html><body>\".... vampire.............. of the Forest of Dead...............<br>\n............... cursed............... working at...............\"<br>\nThe rest of the text is obscured by the red stains.<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-08.htm\">Put the book back onto the shelf.</a>\n</body></html>",
  "31526-08.htm": "<html><body>Broken Bookshelf:<br>\nWhen you're about to replace the book, you notice something lying on the ground. Maybe it fell out of the book...<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-12.htm\">Examine the object closely.</a>\n</body></html>",
  "31526-09.htm": "<html><body>Broken Bookshelf:<br>\nWhile examining the bookshelf, you notice something lying on the ground. Maybe it fell out of the book.<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-12.htm\">Examine the object closely.</a>\n</body></html>",
  "31526-10.htm": "<html><body>Broken Bookshelf:<br>\nWhen you're about to replace the book, you notice something lying on the ground. Maybe it fell out of the book.<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-12.htm\">Examine the object closely.</a>\n</body></html>",
  "31526-11.htm": "<html><body>Broken Bookshelf:<br>\nWhile examining the area around the bookshelf, you see something lying on the ground. Perhaps it fell when you were taking out the book.<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-12.htm\">Examine the object closely.</a>\n</body></html>",
  "31526-12.htm": "<html><body>Broken Bookshelf:<br>\nIt's a metallic cross. It seems to be an Einhasad's Crucifix!<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-14.htm\">Pick up the cross.</a><br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-13.htm\">Ignore the cross.</a>\n</body></html>",
  "31526-13.htm": "<html><body>Broken Bookshelf:<br>\nAn old bookshelf is standing in front of you. It's extremely worn, and the lower section is used as a locker. A few books are arranged on the shelves, and the locker is secured with a padlock which bears the mark of the Hellmann Family.<br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-04.htm\">Take out a book and read it.</a><br>\n<a action=\"bypass Script Q00021_HiddenTruth 31526-09.htm\">Examine the area around the bookshelf.</a>\n</body></html>",
  "31526-14.htm": "<html><body>Broken Bookshelf:<br>\nYou feel the cold metallic surface of the Einhasad's Crucifix. Since it's been inside the bookshelf for a long time, it's a little rusty.<br>\nAt the moment you touch the crucifix, you hear a whisper in your ear!<br>\n<font color=\"LEVEL\">Take it to Einhasad Temple in Rune Castle Town... to Priest Innocentin there... </font>\n</body></html>",
  "31526-15.htm": "<html><body>Broken Bookshelf:<br>\nYou feel the cold metallic surface of the Einhasad's Crucifix. Since it's been inside the bookshelf for a long time, it's a little rusty.<br>\nAt the moment you touch the crucifix, you hear a whisper in your ear!<br>\n<font color=\"LEVEL\">Take it to Einhasad Temple in Rune Castle Town... to Priest Innocentin there... </font>\n</body></html>"
};
