<a href="https://l2solo.com">
<img alt="Lineage2 Solo local server" src="https://github.com/user-attachments/assets/a75ad34c-6371-46f5-8f78-0447ccc333a3" />
</a>


# L2Solo (C4: Scions of Destiny)

A private local Lineage II C4 fork of L2Solo, transitioning from an ambient bot population to player-owned vassals.

### Current fork: Castellan and owned vassal duties (P1–P3)

Startup now restores only characters registered in `vassals`. Historical bots, clans and inventories remain in SQLite but are not spawned or cold-simulated. Static merchant bots, ambient seeding, autonomous clan planning, legacy population repairs and bot market replay are not started. Ordinary world NPCs and the human market board remain available.

The retained bot services are registry/lifecycle loading, hot-actor snapshot persistence (every 30 seconds), buffered character writes and existing SQLite checkpoint maintenance. Registered vassals are pinned hot. The effective policy is applied **after** local/environment overrides: population persistence stays enabled; cold/background party/director/ambient jobs and `ClanSimulation` stay off; `staticShotsDisabled` stays false. An old `config/local.ini` cannot restore the previous population.

`src/GameServer/Lord/` provides atomic, once-per-character Lord enrollment, one-time free level-1 clan eligibility, and owner-authenticated, replayable vassal creation confirmations. Starter skills are a one-time level-20 lineage grant without SP/books; later paid learning is unchanged. Lord equipment is additive and unequipped to preserve existing gear; new vassals receive equipped mid-D kits. Successful confirmations survive publication failures and can be replayed without new rewards or characters. Clan capacity is enforced in SQLite for both vassal creation and ordinary joins. A Lord with vassals cannot be deleted.

Castellan (stock C4 appearance, server identity `90002`) is permanently registered beside Bella in Gludio at `-12500, 122816, -3114`. His NPC dialogs offer Lord enrollment, the free level-1 clan grant, race/sex/base-class/first-profession vassal selection (Bow/Dagger for mixed classes), replayable creation confirmation, a paginated owned roster, saved duty orders and clan storage. Clan viewing uses the existing privilege; only the leader can withdraw. Autonomous equipment distribution does not consume stock from Lord-led clans. His paid NPC shop sells the starter consumables, D soulshots/blessed spiritshots, Bone Arrows, skill reagents, the approved upgraded healing/cure/speed potions and blessed escape/resurrection scrolls at normal progression-scaled template prices (no Mana Potion); ordinary grocers still do not sell graded shots. Player shop opening and purchase validate physical Castellan contact and the current quote. Vassals physically approach his real spawn to buy recurring supplies with their own Adena; cargo deposits use an ordinary warehouse keeper.

Vassal duties now execute through real hot actors, including when no player is online. Gathering is restricted to the selected authored Gludio/Gludin spawn polygons (Ruins of Agony/Despair, Abandoned Camp, Langk Lizardmen and Wasteland), with existing target safety, combat, Spoil/Sweep and recovery. No safe targets produces an explicit state instead of selecting another hunting area. Owned movement does not use the legacy offscreen coordinate-warp shortcut.

Only the owner can invite/control a vassal. Party admission preserves the gather order and area. Separation, dismissal, party dissolution or owner disconnect starts **60 seconds of safe seated rest**, then resumes that same area. Threats pause the countdown; death/restart repeats the full minute if resumption is pending. Re-invitation cancels the live countdown, and a new explicit order invalidates old continuations. Return/service ends party play; a new gather order in party waits for separation. Non-gathering companions return to Castellan after separation. Bow/Dagger preferences govern mixed-class tactics/equipment/supplies and select the matching legal level-40 profession; specialized classes then govern normally.

Town visits buy affordable standard supplies by priority, then atomically deposit eligible loot/spare equipment and Adena above 100,000 into the original bound clan warehouse. Working gear/supplies remain; there is no clan cash top-up, personal storage, automatic resource sale or premium-potion substitution. Bow attacks consume real arrows/MP; potions and charges consume actual inventory. Cures apply only to eligible debuffs, stronger speed buffs are preserved, and Quick Healing Potions remain emergency healing even during an active healing-over-time effect. Missing optional stock does not force repeated town trips; an unaffordable required supply has an explicit waiting state. Return uses a normal escape-scroll cast or walking, deposits when eligible, then walks to Castellan. Lost clan eligibility cancels gathering, retains cargo and returns to service without an impossible deposit or automatic rebinding.

P3 has syntax/source verification only: physical routes, client dialogs, combat outcomes and the timed rest still need user-run gameplay checks. Geodata preparation/final delivery (P4) remains pending. No server has been started/restarted or live database migration applied during development; migration runs on the next separately authorized server startup.

The cold/hot/static descriptions and feature checklist below describe the upstream systems, not services enabled by this fork's owned-only startup.

**Project status:** PUBLIC ALPHA

🏗️ Work in progress. Playable.


💬 [Discord](https://discord.gg/dXsQ8SJA7k)
Support, updates, and communication. Join the Discord to stay up to date with development.

⚔️ [Game client](https://drive.google.com/file/d/1u0nW3m9c6Hql8sR9POQAcvglxIno23lv/view?usp=sharing)
Clean C4 client protocol 656

🧩 [L2Solo client mod](https://drive.google.com/file/d/1nDTPAHRFe2WQmt2IDfkBZMwEqVEYT4XD/view?usp=sharing)
Optional but recommended for a better experience


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

### ✅ Upstream capabilities

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

- Node.js v22.15+
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

Nearby bots also react to plain chat lines such as `hi`, `follow`, `wait`, `hunt`, `heal`, and `buff`.

## Credits

This project is a heavily modified solo-MMO fork of the original [NodeL2 Server Emulator](https://github.com/NodeL2/NodeL2).

L2Solo is licensed under the Apache 2.0 license.

Crafting with ❤️ by players for players 🤘

<img width="600"  alt="L2solo hit the star" src="https://github.com/user-attachments/assets/5e22564f-fe8e-4956-af21-1158f1849a31" />
