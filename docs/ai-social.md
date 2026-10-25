# AI dialogue, tools and social memory

Read this before changing chat routing, external requests or social facts. Rule-based bot gameplay and optional external inference are separate layers. See the [project map](README.md), [bot runtime](bot-runtime.md) and [vassal authority](vassals.md).

## Activation and provider configuration

- `config/default.ini` disables OpenRouter. A configured provider is supported behavior, not evidence that inference is enabled in a particular installation.
- `src/GameServer/Bot/AI/OpenRouterGateway.js::config` prefers an existing `[AI]` section over `[OpenRouter]` rather than merging them as equivalent providers.
- `[AI]` uses a complete OpenAI-compatible Chat Completions endpoint. Corresponding overrides include `L2NODE_AI_API_URL`, `L2NODE_AI_API_KEY`, `L2NODE_AI_MODEL` and `L2NODE_AI_PARTY_ROUTER_MODEL`.
- Legacy OpenRouter configuration accepts its `OPENROUTER_*` key/model/router overrides; the gateway also checks `L2NODE_AI_API_URL` when selecting the URL.
- Temperature omission, completion-limit parameter, strict schema and reasoning effort are explicit provider/model choices. Do not assume a provider accepts every optional field.
- Gateway concurrency, budgets, deadlines, schema handling and circuit state bound requests. Different callers can supply different timeout/token limits; there is no single universal chat deadline.

Keys belong in private configuration/environment, not source documentation. External requests can include supplied dialogue and game context; choosing a remote provider crosses the application boundary.

## Player speech → response → validated action

Relevant owners under `src/GameServer/`:

1. `Network/Request/Speak.js` receives native chat and command input.
2. `Bot/BotManager.js` handles routing and deterministic speech rules; when inference is unavailable, supported greetings and follow/wait/hunt/heal/buff commands still have rule-based paths.
3. `Bot/AI/BotDialogueArbiter.js`, party routing and `BotBrain.js` select the responder and assemble a bounded turn.
4. `BotContextAssembler.js` supplies current status, persona, conversation and social/event context.
5. `OpenRouterGateway.js` performs the external request; the result remains a proposal, not a direct world mutation.
6. `BotAgentTools.js` and `BotToolRegistry.js` validate available actions, authority, confidence, replay and freshness before dispatch. Mutating actions retain one-mutation-per-turn constraints.
7. Native gameplay services recheck their own action conditions and publish actual results.

Owned-vassal mutations require the owning character/current party authority. A name selected by the router, a friendly relationship or fluent generated text does not grant command permission. Disabled autonomous duty changes are not made available merely because a model proposes them.

Hot/cold dialogue paths can fall back to speech without executing a failed provider action. Clan provider failure returns an unsuccessful result without inventing a generated reply. Failure handling is caller-specific, not a universal promise that every request eventually produces chat.

## Dialogue persistence is not factual social memory

| State | Owner | Contract |
| --- | --- | --- |
| Per-player/bot conversation | `BotConversationService.js`, `BotConversationStore.js` | Durable conversation tables with bounded prompt context; recent messages and summary are not the whole SQL history. |
| Summaries | `BotConversationSummarizer.js` | Versioned updates; action-backed promises must not be inferred from unsupported prose. |
| Personal directed relations | `Social/InteractionMemoryRuntime.js` and repository | Accepted factual episodes, replay/decay/limits and shared decision views. |
| Clan reputation | `Clan/ClanSocialRuntime.js` and social-memory persistence | Separate attributed clan projection, not another copy of private chat. |
| Clan chat context | `Bot/AI/ClanDialogueService.js` | Bounded RAM history, separate from private tells and party chat. |

Conversation storage can fall back to RAM when persistence is unavailable. A successful in-process conversation operation is therefore not proof of restart durability. Fallback or undelivered bot messages are excluded from model history. Bounded prompt context does not prove bounded persisted dialogue retention.

`BotSocialMemory.js` projects the shared directed interaction-memory model rather than owning a second independent relationship store. Accepted personal events and attributed clan updates can commit together through `Database.commitInteractionMemory`.

Combat-event queues are RAM until committed; shutdown attempts to drain them. Unknown/unloaded relations, lazy decay, replay keys and factual attribution matter to decisions. Reputation influences choices but never authorizes an otherwise illegal attack.

## Clan chat and inactive autonomous systems

`ClanDialogueService` selects membership-checked hot/cached candidates, rechecks membership after asynchronous work and retains at most 12 clan turns with a 30-minute idle expiry. Restart loses that chat context.

This channel is **not strictly conversation-only**: it supports the narrow validated `request_player_join_party` action through `PlayerPartyTakeover`, including a deterministic join-request route without inference. The server decides whether an eligible existing autonomous party can be transferred; generated speech cannot announce success by itself.

Owned-only startup does not create autonomous parties or run the autonomous clan planner. Cold clan refresh/discipline machinery remains implemented but its background callers are bypassed. Do not promise automatic founding, punishment/expulsion or regularly refreshed clan projections under this startup mode. Personal hot memory hydration is a separate active path.

For model details, read the applicability notes in [interaction memory](../src/GameServer/Social/INTERACTION_MEMORY.md) and [clan reputation](../src/GameServer/Clan/CLAN_SOCIAL.md).

## Tracing and retained records

`Bot/AI/LangfuseTracing.js` requires developer diagnostics as well as tracing enablement and credentials. Payload capture is separately configurable and defaults to capture when tracing is enabled; enabling it can export dialogue/context.

Optional gateway metrics/raw-output diagnostics and observer social diagnostics have gates. `BotLLMTurnStore.js` and `BotToolAudit.js` database writes do **not** become disabled solely because optional developer diagnostics are off. Diagnostic gating is neither access control nor a global no-recording guarantee.

## Update together

Provider changes require checking gateway configuration, request schema, budgets, routing, fallback and launcher inference controls. Tool changes require checking ownership and native action guards as well as audit/turn storage. Memory changes require event producers, replay, transaction attribution, hydration and the source-adjacent docs. Live provider compatibility, delivery, restart durability and clan refresh remain separate checks; source research is not acceptance.
