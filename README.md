<a href="https://l2solo.com">
<img alt="Lineage2 Solo local server" src="https://github.com/user-attachments/assets/a75ad34c-6371-46f5-8f78-0447ccc333a3" />
</a>


# L2Solo (C4: Scions of Destiny)

This private L2Siege deployment defaults to **Fortress of Resistance defense**, not the upstream ambient population of over 1700 bots.

L2Solo is the upstream local-first Lineage II C4 server emulator. Its broader features remain in this fork; the current deployment restrictions and scenario are described below.

**Project status:** PUBLIC ALPHA

🏗️ Work in progress. Playable.


💬 [Discord](https://discord.gg/dXsQ8SJA7k)
Support, updates, and communication. Join the Discord to stay up to date with development.

⚔️ [Game client](https://drive.google.com/file/d/1u0nW3m9c6Hql8sR9POQAcvglxIno23lv/view?usp=sharing)
Clean C4 client protocol 656

🧩 [L2Solo client mod](https://drive.google.com/file/d/1nDTPAHRFe2WQmt2IDfkBZMwEqVEYT4XD/view?usp=sharing)
Optional but recommended for a better experience


## Fortress of Resistance defense (local default)

Speak to **Tamutak** beside the fortress courtyard. New player characters start there; existing characters are not relocated. Ordinary town-return after death goes there too, while arena and clan-hall destinations keep their own rules.

- **Prepare:** choose a legal first profession if needed, then a compatible complete high-D equipment kit. Preparation raises a lower level to 20 without reducing higher levels, preserves existing items, and adds **10,000,000 Adena**. Equipment is added **unequipped**, with **5,000 D-grade soulshots (SSD)** for physical weapons or **5,000 blessed D-grade spiritshots (BSSD)** for magic staves. Existing items, including old no-grade shots, are not removed. Make room and weight allowance first. The equipment/shots/Adena grant and its lifetime character claim commit together; relogging or restarting does not renew it. Profession selection can be completed before the final kit claim.
- **Supplies:** Tamutak's NPC shop sells D soulshots, spiritshots/blessed spiritshots (SSD/SpSD/BSSD), arrows, HP/MP potions, movement/attack/casting-speed potions, antidotes, bandages, and escape/resurrection scrolls.
- **Summon squad:** once per server process, create five native level-20 bot companions: female Human Cleric, male Human Knight, male Human Rogue with a bow, female Dark Elf Dark Wizard, female Elf Elven Wizard. They have class-appropriate equipment, 5,000 SSD or BSSD matching their weapon, other supplies and random valid appearances. They wait for the summoner's normal `/invite`; only that character can recruit/control them. Existing party role, follow, support, combat, chat and trade mechanisms remain in use. Dismissed/disconnected companions wait rather than hunting or visiting shops; dead companions remain corpses for ordinary resurrection, without automatic town revival.
- **Start attack:** a separate shared action, available to another player too. The fortress gates open immediately when the start is accepted. Group 1 is released no earlier than **30 seconds after the click**, and only after successful route preflight, giving defenders time to leave. Groups 2–15 follow at 30-second intervals. Groups 1–5 contain five Reserve; 6–10 four Reserve and one Shooter; 11–15 two Reserve, one Shooter and two Guerilla: **75 attackers (55/10/10)**. Three approaches lead toward distinct courtyard positions through native geodata movement. Monsters retain their normal combat, ranged behavior, XP and drops; they do not respawn. Defender deaths do not stop the schedule.

Squad identities, progression and **all belongings left with them are disposable**. At the next startup, explicitly registered temporary accounts/characters and their dependent data are deleted, including after a crash. Items already transferred to real players remain theirs. Existing ambient bot identities are retained, not wiped.

The summon and attack gates are global for the process, not per player. Attack preflight rejection permits another attempt without publishing attackers; the gates remain open. Squad preflight rejection before provisioning also permits another attempt. A provisioning/publication failure after side effects consumes that action until restart; Tamutak reports attack progress and technical release failures. There is no victory/defeat handler, bonus reward, automatic reset or replay button.

Defaults disable both `[BotPopulation] enabled` and `[ClanSimulation] enabled`. Ambient simulation, static bot merchants, saved bot activation, bot shop projections and extra arena bot clones are not started. Ordinary real-player AFK shops remain available. Do not enable population in local/environment overrides: fortress initialization rejects that configuration. The progression cap must allow level 20. Verified geodata is required for squad placement and attack preflight (`npm run geodata` prepares it without starting the server).

The source, syntax and offline geodata paths have been checked; startup, client interaction, combat/resurrection, relog persistence and crash/restart acceptance still require a separately authorized runtime session. Before first deployment of the ownership/cleanup changes, ensure a consistent SQLite backup (including WAL where applicable) under `/data/!backups/L2Siege/`; do not copy only a live main database file or wipe bots.

## Upstream feature overview

The simulation descriptions and feature lists below describe upstream capabilities, not the enabled ambient behavior of this deployment.

💻 Simulation - everything that is happening in the game world besides player actions.

🧊 Cold bots - bots in the background, everywhere on the server where the player cannot see. Works like a less detailed simulation but keeps base bot abilities, stats, and goals, including cold bot parties, clans, etc. Bots become cold when goes out of the player's view range. Can communicate, including with the player (optional LLM integration). Uses much less compute.

🔥 Hot bots - bots that the player can see, or within maximum client view range. Any cold bot can become hot if the player is nearby. Highest detail level, uses much more compute for realistic movement, actions, etc.

🌳 Static bots - static traders in towns and crafting stations in Giran. Needed only for a specific function, no brain, no communication or goals.


## Latest updates
- **2026-10-18** A living world economy, market board, better bot progression
- **2026-10-03** Bot and performance fixes, player-led raids, better observer, quests and more
- **2026-09-29** Market, recipes, bot shoulshots craft, paid buffs, fixes and improvements
- **2026-09-26** Bot raid boss farm, player bot party join, SA, fixes and updates
- **2026-09-22** Bot progression, clan party, craft, trading fixes; realistic bot and clan names
- **2026-09-21** L2Solo client mod, server-side mod support, in-game items db
- **2026-09-20** Clan halls, clan craft goals, clan WH resources collection, fixes and improvements
- **2026-09-17** Death exp penalties, overhit bonus, max level setting, bot lucky protection
- **2026-09-17** Gameplay fixes, clan progression, skills, and town services
- **2026-09-14** Better class-specific bot gameplay, fixes, and improvements
- **2026-09-12** Bot persistent social memory and hot/cold PvP
- **2026-09-08** Pets, striders, clan lvl 4, fixes and updates
- **2026-09-06** Bot PvP, save game, save TP location, optimization, chat, navigation
- **2026-09-04** Player clan warehouse use for equipment exchange, bug fixes
- **2026-09-02** AFK trade, market observer, xN mob fix
- **2026-08-31** Expand bot world simulation, arena duels, and server knowledge tools
- **2026-08-28** Skills, bot behavior, gear planning, and seeder fixes and improvements
- **2026-08-27** Add LLM-driven clan management
- **2026-08-26** Observer update, better and faster, player clan crest control, player clan goal control
- **2026-08-25** Bot clans update follow-up, bug fixes

<details>
<summary>Earlier</summary>

- **2026-08-24** Bot clans, better cold/hot performance, bug fixes, and more
- **2026-08-20** Loot and mob skills bug fixes, bot social graph base
- **2026-08-19** Runtime optimization, cold bot progression bottlenecks fix, bot equipment enchantment
- **2026-08-18** Fixes, cold bots progression, better AI compatibility
- **2026-08-17** Fix cold bot progression, melee and polearm attack range, raid minion party fear
- **2026-08-16** Summoners, BD, SWS, agro skills and Observer update
- **2026-08-15** Blade Dancers and Sword Singers bot progression update
- **2026-08-15** Raid Encounter and Gameplay Stability Update
- **2026-08-15** Server stability and performance update
- **2026-08-13** Fix hot party performance issues, fix raid boss atk freeze
- **2026-08-13** Raid bosses, better bot progression and market use, skill fixes, party finder update
- **2026-08-11** Expand C4 world content and bot progression systems
- **2026-08-09** Expand C4 world content and runtime fidelity

</details>

See the full update log on our [Discord](https://discord.gg/dXsQ8SJA7k) server.

## Game Checklist

### ✅ What's done

**Server:**
- Server launcher
- Authentication: create account, login (C4 client, protocol 656)
- Character creation
- Variable server rates for each server start: (x1/x10/x50) XP, SP, party XP/SP, drop/adena/spoil multipliers
- Real-time player web map that shows bots and players
- Partial or full wipe anytime

**World:**
- Complete geodata for all locations
- Complete live economy
- Teleports via NPC or .admin menu
- Live world / local / party / trade chats
- NPC shops in towns
- Profession change (first to third)
- Auto-learn skills (no books or NPC needed)
- Quests (0-20lvl + 1st profession change)
- Private trade or craft
- Clans, including bot clans
- PK system
- Save game
- Clan halls
- SA

**Character:**
- Progression depending on chosen rates
- Full C4 skill coverage: self, targeted, AoE, effects, items, and class skills
- Potions, scrolls, spoil, SA, manor, etc
- Party with bots with native (/invite, /leave), plus `.botparty` / `.bp` to find bots and invite them to the party
- All armor sets
- Soulshots/Spiritshots
- Death, respawn

**Mobs:**
- Attack
- Skill usage
- Drop table (scales from server rates)
- Social agro
- AoE agro
- Party loot
- Raid bosses

**Bots:**
- Dynamic bot population with a smart new bot seeding up to 1700
- Bots are farming solo and in party
- In-party roles (tank, dps, healer, buffer, etc)
- In-party buff control
- Bot goals: equipment craft/drop/purchase, gain wealth, lvl-up faster, etc
- Craft using recipes and craft stations
- Selling loot in towns using a private store
- Buying needed resources or equipment
- PK bots
- Bots attack a PK or run away
- Bots will argue, then attack if a bot or a player hits the same mob
- Communication in chat (LFP, LFG, PK alert, etc)
- Cost parties and friends system
- Reputation system - bots will reject player party if you treat them badly or become friends and const party members if good
- Bots ask for loot if you have something they need
- Bots go for NPC (Nobie guide) buff
- Bots change their farming location based on lvl, number of mobs around, or a crafting goal
- Bots join and fight in a party with a player
- Bots have a memory about interaction with a player; they act correspondingly 
- Bot persona traits: Sociability, Commitment, Caution, Ambition, Assertiveness, Empathy, Resilience
- Bots create clans, level clans up, form clan farm parties
- Bots will fight over mobs on a farm spot
- Bot clans can form raid boss farm parties
- Players can join bot parties

### ✴️ Will be added

- Clan wars
- Olympiad, heroes
- Sieges (bot- or player -driven)
- World bosses
- Full quests, including profession change
- Better bot AI brain
- Complete Lineage 2 C4 experience

<p align="center">
<img src="https://github.com/user-attachments/assets/99695c45-80e8-4300-afa6-cada58ccd3bd" />
</p>

## 🎮 Wanna play now?

You will need:

- Node.js >=22.5.0
- A [Lineage II C4 client](https://drive.google.com/file/d/1u0nW3m9c6Hql8sR9POQAcvglxIno23lv/view?usp=sharing) using protocol 656

## Quick Start

```bash
git clone https://github.com/pmbstyle/L2Solo.git
cd L2Solo
npm install
npm start
```

That command will start the L2Solo Launcher.

Press `Start` in the launcher to run the server. 

Use **Saved Games** while the server is stopped to save a full copy of your world database. Enter a name or leave it blank for a generated one. Saves are stored in `tmp/saves` (or `saves` inside a custom runtime directory), with no limit on their number beyond available disk space. The list shows each save's name, date, time, and size in GB.

**Load** replaces the current database with the selected save and leaves the server stopped. **Delete** permanently removes that save. Both actions ask for confirmation. All saves are manual: loading never creates an automatic backup. Configuration files and launcher settings are not part of a save.

On the first server start, L2Solo checks `data/Geodata`. If the region files are missing, it downloads the verified C4 geodata pack from `https://l2solo.com/files/geodata.zip` and installs it before opening the game server. The archive is about 209 MiB and expands to about 900 MiB. You can prepare it without starting the server with:

```bash
npm run geodata
```

Custom mirrors and external geodata directories can be configured with `L2NODE_GEODATA_URL`, `L2NODE_GEODATA_SHA256`, and `L2NODE_GEODATA_DIR`.

## Configuration

Committed defaults live in `config/default.ini`.

Private local overrides go in ignored `config/local.ini`. This is where API keys and a machine-specific SQLite path belong.

Players' personal warehouses are shared by all characters on the same account.
On startup, existing player warehouse items move to account ownership, preserving
equipment enchantments and pet data. Bots retain their character warehouses.
Deleting a character leaves the account warehouse intact. The shared capacity is
300 item stacks or individual equipment rows for every player character, regardless
of race or Expand Storage skill. Override `[GameServer] playerWarehouseSlots`
(1..1000) to change it; restart to apply. Existing stock above a reduced limit
remains withdrawable, and deposits into existing stacks remain available.

Example:

```ini
[OpenRouter]
enabled = true
apiKey = <your-OpenRouter-key-here>
apiUrl = https://openrouter.ai/api/v1/chat/completions
model = openai/gpt-5.6-luna
partyRouterModel = openai/gpt-5.6-luna
# Leave empty if the selected model does not accept temperature.
temperature =
completionLimitParam = max_tokens
strictSchema = true
providerOrder = OpenAI
providerSort = price
allowFallbacks = false
requireParameters = true
debug = false
```

OpenRouter can also read the key/model from environment variables:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key-here npm start
```

The bot simulation can also use a local or remote provider that exposes the
OpenAI-compatible Chat Completions API. Use an `[AI]` section instead of
`[OpenRouter]` and provide the complete endpoint URL:

```ini
[AI]
enabled = true
apiUrl = http://127.0.0.1:1234/v1/chat/completions
apiKey = lm-studio
model = <model-id-from-the-provider>
partyRouterModel = <model-id-from-the-provider>
# Model-specific request parameters are configured explicitly.
# temperature = 0.35
# completionLimitParam = max_tokens
# strictSchema = false
# Optional for thinking models: off (default), low, medium, or high.
# reasoningEffort = off
```

For Ollama, use `http://127.0.0.1:11434/v1/chat/completions` and a pulled model
tag such as `llama3.2`. The API key can be empty for local providers; a value
like `ollama` or `lm-studio` is also accepted when the server expects an
OpenAI-compatible client key. Thinking is disabled by default for `[AI]`,
which keeps the bounded bot response budget available for the required JSON;
set `reasoningEffort` to `low`, `medium`, or `high` when the selected model
benefits from explicit reasoning.

Clan chat uses the same `model` and `partyRouterModel` settings. Names, roles,
selected clanmates, and follow-up messages are routed first; ambiguous messages
use the routing model to choose one responder or ask for clarification. Both
active and background clan bots can reply in the clan channel. This path is
conversation-only, with no tools or game actions. The clan shares a bounded
in-memory conversation history, separate from party chat and private tells;
it expires after 30 minutes of inactivity and resets on server restart.

## In-Game Commands

- `.admin` - open the admin menu.
- `.sell` - sell all unequipped non-Adena items for 50% item value.
- `.afksell` - open the native private-sale window and leave a persistent AFK shop at the current peace-zone location.
- `.afkbuy` - open the native private-purchase window and reserve its Adena budget in a persistent AFK shop.
- `.afkstop` - close the active AFK shop remotely and return all remaining reserved items or Adena.
- `.bot` / `.b` - open companion controls.
- `.botparty` / `.bp` - search active bots to join the player party; distant companions catch up after joining.
- `.joinparty [name]` - ask to take over the named bot's autonomous party, or the nearest eligible bot party when no name is given; if accepted, the player becomes leader and the bots resume their autonomous party after the player leaves.
- `.botfriends` / `.bf` - friend list and const party management.
- `.botstatus` / `.bs` - show a bot overview panel.
- `.botstatus <name>` / `.bs <name>` - show detailed status for a specific bot.
- `.botpath` / `.bpath` (optionally with `<name>`) - inspect bot movement, town-route waypoints, and geodata path diagnostics.
- `.trade` or `/trade` - open the bot trade window with the targeted SimPlayer, useful as a fallback to the native client trade action.
- `.leave` - dismiss all companion bots.
- `.kick <name>` - dismiss one companion bot.
- `/invite` while targeting a bot - recruit that bot as a companion.
- `/dismiss <name>` and `/leave` also work through the party request path.
- `.go` to start arena PvP
- `.buff` target a bot to ask for a paid buff service

Nearby bots also react to plain chat lines such as `hi`, `follow`, `wait`, `hunt`, `heal`, and `buff`. Fortress companions accept only their summoner's control and do not enter independent hunting, town shopping or supply errands; extra arena bot clones are disabled in this deployment.

## Credits

This project is a heavily modified solo-MMO fork of the original [NodeL2 Server Emulator](https://github.com/NodeL2/NodeL2).

L2Solo is licensed under the Apache 2.0 license.

Crafting with ❤️ by players for players 🤘

<img width="600"  alt="L2solo hit the star" src="https://github.com/user-attachments/assets/5e22564f-fe8e-4956-af21-1158f1849a31" />
