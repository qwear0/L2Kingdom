// Mobius C4 a4c31517, Q00023_LidiasHeart. Hairpin 7148 intentionally survives
// this quest's exit for Q24; the map, diary, keys and spear do not.
const F = require('../ForestOfTheDead');
const Step = require('../QuestStep');
const START = 8328;
const QUEST_ITEMS = [7063, 7149, 7064, 7150];
const html = (state, npc, file) => F.view(state, npc, file, PAGES);

module.exports = {
    id: 23, name: "Lidia's Heart", startNpcs: [START],
    npcs: [8328, 8526, 8524, 8523, 8386, 8530], questItems: QUEST_ITEMS,
    questSpawns: [8524], personalNpcs: [8524], canTalk: F.canTalk, onAbort: F.abort,
    eventNpc: event => F.eventNpc(event, START, PAGES),
    async onEvent(state, event) {
        const npc = F.liveTalk(state, F.eventNpc(event, START, PAGES));
        if (!npc) return null;
        if (event === 'start') return this.onTalk(state, npc);
        if (!F.acceptEvent(state, event) || state.isCompleted()) return null;
        const cond = state.getInt('cond');
        switch (event) {
            case '31328-02.htm':
                if (state.isStarted() || !F.completed(state, 22) || state.session.actor.fetchLevel() < 64) return null;
                await F.step(state, 1, { gives: [[7063, 1], [7149, 1]] }); break;
            case '31328-06.htm':
                if (cond !== 1) return null;
                await F.step(state, 2); break;
            case '31526-05.htm':
                if (cond !== 3 || F.has(state, 7148)) return null;
                await F.step(state, F.has(state, 7064) ? 4 : 3, { gives: [[7148, 1]] }); break;
            case '31526-11.htm':
                if (cond !== 3 || F.has(state, 7064)) return null;
                await F.step(state, F.has(state, 7148) ? 4 : 3, { gives: [[7064, 1]] }); break;
            case '31328-11.htm':
                if (![4, 5].includes(cond) || !F.has(state, 7064, 7148)) return null;
                if (cond === 4) await F.step(state, 5);
                break;
            case '31328-19.htm':
                if (cond !== 5 || !F.has(state, 7064, 7148)) return null;
                await F.step(state, 6); break;
            case '31524-04.htm':
                if (cond !== 6 || !F.has(state, 7064)) return null;
                await F.step(state, 7, { takes: [[7064, 1]] }); break;
            case '31523-02.htm': {
                if (cond !== 6) return null;
                const scene = F.sceneFor(state, 'ghost');
                const ghost = F.spawn(scene, 8524, [51432, -54570, -3136], 60000);
                F.say(scene, ghost, 'Who awoke me?');
                break;
            }
            case '31523-05.htm': {
                if (cond !== 7) return null;
                const scene = F.sceneFor(state, 'dig');
                if (!scene.digging) {
                    scene.digging = true;
                    F.schedule(scene, 10000, async () => {
                        if (state.getInt('cond') !== 7) return;
                        await F.step(state, 8, { gives: [[7149, 1]] });
                        F.close(scene);
                    });
                }
                break;
            }
            case '31530-02.htm':
                if (cond !== 9 || !F.has(state, 7149)) return null;
                await F.step(state, 10, { takes: [[7149, 1]], gives: [[7150, 1]] }); break;
            default:
                if (!state.isStarted()) return null;
        }
        return html(state, npc, event);
    },
    async onTalk(state, npc) {
        const id = npc.fetchSelfId(), cond = state.getInt('cond');
        if (!F.canTalk(state, npc)) return null;
        if (state.isCompleted()) return id === 8386 ? html(state, npc, '31386-04.htm') : F.done();
        if (!state.isStarted()) {
            if (id !== START) return F.noQuest();
            return html(state, npc, !F.completed(state, 22) ? '31328-00.htm'
                : state.session.actor.fetchLevel() < 64 ? '31328-00a.htm' : '31328-01.htm');
        }
        let file;
        if (id === START) {
            file = ({ 1: '31328-03.htm', 2: '31328-07.htm', 4: '31328-08.htm', 5: '31328-10.htm' })[cond];
            if (cond > 5) file = '31328-21.htm';
        } else if (id === 8526) {
            if (cond === 2) {
                await F.step(state, 3);
                file = '31526-00.htm';
            } else if (cond === 3) {
                if (!F.has(state, 7064)) file = F.has(state, 7148) ? '31526-06.htm' : '31526-02.htm';
                else if (!F.has(state, 7148)) file = '31526-12.htm';
            } else if (cond > 3) file = '31526-13.htm';
        } else if (id === 8524) {
            if (cond === 6) file = '31524-01.htm';
            else if (cond > 6) file = '31524-05.htm';
        } else if (id === 8523) {
            if (cond === 6) file = F.find(state, 'ghost', 8524) ? '31523-03.htm' : '31523-01.htm';
            else if (cond === 7) file = '31523-04.htm';
            else if (cond > 7) file = '31523-06.htm';
        } else if (id === 8386) {
            if (cond === 8) {
                await F.step(state, 9);
                file = '31386-01.htm';
            } else if (cond === 9) file = '31386-02.htm';
            else if (cond === 10) {
                if (F.has(state, 7150)) {
                    const amount = Math.max(0, Math.floor(100000 * invoke('GameServer/ProgressionRates').profile().questAdena));
                    await F.step(state, 0, { takes: Step.heldItems(state, QUEST_ITEMS), gives: amount ? [[57, amount]] : [], status: 'completed' });
                    F.clear(state, 'ghost'); F.clear(state, 'dig');
                    file = '31386-03.htm';
                } else {
                    await F.step(state, 9);
                    file = '31386-02.htm';
                }
            }
        } else if (id === 8530) {
            if (cond === 9) file = '31530-01.htm';
            else if (cond === 10) file = '31530-03.htm';
        }
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
  "31328-00.htm": "<html><body>Innocentin:<br>\nThis is something you can get started on immediately!<br>\nThere's a vast conspiracy afoot in Rune Castle Town and the Forest of the Dead!<br>\nThe roots of this conspiracy lie in that forest, and you should seek the truth there.<br>\n(This quest may only be undertaken by a character of level 64 and above who has completed the <font color=\"LEVEL\">Hidden Truth</font> and <font color=\"LEVEL\">Tragedy of Hellmann Forest</font> quests.)\n</body></html>",
  "31328-00a.htm": "<html><body>Innocentin:<br>\nYou look tired, my friend! Why don't you take a break, improve your ability and then come back! This next mission is much more challenging than the last one...<br>\n(This quest may only be undertaken by a character of level 64 and above who has completed <font color=\"LEVEL\">Tragedy of Hellmann Forest</font> quest.)\n</body></html>",
  "31328-01.htm": "<html><body>Innocentin:<br>\nYou've been a great help to me in the past, and I'd like to thank you again for bringing me that report! There's one more thing... Could you help me out again?<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-02.htm\">\"OK, whatever.\"</a>\n</body></html>",
  "31328-02.htm": "<html><body>Innocentin:<br>\nHere's the Map and key he left behind. Take them and find out what he was searching for.<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-03.htm\">\"Tell me more about the Map and key.\"</a>\n</body></html>",
  "31328-03.htm": "<html><body>Innocentin:<br>\nHe probably drew this Map while exploring the Forest of the Dead. As for the key... I'm not sure. The only clue I've found is the Silver Spear engraved upon it.<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-05.htm\">\"Tell me more about the Silver Spear.\"</a>\n</body></html>",
  "31328-05.htm": "<html><body>Innocentin:<br>\nAccording to a custom from the Elmoreden period, a Silver Spear was the symbol of the family responsible for guarding the royal family.<br>\nAn ancient proverb says, <font color=\"LEVEL\">\"A jeweled scepter for the mighty King of Elmore and two Silver Spears for his protectors\"</font>.<br>\nI'll wager that somewhere is a lock that matches this key...<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-06.htm\">\"Who holds the spear now?\"</a>\n</body></html>",
  "31328-06.htm": "<html><body>Innocentin:<br>\nToday's silver spears are dedicated to the people who worked hard to suppress the rebellion. One is for the protectors of the royal family, who captured and punished the rebels, and one is for those who fought against the undead and captured the demon's followers... and it will therefore be a dedication that upholds the false accusations against our former priests.<br>\nThe one responsible for all this is staying at the temple in Rune Castle Town.<br>\nPlease don't ask any more questions. Just take the records that he left behind, and find out where that key fits.\n</body></html>",
  "31328-07.htm": "<html><body>Innocentin:<br>\nYou must find the lock that matches that key! It would probably be in the possession of a family worthy of the spear!\n</body></html>",
  "31328-08.htm": "<html><body>Innocentin:<br>\nSo, did you find anything?<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-09.htm\">\"Here is the diary and the hairpin.\"</a>\n</body></html>",
  "31328-09.htm": "<html><body>Innocentin:<br>\nPlease! Put those things away...Please!<br>\nI'm sorry, but the power of darkness contained in them is overpowering! I can't even look at them...<br>\nHow about you? Are you okay?<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-10.htm\">\"I'm fine.\"</a>\n</body></html>",
  "31328-10.htm": "<html><body>Innocentin:<br>\nReally? Have you read it?<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-12.htm\">\"Yes, I read it.\"</a><br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-11.htm\">\"No, I haven't read it.\"</a>\n</body></html>",
  "31328-11.htm": "<html><body>Innocentin:<br>\nRead it and come back to me... I have many questions!\n</body></html>",
  "31328-12.htm": "<html><body>Innocentin:<br>\nThen answer me... What is it?<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-15.htm\">\"Lidia's Diary.\"</a><br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-13.htm\">\"Alfred's Diary.\"</a>\n</body></html>",
  "31328-13.htm": "<html><body>Innocentin:<br>\nHave you read the document?<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-14.htm\">\"Yes, I read it.\"</a><br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-11.htm\">No, I didn't read it.\"</a>\n</body></html>",
  "31328-14.htm": "<html><body>Innocentin:<br>\nThen answer me... What is it?<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-15.htm\">\"Lidia's Diary.\"</a><br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-13.htm\">\"Alfred's Diary.\"</a>\n</body></html>",
  "31328-15.htm": "<html><body>Innocentin:<br>\nLidia's Diary?<br>\nLidia was dear Alfred's precious daughter... They led an idyllic life, until that tragic day...<br>\nDoes her diary cover the period after she became lord of the forest?<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-16.htm\">\"Yes, it does.\"</a><br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-20.htm\">\"No, it doesn't.\"</a>\n</body></html>",
  "31328-16.htm": "<html><body>Innocentin:<br>\nWhat did you learn from the diary?<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-20.htm\">\"Lidia was bitten by a vampire.\"</a><br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-17.htm\">\"Lidia signed some sort of Contract.\"</a>\n</body></html>",
  "31328-17.htm": "<html><body>Innocentin:<br>\nA Contract?!<br>\nI'll bet that rascal Nidrah was behind this! Was he involved?<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-20.htm\">\"Yes, he forced her to sign the Contract.\"</a><br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-18.htm\">\"Lidia approached Nidrah.\"</a><br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-20.htm\">\"Nidrah wasn't involved.\"</a><br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-20.htm\">\"As I said before, Lidia was bitten by a vampire! Don't you get it?\"</a>\n</body></html>",
  "31328-18.htm": "<html><body>Innocentin:<br>\nOh really? Then let me ask you one more question. Have you ever heard the expression <font color=\"LEVEL\">\"Owner of a Moon Face Flower\"</font>?<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-19.htm\">\"It's the Lord of the Forest of the Dead.\"</a><br>\n<a action=\"bypass Script Q00023_LidiasHeart 31328-20.htm\">\"It's Lidia von Hellmann.\"</a>\n</body></html>",
  "31328-19.htm": "<html><body>Innocentin:<br>\nAh ha! Then that hairpin must belong to Lidia!<br>\nNow I remember it! She used to wear it in her hair! Sigh... She was so beautiful then...<br>\nThank you for your help! I suppose our business is done now, but your journey continues...<br>\nI'll always be here for you if you have any questions.\n</body></html>",
  "31328-20.htm": "<html><body>\nThe moment the words leave your lips, you feel an electric current shoot through your head, buzzing like 5000 wyverns in flight! Deep within your heart wells an emotion, small but growing more intense by the moment...<br>\nIt's remorse! Lidia must have been angered by your answer!\n</body></html>",
  "31328-21.htm": "<html><body>Innocentin:<br>\nI don't think your journey's over yet. Someone close to her wants to see you. He'll show you the path that leads to your next adventure.\n</body></html>",
  "31386-01.htm": "<html><body>Violet:<br>\nOh, the key? That's right! That's the key that Duke Adolph von Hellmann asked me to keep for him! That was a very long time ago! He told me that it guards the highest honor his family received from the King!<br>\nBut I can't go there. I can't leave this village.<br>\nGo towards the northern part of the village. You'll find a box near the center of the Forest of the Dead. This key opens the padlock on the box.<br>\nBring me the object you find inside the box.\n</body></html>",
  "31386-02.htm": "<html><body>Violet:<br>\nI can't go there. I can't leave this village!<br>\nGo towards the northern part of the village, you'll find a box near the center of the Forest of the Dead. This key opens the padlock on the box.<br>\nBring me the object you find inside the box.\n</body></html>",
  "31386-03.htm": "<html><body>Violet:<br>\nThis is the very Silver Spear that King Astaire Van Halter bestowed upon Duke Adolph! It's the treasured heirloom of the Hellmann family! The lord will be overjoyed! The long lost honor of his family name is restored, and it's all because of you!<br>\nThank you. Please accept this small token of our gratitude! I only wish that we could have you over to the castle and give you a more formal recognition...<br>\nI probably have to express our gratitude to the lord through another person, not me. Please talk with the village people.\n</body></html>",
  "31386-04.htm": "<html><body>Violet:<br>\nFind someone among the villagers to express your gratitude to the lord.<br>\nHave you visited Dorian yet?\n</body></html>",
  "31523-01.htm": "<html><body>Tombstone:<br>\n<font color=\"LEVEL\">One jeweled scepter for the King and two Silver Spears for the von Hellmann family who protects him.</font><br>\n<a action=\"bypass Script Q00023_LidiasHeart 31523-02.htm\">Wait a while.</a>\n</body></html>",
  "31523-02.htm": "<html><body>Tombstone:<br>\nAfter a while, a white ghost appears.\n</body></html>",
  "31523-03.htm": "<html><body>Tombstone:<br>\nThe ghost was beside you all along!\n</body></html>",
  "31523-04.htm": "<html><body>Tombstone:<br>\nThere is a tablet engraved with familiar characters.<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31523-05.htm\">Dig</a><br>\n<a action=\"bypass Script Q00023_LidiasHeart 31523-02.htm\">Recall the ghost</a>\n</body></html>",
  "31523-05.htm": "<html><body>Tombstone:<br>\nThere is a tablet engraved with familiar characters.<br>\nIt appears that something else has been crudely etched into the tablet.\n</body></html>",
  "31523-06.htm": "<html><body>Tombstone:<br>\nYou find a key engraved with a silver spear.\n</body></html>",
  "31524-01.htm": "<html><body>Ghost of von Hellmann:<br>\nWho has summoned me here? Why can't I sleep?<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31524-02.htm\">\"Let me tell you about Lidia von Hellmann.\"</a>\n</body></html>",
  "31524-02.htm": "<html><body>Ghost of von Hellmann:<br>\nOh, the horror! The von Hellmann's are dead and Lidia is a demon? Her curse upon this land is depriving me of my rest!<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31524-03.htm\">\"It's the truth.\"</a>\n</body></html>",
  "31524-03.htm": "<html><body>Ghost of von Hellmann:<br>\nHow did she become the Lord of the Dead?<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31524-04.htm\">\"Here's her diary.\"</a>\n</body></html>",
  "31524-04.htm": "<html><body>Ghost of von Hellmann:<br>\nThis concerns Lidia's Diary? Is that right? Oh, I see! Dear traveler! For whatever little time I have left, I'll read this diary and go over the past again and again in my mind!<br>\nTraveler, I shall reward you well for this diary! Dig underneath this tombstone and you will find my key!<br>\nTake that key to the Chamberlain of the Hellmann family! You'll find him <font color=\"LEVEL\">in the village hidden in the middle of this forest</font>!\n</body></html>",
  "31524-05.htm": "<html><body>Ghost of von Hellmann:<br>\n<font color=\"LEVEL\">Dig underneath this tombstone and you will find my key.</font><br>\nTake that key to the Chamberlain of the Hellmann family! You'll find him <font color=\"LEVEL\">in the village hidden in the middle of this forest</font>!\n</body></html>",
  "31524-06.htm": "<html><body>Ghost of von Hellmann:<br>\nTake the key to von Hellmann's page, He's in <font color=\"LEVEL\">the hidden village in the center of the forest</font>.\n</body></html>",
  "31526-00.htm": "<html><body>Broken Bookshelf:<br>\nThe chest is secured with a padlock which bears the mark of the Hellmann family.<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31526-01.htm\">Use a Silver Spear key</a>\n</body></html>",
  "31526-01.htm": "<html><body>Broken Bookshelf:<br>\nThe chest opens with a creak.<br>\nInside, you find an old hairpin and a book tied with a leather string.<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31526-03.htm\">Examine the hairpin.</a><br>\n<a action=\"bypass Script Q00023_LidiasHeart 31526-07.htm\">Examine the book.</a>\n</body></html>",
  "31526-02.htm": "<html><body>Broken Bookshelf:<br>\nThe chest opens with a creak.<br>\nInside, you find an old hairpin and a book tied with a leather string.<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31526-03.htm\"> Examine the hairpin.</a><br>\n<a action=\"bypass Script Q00023_LidiasHeart 31526-07.htm\"> Examine the book.</a>\n</body></html>",
  "31526-03.htm": "<html><body>Broken Bookshelf:<br>\nThe hairpin is a type once used by aristocratic ladies. It's engraved with the image of a Moon Face Flower, and was probably used by a unattached young lady.<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31526-04.htm\">\"I wonder what that design means?\"</a>\n</body></html>",
  "31526-04.htm": "<html><body>Broken Bookshelf:<br>\nAccording to legend, the Moon Face Flower only blooms on moonlit nights.<br>\nIt's very shy, and shows its face only to its future husband. This legend made it quite popular among young, single, aristocratic ladies.<br>\nI wonder who might have owned this one?<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31526-05.htm\">Take the hairpin.</a>\n</body></html>",
  "31526-05.htm": "<html><body>Broken Bookshelf:<br>\nYou took the hairpin.<br>\nCheck the bookshelf. You may find something else.\n</body></html>",
  "31526-06.htm": "<html><body>Broken Bookshelf:<br>\nIn the locker where you found the hairpin, you also find a book tied with a leather string.<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31526-07.htm\">Examine the book.</a>\n</body></html>",
  "31526-07.htm": "<html><body>Broken Bookshelf:<br>\nA book tied with a leather string. It's tied very tight, and doesn't seem like it could easily be cut.<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31526-08.htm\">Try to cut the string.</a>\n</body></html>",
  "31526-08.htm": "<html><body>Broken Bookshelf:<br>\nWhen you cut the string, it falls to the floor and you hear a faint sigh.<br>\nShall you read the book?<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31526-09.htm\">Read the book.</a>\n</body></html>",
  "31526-09.htm": "<html><body>Broken Bookshelf:<br>\n\"Month of Shilen, 15th day.<br>\nLately, Father spends all his days with Nidrah! He doesn't take care of the manor like he should. What makes him so angry?<br>\nWhat's this?!<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31526-10.htm\">\"It's Lidia's Diary!\"</a>\n</body></html>",
  "31526-10.htm": "<html><body>Broken Bookshelf:<br>\nIt's a journal that belonged to Lidia von Hellmann. It probably has a lot of useful information in it!<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31526-11.htm\">Pick up the journal.</a>\n</body></html>",
  "31526-11.htm": "<html><body>Broken Bookshelf:<br>\nYou've found Lidia's Diary!<br>\nCheck the bookshelf again. You may find something else.\n</body></html>",
  "31526-12.htm": "<html><body>Broken Bookshelf:<br>\nIn the chest where you found the book, you also find a hairpin shaped like a Moon Face Flower.<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31526-03.htm\"> Examine the hairpin.</a>\n</body></html>",
  "31526-13.htm": "<html><body>Broken Bookshelf:<br>\nThe locker is empty.\n</body></html>",
  "31530-01.htm": "<html><body>Box:<br>\nIt's an antique box with the von Hellmann family seal on the lock.<br>\n<a action=\"bypass Script Q00023_LidiasHeart 31530-02.htm\">Use the Silver Spear key.</a>\n</body></html>",
  "31530-02.htm": "<html><body>Box:<br>\nThe box opens.\n</body></html>",
  "31530-03.htm": "<html><body>Box:<br>\nIt's empty.\n</body></html>"
};
