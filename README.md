<a href="https://l2solo.com">
<img alt="Lineage2 Solo local server" src="https://github.com/user-attachments/assets/a75ad34c-6371-46f5-8f78-0447ccc333a3" />
</a>


# L2Solo (C4: Scions of Destiny)

This checkout is **L2Siege** (`L2Kingdom`), a private local Lineage II C4 fork of L2Solo / NodeL2 with player-owned vassals. Upstream names remain in package metadata and runtime identifiers.

**Project documentation:** start with the [architecture and ownership map](docs/README.md). It links the [runtime/configuration guide](docs/runtime.md), [operations and side effects](docs/operations.md), [vassal contract](docs/vassals.md), and detailed protocol, persistence, world, economy, AI, observer and content guides. The documentation distinguishes active owned-only behavior from retained upstream systems; it is not a claim of runtime or client acceptance.

### Current fork: Castellan and player-owned vassals

#### Owned-only world

Startup restores only characters registered in `vassals`. Historical bots, clans and inventories remain in SQLite but are not spawned or cold-simulated. Static merchant bots, ambient seeding, autonomous clan planning, legacy population repairs and bot market replay are not started. Ordinary NPC services, monsters and the human market board remain available.

The retained bot services are registry/lifecycle loading, hot-actor snapshot persistence (every 30 seconds), buffered character writes and existing SQLite checkpoint maintenance. Registered vassals stay hot even offscreen or with no player online. The effective policy is applied **after** local/environment overrides: population persistence stays enabled; cold/background party/director/ambient jobs and `ClanSimulation` stay off; `staticShotsDisabled` stays false. Old population settings cannot restore legacy bots. Gathering continues while the server runs, but server downtime grants neither rewards nor rest-countdown credit.

#### Castellan, Lord enrollment and creation

Castellan (stock C4 appearance, server identity `90002`) stands beside Bella in Gludio at `-12500, 122816, -3114`. New player characters of every race start beside him at `-12500, 122916, -3114`, within dialog range without overlapping the NPC. Existing characters keep their saved locations; death/escape destinations are unchanged. Speak to him for Lord enrollment, clan creation/eligibility, vassal creation, the paginated owned roster and orders, supplies and clan storage. Actions require physical NPC contact and server-side eligibility checks.

- **Lord enrollment is once per character.** It raises the character to at least level 20, selects a legal first profession only for a base-class character, and adds a full top-D kit, starter supplies and 1,000,000 Adena. Higher levels/professions, existing skills and items are preserved; reward equipment is added **unequipped**. Level-20 lineage skills are granted without SP/books; later paid learning is unchanged.
- **Free clan eligibility is one-time.** A Lord may create a level-1 clan or raise their existing level-0 clan to level 1. Higher upgrades retain normal rules. Vassal creation requires the Lord to lead an active level-1+ clan without the applicable clan penalties/cooldowns.
- **A new vassal is free**, level 20, with equipped mid-D gear, legal starter skills, supplies and 100,000 Adena. Choose race, sex, base class and first profession; the name is generated. Creation consumes a normal clan slot. There is **no extra vassal cap beyond clan capacity**: a level-1 clan containing only its Lord has room for 14 vassals. Ordinary members also consume slots.
- **Confirmations are replayable.** Retrying the same successful creation confirmation returns the same character, including after a live-publication failure. Only a new explicit confirmation creates another vassal. Reopening enrollment or relogging never repeats the Lord gift. Clan capacity is enforced in SQLite for both creation and ordinary joins.
- **Bow/Dagger** is available for Rogue, Elven Scout and Assassin without changing their first profession. A vassal's saved choice governs tactics, equipment and supplies, then selects the matching legal level-40 profession. The specialized class governs normally afterwards.
- Ownership is character-based: only the owner can invite/control/order the vassal. A Lord who still owns vassals cannot be deleted. Creation, grants and duty persistence live in `src/GameServer/Lord/`.

Both equipment tiers include a compatible weapon, shield where appropriate, full armor coverage, a necklace, two rings and two earrings, without enchants. Starter quantities for both Lords and vassals are:

| Supply | Initial quantity |
| --- | ---: |
| Healing Potion / Quick Healing Potion | 100 / 10 |
| Antidote / Bandage / Haste Potion (movement) | 20 each |
| Scroll of Escape / Scroll of Resurrection | 20 / 10 |
| Potion of Alacrity (physical) or Magic Haste Potion (caster) | 20 |
| D Soulshots (physical) or D Blessed Spiritshots (caster) | 5,000 |
| Bone Arrows (bow kits only) | 5,000 |

Spirit Ore, Soul Ore and D crystals are granted/retained/restocked only when learned skills require them, not as a universal bundle. Recurring restock minima/targets are separate from these one-time starter counts.

#### Orders and party play

Gathering uses only the selected authored Gludio/Gludin spawn polygons: Ruins of Agony, Ruins of Despair, Abandoned Camp, Langk Lizardmen and Wasteland. The menu shows monster levels and disables unsuitable areas. Existing target safety, combat, Spoil/Sweep and recovery remain in use. Defensive encounters during town/supply trips finish their target/corpse processing before the trip resumes. No safe targets produces an explicit state rather than switching areas. Duty travel uses real pathfinding, not legacy offscreen coordinate warps. Client character visibility follows live coordinates: leaving the 6000-unit radius sends `DeleteObject` to previous observers, and re-entry sends `CharInfo` plus the current movement segment. This also applies when the observer moves, so departed vassals do not remain as stationary client-side ghosts.

Owner party invitations retain normal companion combat/support roles and **preserve the gather order and area**. Separation, dismissal, party dissolution or owner disconnect starts **10 minutes of safe seated rest at the current location**, without a town/warehouse trip, then resumes the same area. Threats pause the countdown; death or restart repeats the full 10 minutes if resumption is pending. Re-invitation cancels the live countdown; the next separation starts a fresh 10 minutes. Failed admission does not change the duty or start a rest.

A new explicit order wins over old travel/rest continuations. Return/service ends party play; a new gather order in party waits for separation and rest. Non-gathering companions return to Castellan after separation; an interrupted return resumes rather than becoming free hunting. Orders and ownership survive restart. Ordinary gatherers resume normally; interrupted gatherers repeat the full 10 minutes of safe rest without reconstructing the old party.

#### Supplies and clan cargo

Castellan's paid shop sells all starter supplies, D soulshots/blessed spiritshots, Bone Arrows and skill reagents at normal progression-scaled template prices. Shop-only extras are Greater Healing Potion, Greater Antidote, Emergency Dressing, Greater Swift Attack Potion, Greater Magic Haste Potion, Blessed Scroll of Escape and Blessed Scroll of Resurrection. **Mana Potion is not included** in his shop or starter kits; its availability elsewhere is unchanged. Ordinary grocers still do not sell graded shots. Player purchases validate physical contact and the current quote; vassals physically approach Castellan and spend their own Adena, with no remote purchases.

Town visits buy affordable standard supplies by priority, then atomically deposit eligible loot/spare equipment and **Adena above 100,000** at an ordinary warehouse keeper into the original bound clan warehouse. This is a retained cash limit at deposit, not a hunting-wallet cap or automatic top-up. Working gear/supplies remain; a sub-maximum weight penalty from retained stock alone does not block gathering, while full inventory slots or maximum load still do. There is no clan withdrawal, personal-storage diversion, automatic resource sale or premium substitution. Clan viewing uses the existing privilege; only the leader can withdraw. Autonomous equipment distribution does not consume Lord-led clan stock.

Bow attacks consume real arrows/MP; potions and charges consume inventory. Cures apply only to eligible debuffs, stronger speed buffs are preserved, and Quick Healing Potions remain emergency healing even during healing-over-time. Missing optional resurrection/speed supplies does not block a viable outing or force repeated town trips; unaffordable required supplies produce an explicit waiting state rather than free refills. Receiving the missing required stock through owner trade resumes gathering without an Adena transfer or a new order; changes to supply stock or Adena trigger a purchase retry if required items are still missing.

Return uses a normal escape-scroll cast or walking, deposits when eligible, then walks to Castellan. Empty cargo/no excess cash needs no transfer. Losing the original clan membership/owner leadership or clan eligibility cancels gathering, retains cargo and returns the vassal to service with a reason, without an impossible-deposit loop or automatic clan rebinding. Restoring eligibility does not silently restart the cancelled gather order.

#### Delivery and manual acceptance

P1–P4 implementation/preparation is complete; geodata has been installed locally through the pinned-checksum bootstrap. **Gameplay acceptance is still pending user testing.** Syntax/source checks do not establish physical routes, client dialogs, combat, inventory effects or timing. No server start/restart or live-world migration was performed for these phases; migration runs on the next separately authorized startup.

Before applying migration to an irreplaceable saved world, arrange a separately authorized stop of writers and a consistent, readable backup under `/data/!backups/L2Siege/`. Do not copy only a live SQLite main file while ignoring its WAL. A new empty world needs no backup.

After a separately requested launch, manually verify:

1. Castellan appears beside Bella with normal NPCs/mobs and no legacy bots, including delayed seeding or finder invitations.
2. Two independent Lords receive correct one-time kits; replay/relogin grants nothing twice. Invalid/full-clan creation fails cleanly; duplicate confirmation creates exactly one vassal. Another Lord cannot control it.
3. Caster/melee/Bow/Dagger/Scavenger gear, skills, supplies and paid physical purchases work; Mana Potion is absent. Consumables have the intended effects and spend actual items/Adena.
4. Gathering stays in the chosen area, including offscreen/owner offline, and uses actual combat/Spoil/Sweep. Party roles work; separation rests safely for 10 minutes before resuming. Re-invites, threats, death and new orders invalidate or pause the right actions.
5. Restock/return physically reach the seller and warehouse, preserve working stock and deposit only eligible cargo/excess cash. Empty deposits succeed; interrupted/repeated operations do not duplicate items or revive stale orders. Lost clan eligibility retains cargo and returns with a reason.
6. After an authorized restart, consumed grants, ownership, clan binding, inventory, loadout and duties persist; pending party interruptions repeat the full 10 minutes of safe rest without downtime rewards. Owner deletion remains refused while vassals exist.

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

- Node.js >=22.5.0 (the engine requirement in `package.json`)
- A [Lineage II C4 client](https://drive.google.com/file/d/1u0nW3m9c6Hql8sR9POQAcvglxIno23lv/view?usp=sharing) using protocol 656

## Quick Start

```bash
git clone git@github.com:qwear0/L2Kingdom.git
cd L2Kingdom
npm install
npm start
```

That command starts the persistent WorldObserver management UI, not gameplay. Open **Settings → Server management** at `http://127.0.0.1:8088/observer/settings/server` (or the configured `[WorldObserver] hostname/port`) and press **Start**. **Stop** stops only the game; the same Settings URL, logs and saves remain available. Cloning this private fork requires repository access; cloning upstream L2Solo does not provide this fork's implementation.

World/Bot/Server configuration uses explicit per-tab **Save changes** and **Discard draft**. Fields show saved versus actually active values and live/game-restart/management-restart scope. A successfully saved live value that could not be confirmed active requires **Stop → Start**, not an automatic retry or restart. The separate x1/x10/x50 preset form changes only the next managed start; it never changes a running child or saves unrelated drafts. See [Settings and management](docs/world-observer.md) and [configuration precedence/native limits](docs/runtime.md).

There is one public management origin, no old launcher page/8090 listener or legacy `/api/*` management routes. `npm run NodeL2` remains a standalone runtime wrapper, not an alternative persistent management UI. `WorldObserver.enabled=false` disables the game observer API only; management still runs under `npm start`. Existing private configuration, service ownership and trusted LAN/firewall binding must be checked before a separately authorized cutover. No login system is added, and these controls must not be exposed to the Internet.

Use **Saved Games** while the server is stopped to save a full copy of your world database. Enter a name or leave it blank for a generated one. Saves are stored in `tmp/saves` (or `saves` inside a custom runtime directory), with no limit on their number beyond available disk space. The list shows each save's name, date, time, and size in GB.

**Load** replaces the current database with the selected save and leaves the server stopped. **Delete** permanently removes that save. Both actions ask for confirmation. All saves are manual: loading never creates an automatic backup. Configuration files and the retained `launcher-settings.json` preset store are not part of a save.

On the first server start, L2Solo checks `data/Geodata`. If the region files are missing, it downloads the verified C4 geodata pack from `https://l2solo.com/files/geodata.zip` and installs it before opening the game server. The archive is about 209 MiB and expands to about 900 MiB. You can prepare it without starting the server with:

```bash
npm run geodata
```

The default archive is pinned to SHA-256 `044e5507c3f0f55785a4698fec3ebd5e0e69bc9cce5bd5b669b8758c4a43f26d`. Preparation checks for at least 203 region files plus the expected sizes of three required files; a nonempty incomplete directory is rejected rather than overwritten. A complete directory is reused without downloading. Geodata stays local and is Git-ignored.

`L2NODE_GEODATA_DIR` overrides the geodata directory for both preparation and runtime; it is not an INI setting. `L2NODE_GEODATA_URL` selects a mirror, while `L2NODE_GEODATA_SHA256` supplies an explicitly trusted alternate checksum. Leave them unset for the pinned default archive.

## Configuration

Committed defaults live in `config/default.ini`.

Private local overrides go in ignored `config/local.ini`. This is where API keys and a machine-specific SQLite path belong.

Players' personal warehouses are shared by all characters on the same account.
On startup, existing player warehouse items move to account ownership, preserving
equipment enchantments and pet data. Bots retain their character warehouses.
Deleting a character leaves the account warehouse intact. The shared capacity is
300 item stacks or individual equipment rows for every player character, regardless
of race or Expand Storage skill. Override `[GameServer] playerWarehouseSlots`
(1..1000) to change it; Settings applies this live for subsequent deposits after Save. Existing stock above a reduced limit
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
use the routing model to choose one responder or ask for clarification. The
service supports hot and cached-background candidates, but owned-only startup
does not run the autonomous background population. Clan chat also supports the
narrow validated request to join an eligible existing autonomous party; it is
not a general command channel. See [AI and social behavior](docs/ai-social.md)
for the action and activation boundaries. The clan shares a bounded
in-memory conversation history, separate from party chat and private tells;
it expires after 30 minutes of inactivity and resets on server restart.

## In-Game Commands

These are implemented command entrypoints, not a promise that every legacy
scenario is available in owned-only mode. Vassal recruitment/control requires
character ownership; autonomous-party takeover requires an eligible existing
party, which current startup does not create. See the [vassal contract](docs/vassals.md)
and [bot execution boundary](docs/bot-runtime.md).

- `.admin` - open the admin menu.
- `.menu` - open the server command menu (stock HTML unless an optional native menu is negotiated).
- `.autofight` - open connected-player bounded hunting. Hunt sets the zone center/rest point and a custom integer radius of 1–6000 (default 1200); Skills offers paged learned-skill ON/OFF links; Settings edits basic-only, physical pickup and HP/MP recovery thresholds. Preferences save per character; points and active combat never persist or resume automatically. Defaults: basic-only ON, empty whitelist, pickup OFF, HP 35/95%, MP 20/95%. Turn basic-only OFF for allowed offensive/Shield Stun/support/Spoil/Sweep/summon skills; existing summons may still attack/follow in basic-only mode. Low HP/relevant MP pauses pulls and returns to the fixed rest point. Full inventory/recipient capacity or pickup award failure latches a hunting pause until Stop/Start. Skills can be disabled while running; structural edits require Stop. Load/save failures are visible and block Start until resolved. Manual combat/movement takes over. Implementation is statically checked; real-client acceptance and live migration 69 remain pending. See [control, recovery and limitations](docs/world-combat.md#connected-player-auto-fight).
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
