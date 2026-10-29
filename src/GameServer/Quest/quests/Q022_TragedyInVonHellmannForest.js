// Mobius C4 a4c31517, Q00022_TragedyInVonHellmannForest. The well is a timed
// personal fight, not kill credit; destroying/expiring it leaves a retry route.
const F = require('../ForestOfTheDead');
const Step = require('../QuestStep');
const START = 8334;
const SOUL = 5217;
const QUEST_ITEMS = [7141, 7142, 7144, 7145, 7146, 7147];
const html = (state, npc, file) => F.view(state, npc, file, PAGES);

function priest(state) {
    const scene = F.sceneFor(state, 'priest');
    if (!F.existing(scene, 8528)) {
        const npc = F.spawn(scene, 8528, [38354, -49777, -1128], 120000);
        F.say(scene, npc, `Did you call me, ${scene.actor.fetchName()}?`);
    }
}

module.exports = {
    id: 22, name: 'Tragedy in von Hellmann Forest', startNpcs: [START],
    npcs: [8328, 8334, 8527, 8528, 8529], questItems: QUEST_ITEMS,
    questSpawns: [8528, SOUL], personalNpcs: [8528], killNpcs: [1553, 1555, 1561], attackNpcs: [SOUL],
    canTalk: F.canTalk, onAbort: F.abort,
    eventNpc: event => F.eventNpc(event, START, PAGES),
    async onEvent(state, event) {
        const npc = F.liveTalk(state, F.eventNpc(event, START, PAGES));
        if (!npc) return null;
        if (event === 'start') return this.onTalk(state, npc);
        if (!F.acceptEvent(state, event) || state.isCompleted()) return null;
        const cond = state.getInt('cond');
        let file = event;
        switch (event) {
            case '31334-02.htm':
                if (state.isStarted()) return null;
                if (state.session.actor.fetchLevel() < 63 || !F.completed(state, 21)) file = '31334-03.htm';
                break;
            case '31334-04.htm':
                if (state.isStarted() || state.session.actor.fetchLevel() < 63 || !F.completed(state, 21)) return null;
                await F.step(state, 1); break;
            case '31334-07.htm':
                if (cond !== 1 && cond !== 3) return null;
                await F.step(state, F.has(state, 7141) ? 3 : 2);
                if (F.has(state, 7141)) file = '31334-06.htm';
                break;
            case '31334-08.htm':
                if (cond !== 3 || !F.has(state, 7141)) return null;
                await F.step(state, 4); break;
            case '31334-13.htm':
                if (![5, 6, 7].includes(cond) || !F.has(state, 7141)) return null;
                if (cond !== 7) {
                    if (!F.has(state, 7142)) return null;
                    await F.step(state, 7, { takes: Step.heldItems(state, [7142]) });
                }
                priest(state); break;
            case '31528-04.htm':
                if (cond !== 7) return null;
                break;
            case '31528-08.htm': {
                if (cond !== 7 || !F.find(state, 'priest', 8528)) return null;
                await F.step(state, 8);
                const scene = F.sceneFor(state, 'priest');
                F.schedule(scene, 3000, () => F.close(scene));
                break;
            }
            case '31328-03.htm':
                if (cond !== 8 || !F.has(state, 7141)) return null;
                await F.step(state, 8, { takes: Step.heldItems(state, [7141]) }); break;
            case '31328-09.htm':
                if (cond !== 8 || F.has(state, 7141)) return null;
                await F.step(state, 9, { gives: [[7143, 1]], variables: { memoState: '0' } }); break;
            case '31328-11.htm':
                if (cond !== 14 || !F.has(state, 7147)) return null;
                await F.step(state, 15, { takes: Step.heldItems(state, [7147]) }); break;
            case '31328-19.htm':
                if (cond !== 15) return null;
                await F.step(state, 16); break;
            case '31527-02.htm': {
                if (cond !== 10 || !F.has(state, 7144)) return null;
                if (F.find(state, 'well', SOUL)) { file = '31527-03.htm'; break; }
                const scene = F.sceneFor(state, 'well');
                const soul = F.spawn(scene, SOUL, [34706, -54590, -2054], 120000);
                scene.readyAt = Date.now() + 90000;
                soul.enterCombatState(state.session, state.session.actor);
                break;
            }
            case '31529-03.htm':
                if (cond !== 9 || !F.has(state, 7143) || state.getInt('memoState') !== 0) return null;
                await F.step(state, 9, { variables: { memoState: '8' } }); break;
            case '31529-08.htm':
                if (cond !== 9 || state.getInt('memoState') !== 8) return null;
                await F.step(state, 9, { variables: { memoState: '9' } }); break;
            case '31529-11.htm':
                if (cond !== 9 || state.getInt('memoState') !== 9 || !F.has(state, 7143)) return null;
                await F.step(state, 10, { gives: [[7144, 1]], variables: { memoState: '10' } }); break;
            default:
                if (!state.isStarted()) return null;
        }
        return html(state, npc, file);
    },
    async onTalk(state, npc) {
        const id = npc.fetchSelfId(), cond = state.getInt('cond');
        if (!F.canTalk(state, npc)) return null;
        if (state.isCompleted()) return F.done();
        if (!state.isStarted()) return id === START ? html(state, npc, '31334-01.htm') : F.noQuest();
        let file;
        if (id === START) {
            if (cond === 1 || cond === 3) file = '31334-05.htm';
            else if ((cond === 4 || cond === 5) && F.has(state, 7141))
                file = !F.has(state, 7142) ? '31334-09.htm' : '31334-10.htm';
            else if ([6, 7].includes(cond) && F.has(state, 7141)) file = F.find(state, 'priest', 8528) ? '31334-15.htm' : '31334-17.htm';
            else if (cond === 8 && F.has(state, 7141)) file = '31334-18.htm';
        } else if (id === 8528 && cond === 7) file = '31528-01.htm';
        else if (id === 8328) {
            if (cond === 2 && !F.has(state, 7141)) {
                await F.step(state, 3, { gives: [[7141, 1]] });
                file = '31328-01.htm';
            } else if (cond === 3 && F.has(state, 7141)) file = '31328-01b.htm';
            else if (cond === 8) file = F.has(state, 7141) ? '31328-02.htm' : '31328-04.htm';
            else if (cond === 9) file = '31328-09a.htm';
            else if (cond === 14 && F.has(state, 7147)) file = '31328-10.htm';
            else if (cond === 15) file = '31328-12.htm';
            else if (cond === 16) {
                await F.step(state, 0, { takes: Step.heldItems(state, QUEST_ITEMS), status: 'completed', exp: 345966, sp: 31578 });
                F.clear(state, 'well'); F.clear(state, 'priest');
                file = state.session.actor.fetchLevel() >= 63 ? '31328-20.htm' : '31328-21.htm';
            }
        } else if (id === 8527) {
            if (cond === 10 && F.has(state, 7144)) file = F.find(state, 'well', SOUL) ? '31527-03.htm' : '31527-01.htm';
            else if (cond === 12 && F.has(state, 7145) && !F.has(state, 7146)) {
                await F.step(state, 13, { gives: [[7146, 1]] });
                file = '31527-04.htm';
            } else if (cond >= 13) file = '31527-05.htm';
        } else if (id === 8529) {
            if (cond === 9 && F.has(state, 7143))
                file = ({ 0: '31529-01.htm', 8: '31529-03a.htm', 9: '31529-10.htm' })[state.getInt('memoState')];
            else if (cond === 10 && F.has(state, 7144)) file = state.getInt('memoState') === 10 ? '31529-12.htm' : '31529-14.htm';
            else if (cond === 11 && F.has(state, 7145) && !F.has(state, 7146)) {
                await F.step(state, 12);
                file = '31529-15.htm';
            } else if (cond === 13 && F.has(state, 7145, 7146)) {
                await F.step(state, 14, { takes: Step.heldItems(state, [7145, 7146]), gives: [[7147, 1]] });
                file = '31529-16.htm';
            } else if (cond === 14 && F.has(state, 7147)) file = '31529-17.htm';
        }
        return file ? html(state, npc, file) : F.noQuest();
    },
    async onAttack(state, npc, source) {
        if (!state.isStarted() || state.getInt('cond') !== 10 || !F.has(state, 7144)
            || (source !== state.session.actor && source?.ownerSession !== state.session)) return;
        const soul = F.find(state, 'well', SOUL);
        if (!soul || soul !== npc) return;
        if (state.getInt('memoState') === 10) {
            await F.step(state, 10, { variables: { memoState: '11' } });
        } else {
            const scene = F.sceneFor(state, 'well');
            if (!(Date.now() >= scene.readyAt)) return;
            await F.step(state, 11, { takes: Step.heldItems(state, [7144]), gives: [[7145, 1]] });
        }
    },
    async onKill(state, npc) {
        if (!state.isStarted() || state.getInt('cond') !== 4 || !F.has(state, 7141) || F.has(state, 7142)) return;
        const actor = state.session.actor;
        const range = 1500 + actor.fetchRadius() + npc.fetchRadius();
        if (Math.hypot(actor.fetchLocX() - npc.fetchLocX(), actor.fetchLocY() - npc.fetchLocY(), actor.fetchLocZ() - npc.fetchLocZ()) > range
            || Math.random() >= 0.1) return;
        await F.step(state, 5, { gives: [[7142, 1]] });
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
  "31328-01.htm": "<html><body>Innocentin:<br>\nAh, hello again!<br>\nSometime ago, a priest here doing volunteer work <font color=\"LEVEL\">found a crucifix and brought it to me</font>.<br>\nIt was the very same crucifix I gave you! Did you drop it?<br>\nTake this crucifix to Magister Tifaren immediately!\n</body></html>",
  "31328-01b.htm": "<html><body>Innocentin:<br>\nTake this crucifix to Magister Tifaren and ask her to perform necromancy. She tends to be quite wary of strangers, so you may need to prove your sincerity to her. Keep trying, she'll come around.\n</body></html>",
  "31328-02.htm": "<html><body>Innocentin:<br>\nCome on in! Did he tell you anything?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31328-03.htm\">\"Well, he said...\"</a>\n</body></html>",
  "31328-03.htm": "<html><body>Innocentin<br>\nI see.. Lidia von Hellmann was lord of the Forest of the Dead! She was Alfred's daughter, a survivor of the tragedy of Hellmann Forest... Thank you.<br>\nThanks to you, we know that his death wasn't in vain...<br>\nI will treasure this crucifix always!<br>\nHmm..? Was there something else?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31328-05.htm\">\"Who's behind all of this?\"</a>\n</body></html>",
  "31328-04.htm": "<html><body>Innocentin:<br>\nDo you want to ask me something?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31328-05.htm\">\"Who is behind the tragedy?\"</a>\n</body></html>",
  "31328-05.htm": "<html><body>Innocentin:<br>\nWho's behind the tragedy? Well, there are several theories, I'm sure you've heard them all!<br>\nWhy don't I tell you one you probably haven't heard...<br>\nAlfred von Hellmann and I were very close friends and he shared with me the terrible dissatisfaction he had in his heart...<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31328-06.htm\">\"I heard that he didn't intentionally become a traitor.\"</a>\n</body></html>",
  "31328-06.htm": "<html><body>Innocentin:<br>\nExactly! He only meant to encourage the lame duck king! He never even considered treason until his meeting with a mystic in the forest! Around that time I hired a treasure hunter to find out exactly what was going on with Alfred... That didn't go well at all!<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31328-07.htm\">\"What happened?\"</a>\n</body></html>",
  "31328-07.htm": "<html><body>Innocentin:<br>\nHe was accused of worshipping the devil! His secretive nature, along with the sensitivity of the mission, led to his downfall.<br>\nI was occupied elsewhere and couldn't protect him...<br>\nHe was charged, convicted and executed on the square of Rune Castle! The evidence he had gathered for me was thrown into a <font color=\"LEVEL\">deserted well</font>.<br><br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31328-08.htm\">\"Tell me more!\"</a>\n</body></html>",
  "31328-08.htm": "<html><body>Innocentin:<br>\nIt's said that his ghost visits that well every night.<br>\nI'd always believed that all ghosts were evil, but after my experiences with necromancy, the realm of the gods is denied to me. I must find out what actually happened!<br>\nWould you meet with him and ask him what he found out?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31328-09.htm\">\"I'll do it.\"</a>\n</body></html>",
  "31328-09.htm": "<html><body>Innocentin:<br>\nYou'll find the well in the northwest part of the village. Show the ghost the letter and he'll grant your request.\n</body></html>",
  "31328-09a.htm": "<html><body>Innocentin:<br>\nThe ghost of the treasure hunter is said to appear around the well in the northwest part of the village.<br>\nTake the letter to him and come back to me with his reply.\n</body></html>",
  "31328-10.htm": "<html><body>Innocentin:<br>\nOh, you're back? Did you bring any news?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31328-11.htm\">\"Check out this box.\"</a>\n</body></html>",
  "31328-11.htm": "<html><body>Innocentin:<br>\nIndeed! Is this the box he told you about?<br>\nHe told me once, in case something happened to him, he would store all his most important documents in a box! Hmm...<br>\nI can't help but think... Perhaps it's fortunate that I left the temple and came here! Ah... but that's not important...<br>\nNow give me the box!<br>\nI must open it carefully and see what it holds. Why don't you come back a little later?\n</body></html>",
  "31328-12.htm": "<html><body>Innocentin:<br>\nIt's the report of the Mystic Neidrahu, the instigator of the insurrection! Do you care to read it?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31328-13.htm\">\"Yes!\"</a>\n</body></html>",
  "31328-13.htm": "<html><body><br>\n<font color=\"LEVEL\">Regarding Neidrahu</font><br>\n\"... No one knows for sure how deeply Alfred von Hellmann was influenced by his magic, for his eloquence was certainly equal to his magic ability. Alfred wasn't the only one swayed by his words. Neidrahu called himself a messenger, and personally gathered many supporters for the insurrection.\"<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31328-14.htm\">Turn the page</a>\n</body></html>",
  "31328-14.htm": "<html><body>\n\"Nidrah's preaching persuaded his followers of the awesome power of the dark arts. He often spoke of a powerful magus known as a devil, who practiced magic in Gludio. He convinced them that his own power was equal to the devil's!<br>\nInformation regarding Beleth, Black Magus and the pastoral history of the wasteland of Gludio was all available at the main library. Although many were suspicious of his claims, eventually they believed him.\"<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31328-15.htm\">Turn the page</a>\n</body></html>",
  "31328-15.htm": "<html><body>\n\"This was to be his greatest accomplishment! The army of undead that he conjured played a pivotal role in the tragedy that occurred in the Hellmann Forest, but the outcome wasn't as he expected...<br>\nBefore his army was ready, the King learned of the Hellmann family's treason. In a fit of rage, and without any consultations, the King mobilized an occupation force and marched on the Hellmann Forest.\"<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31328-16.htm\">Next Page</a>\n</body></html>",
  "31328-16.htm": "<html><body>\n\"The supporters of the von Hellmann family fought bravely, but their lack of organization was their undoing. As the King's army approached, the family finally realized that they had failed. By then, most of their sympathizers had been beheaded or taken prisoner by the King's army. The von Hellmanns were very powerful, but their treasonous behavior caused them to fall into disgrace and to be renounced by the royal family. The fall was especially painful to Alfred, who, as patriarch, had to watch as his vassals and then his family were tortured and beheaded, before he ascended the scaffold himself.<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31328-17.htm\">Turn the page</a>\n</body></html>",
  "31328-17.htm": "<html><body>\n\"It was then that Nidrah's magic sprang into action! At dusk, as the King's army took inventory of the treasures of the Hellmann family, a huge army of undead fighters rushed the castle!<br>\nThey were the souls of the executed vassals, led by Alfred's children Lidia and Eilhalder von Hellmann! All were under the control of Nidrah.\"<br><br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31328-18.htm\">Turn the page</a>\n</body></html>",
  "31328-18.htm": "<html><body>\n\"What happened next was a repeat of the events of the war with Beleth. Those killed by an undead were resurrected and enlisted in Lidia's force. The higher-level vassals of the Hellmann family became vampires, or high level undead. They possessed indescribable power!<br>\nIt seemed the battle was over, until...\"<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31328-19.htm\">Next Page</a>\n</body></html>",
  "31328-19.htm": "<html><body>\n\"I had my doubts about Lidia. If she was resurrected, how did she become Lord of the Forest of the Dead? Why not Alfred?<br>\nI think she conspired with Nidrah! I'll investigate this further.\"<br>\nHmm...\n</body></html>",
  "31328-20.htm": "<html><body>Innocentin:<br>\nDid you finish it? It's the true account of the terrible tragedy that occurred in Hellmann Forest... But it doesn't answer all of my questions... Would you do something for me?<br>\nI'm afraid it won't be easy, and you look very tired! Why don't you take a break and come back when you're refreshed.\n</body></html>",
  "31328-21.htm": "<html><body>Innocentin:<br>\nDid you finish it? It's the true account of the terrible tragedy that occurred in Hellmann Forest... But it doesn't answer all of my questions... Would you do something for me?<br>\nI'm afraid it won't be easy, and you look very tired! Why don't you take a break and come back later when you're refreshed and have had a little more training.<br>\n<font color=\"LEVEL\">(The Heart of Lidia quest may only be undertaken by a character of level 64 or above.)</font>\n</body></html>",
  "31328-22.htm": "<html><body>Innocentin:<br>\nDid you finish it? It's the true account of the terrible tragedy that occurred in Hellmann Forest... But it doesn't answer all of my questions... Would you do something for me?<br>\nI'm afraid it won't be easy, and you look very tired! Why don't you take a break and come back when you're refreshed.\n</body></html>",
  "31328-23.htm": "<html><body>Innocentin:<br>\nDid you finish it? It's the true account of the terrible tragedy that occurred in Hellmann Forest... But it doesn't answer all of my questions... Would you do something for me?<br>\nI'm afraid it won't be easy, and you look very tired! Why don't you take a break and come back later when you're refreshed and have had a little more training.<br>\n(The <font color=\"LEVEL\">Heart of Lidia</font> quest may only be undertaken by a character of level 64 and above.)\n</body></html>",
  "31334-01.htm": "<html><body>Grand Magister Tifaren:<br>\nWhat's your business here?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31334-02.htm\">\"I need the necromantic rite of communion performed.\"</a>\n</body></html>",
  "31334-02.htm": "<html><body>Grand Magister Tifaren:<br>\nThe necromantic rite of communion is a secret rite performed only by the children of Shilen. It is our secret heritage. Not everyone may receive it. Who sent you?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31334-04.htm\">\"High Priest Innocentin sent me.\"</a>\n</body></html>",
  "31334-03.htm": "<html><body>Grand Magister Tifaren:<br>\nYou want me to hold a seance? The necromantic rite of communion is the secret magic of Dark Elves. It's not for novices!<br>\n(This quest may only be undertaken by a character of level 63 and above who has completed <font color=\"LEVEL\">Hidden Truth</font> quest.)\n</body></html>",
  "31334-04.htm": "<html><body>Grand Magister Tifaren:<br>\nHigh priest of Einhasad?<br>\nHa! You amuse me, now go!\n</body></html>",
  "31334-05.htm": "<html><body>Grand Magister Tifaren:<br>\nUnbelievable! Whose soul could the high priest want me to summon with dark magic? Doesn't he serve the god of light?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31334-07.htm\">Show her Einhasad's Crucifix.</a>\n</body></html>",
  "31334-06.htm": "<html><body>Grand Magister Tifaren:<br>\nEinhasad's Crucifix! You would have me summon the soul of a priest?<br>\nI believe you that High Priest Innocentin sent you. Since he requests it, I'll do my best.<br>\nI need you to bring me something.<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31334-08.htm\">\"What?\"</a>\n</body></html>",
  "31334-07.htm": "<html><body>Grand Magister Tifaren:<br>\nYou say High Priest Innocentin asks me to hold a seance? You're kidding, right? Show me proof or be on your way!\n</body></html>",
  "31334-08.htm": "<html><body>Grand Magister Tifaren:<br>\nHunt zombies or ghosts in the Forest of the Dead for a clean skull, preferably an Elven one. It will increase my chances of summoning a priest of Einhasad to use a child of Shilen.\n</body></html>",
  "31334-09.htm": "<html><body>Grand Magister Tifaren:<br>\nI believe High Priest Innocentin sent you. Hunt zombies or ghosts in the Forest of the Dead to find me a clean skull, preferably an Elven one. It will increase my chances of summoning a priest of Einhasad to use a child of Shilen.\n</body></html>",
  "31334-10.htm": "<html><body>Grand Magister Tifaren:<br>\nAn Elven skull! Now I can proceed.<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31334-12.htm\">Wait for incantation</a>\n</body></html>",
  "31334-11.htm": "<html><body>Grand Magister Tifaren:<br>\nIs that an Elven skull? Good. However, I'm busy helping someone else, you'll have to come back later.\n</body></html>",
  "31334-12.htm": "<html><body>Grand Magister Tifaren:<br>\nIn the name of the Mother, come to me! I, who have mastered the laws of nature, demand that you obey my order! Your spirit shall reside within this vessel. Come!<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31334-13.htm\">Wait</a>\n</body></html>",
  "31334-13.htm": "<html><body>Grand Magister Tifaren:<br>\nSuccess! My work is done.<br>\nThe soul is not stable in this vessel. It won't last long! <font color=\"LEVEL\">Find out the rest directly from him</font> before he leaves this realm!\n</body></html>",
  "31334-14.htm": "<html><body>Grand Magister Tifaren:<br>\nMy concentration has been broken!<br>\nCome back later when it's quieter. I can't focus with so many people around.\n</body></html>",
  "31334-15.htm": "<html><body>Grand Magister Tifaren:<br>\nI don't want to get involved with a priest of Einhasad. He's right here, \nfinish your business quickly!</body></html>",
  "31334-16.htm": "<html><body>Grand Magister Tifaren:<br>\nThis ghost isn't the one you requested. Someone else must be conducting the seance as well!<br>\nCome back when it's quieter and I'll try again.\n</body></html>",
  "31334-17.htm": "<html><body>Grand Magister Tifaren:<br>\nTwo minutes wasn't enough?<br>\nI'll try bringing him out once more. This time, finish your talk!<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31334-13.htm\">Try again</a>\n</body></html>",
  "31334-18.htm": "<html><body>Grand Magister Tifaren:<br>\nFinished? Don't tell me.<br>\nProbably something related to Innocentin. Take it to him, I don't want to get involved!\n</body></html>",
  "31527-01.htm": "<html><body>Well:<br>\nOminous energy emanates from the well.<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31527-02.htm\">Explore the well</a>\n</body></html>",
  "31527-02.htm": "<html><body>Well:<br>\nA spirit attacks you from the well.\n</body></html>",
  "31527-03.htm": "<html><body>Well:<br>\nBe prepared to fight the spirit from the well!\n</body></html>",
  "31527-04.htm": "<html><body>Well:<br>\nThe box inside the well is within your reach.\n</body></html>",
  "31527-05.htm": "<html><body>Well:<br>\nI'll have nothing more to do with this ominous well.\n</body></html>",
  "31528-01.htm": "<html><body>Ghost of Priest:<br>\nIt's all so confusing...<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31528-02.htm\">\"Can you remember anything?\"</a>\n</body></html>",
  "31528-02.htm": "<html><body>Ghost of Priest:<br>\nI'm not sure... It's all so foggy. Why am I here?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31528-04.htm\">\"I used necromancy.\"</a>\n</body></html>",
  "31528-03.htm": "<html><body>Ghost of Priest:<br>\n....................<br>\n(Points to Tifaren.)\n</body></html>",
  "31528-04.htm": "<html><body>Ghost of Priest:<br>\nIt's all so foggy. Can you be more specific?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31528-05.htm\">\"What about the Lord of Forest of the Dead?\"</a>\n</body></html>",
  "31528-05.htm": "<html><body>Ghost of Priest:<br>\nYou must mean Lidia von Hellmann, she was the only survivor of the tragedy here.<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31528-06.htm\">\"What tragedy?\"</a>\n</body>",
  "31528-06.htm": "<html><body>Ghost of Priest:<br>\nThe tragedy of the Hellmann forest was the massacre of the royal family. The King's army slaughtered them and all of their supporters. That's how this forest got it's name.<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31528-07.htm\">\"Why were they killed?\"</a>\n</body></html>",
  "31528-07.htm": "<html><body>Ghost of Priest:<br>\nThe Hellmann family had revolted against the kingdom, hoping that the King would fight. However, the King had lost his will to fight since losing his wife and son at the battle against Amadeo, King of Aden.<br>\nThe result was a disaster and not what Alfred Von Hellmann had wanted.<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31528-08.htm\">I need to ask him if there was somebody behind the scenes.</a>\n</body></html>",
  "31528-08.htm": "<html><body>Ghost of Priest:<br>\nI don't know. The High Priest was investigating, ask him!\n</body></html>",
  "31529-01.htm": "<html><body>Ghost of Adventurer:<br>\nDo you have something to tell a ghost who is neither alive nor dead?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-02.htm\">\"I came to listen to you.\"</a>\n</body></html>",
  "31529-02.htm": "<html><body>Ghost of Adventurer:<br>\nWhat do you want to know?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-03.htm\">\"Here's a letter from the High Priest of the Earth.\"</a>\n</body></html>",
  "31529-03.htm": "<html><body>Ghost of Adventurer:<br>\nThis is from High Priest Innocentin? He wants me to work even when I'm dead? Einhasad Temple must be worse off than I thought.<br>\nWell, I don't have anything else to do, so what do you want to know?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-04.htm\">\"I want to know about the Mage of the dark arts.\"</a>\n</body></html>",
  "31529-03a.htm": "<html><body>Ghost of Adventurer:<br>\nThis is from the Priest of the Earth? He wants me to work even when I'm dead? Einhasad Temple must be worse off than I thought.<br>\nWell, I don't have anything else to do, so what do you want to know?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-04.htm\">\"I want to know about the Mage of the dark arts.\"</a>\n</body></html>",
  "31529-04.htm": "<html><body>Ghost of Adventurer:<br>\nHis name is Neid, short for Nidrah.<br>\nI can't rest in peace until I find him.<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-05.htm\">\"Tell me about him.\"</a>\n</body></html>",
  "31529-05.htm": "<html><body>Ghost of Adventurer:<br>\nThe shock of decapitation has dulled my memory, so I don't remember him well, and his disciples burned all the records.<br>\nI think I remember why I'm here.<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-06.htm\">\"Why?\"</a>\n</body></html>",
  "31529-06.htm": "<html><body>Ghost of Adventurer:<br>\nI remember now! I hid the book about him in this well.<br>\nThe heads of those accused of following demons were thrown into it. <font color=\"LEVEL\">If you enter the well, they'll attack you</font>!<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-07.htm\">\"Is there no other way?\"</a>\n</body></html>",
  "31529-07.htm": "<html><body>Ghost of Adventurer:<br>\nOf course! We just came up with another way.<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-08.htm\">\"What is it?\"</a>\n</body></html>",
  "31529-08.htm": "<html><body>Ghost of Adventurer:<br>\nThey aren't very smart! They'll attack if you touch the well.<br>\n<font color=\"LEVEL\">All you have to do is fight them</font>.<br>\nWhile you're fighting, I'll lift up the gate of the well.<br>\nYou can back out if you want to...<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-11.htm\">\"I'll do it!\"</a><br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-09.htm\">\"I quit.\"</a>\n</body></html>",
  "31529-09.htm": "<html><body>Ghost of Adventurer:<br>\nIt's your loss, not mine.\n</body></html>",
  "31529-10.htm": "<html><body>Ghost of Adventurer:<br>\nThey aren't very smart! They'll attack if you touch the well.<br>\n<font color=\"LEVEL\">All you have to do is fight them</font>.<br>\nWhile you're fighting, I'll lift up the gate of the well.<br>\nYou can back out if you want to...<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-11.htm\">\"I'll do it!\"</a><br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-09.htm\">\"I don't want to do it.\"</a>\n</body></html>",
  "31529-11.htm": "<html><body>Ghost of Adventurer:<br>\nOk. Then, let's talk about the method. First, take this jewelry. If you hit the well, the spirits will come out.<br>\nWhile you are fighting with the spirits, I will break the seal of the hidden report in the well<br>\n<font color=\"LEVEL\">Just, don't kill the spirit while I'm working. Because they will come back to the well if they die.</font><br>\nIf I break the seal, the color of the jewelry will change. After that, you can kill the spirit or do whatever you want. You got it?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-13.htm\">\"I am not sure\"</a><br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-13a.htm\">\"I see\"</a>\n</body></html>",
  "31529-12.htm": "<html><body>Ghost of Adventurer:<br>\nIf you hit the well, the spirits will come out.<br>\nWhile you are fighting with the spirits, I will break the seal of the hidden report in the well<br>\n<font color=\"LEVEL\">Just, don't kill the spirit while I'm working. Because they will come back to the well if they die.</font><br>\nIf I break the seal, the color of the jewelry will change. After that, you can kill the spirit or do whatever you want. You got it?<br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-13.htm\">\"I am not sure\"</a><br>\n<a action=\"bypass Script Q00022_TragedyInVonHellmannForest 31529-13a.htm\">\"I see\"</a>\n</body></html>",
  "31529-13.htm": "<html><body>Ghost of Adventurer:<br>\nWhat don't you get?<br>\nFight with them, don't kill them. When the jewelry changes color, find me.<br>\nDon't kill the spirits before the jewelry changes color!\n</body></html>",
  "31529-13a.htm": "<html><body>Ghost of Adventurer:<br>\nOK! Go ahead!\n</body></html>",
  "31529-14.htm": "<html><body>Ghost of Adventurer:<br>\nHey, why don't you do a good job? You can't just hit once and then run away like a child! Real work isn't easy!<br>\n<font color=\"LEVEL\">You must call the soul by beating the well, fight until the jewil changes color, and then investigate the will! Is that clear?</font>\n</body></html>",
  "31529-15.htm": "<html><body>Ghost of Adventurer:<br>\nThe report is at the gate of the well. Since I'm a ghost, you'll have to get it.\n</body></html>",
  "31529-16.htm": "<html><body>Ghost of Adventurer:<br>\nThis is it! I'll break the first seal. Give it to Innocentin, only he can finish opening the lock. Until we meet again!\n</body></html>",
  "31529-17.htm": "<html><body>Ghost of Adventurer:<br>\nThis is my life's work! Quickly, find Innocentin!\n</body></html>",
  "31529-18.htm": "<html><body>Ghost of Adventurer:<br>\nThis is it! I'll break the first seal. Give it to Innocentin, only he can finish opening the lock. Until we meet again!\n</body></html>",
  "31529-19.htm": "<html><body>Ghost of Adventurer:<br>\nThis is my life's work! Quickly, find Innocentin!\n</body></html>"
};
