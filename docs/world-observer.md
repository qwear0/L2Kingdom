# WorldObserver management, API, projections and UI

Read this before changing browser settings, lifecycle/data controls, map revisions or HTTP routing. This local-project observer is **not universally read-only or an authenticated browser-user boundary**. See [runtime/configuration](runtime.md), [operations](operations.md) and the [project map](README.md).

## Owners and public origin

- `scripts/start.js` owns the persistent public HTTP listener at `[WorldObserver] hostname/port` (default `127.0.0.1:8088`). It does not start gameplay automatically.
- `ManagementController.js` owns the wrapper/game generation, logs, exclusive lifecycle/data operations and explicit inference test. `ManagementRoutes.js` owns the final `/observer/api/server/*` namespace, access checks and bounded known-route forwarding.
- `ManagementStatic.js` serves frontend assets/deep links without game imports or opening a world database. There is no inline launcher frontend or old `/api/*` compatibility namespace.
- `SettingsService.js`, `SettingsRoutes.js`, `SettingsDescriptors.js` own the curated API and sole local INI writer; `ManagementPresetStore.js` owns the separate JSON preset selection. `SettingsRuntime.js` is a narrow IPC read/live-apply adapter, not an HTTP route or second disk writer.
- `src/NodeL2.js` initializes the private game observer after bots; `WorldObserverServer.js` retains game projections/routing. In managed mode it binds `127.0.0.1:0` and reports the actual port by generation-bound IPC. Standalone runtime remains a game entrypoint, not an alternative persistent management UI.
- `WorldObserver.enabled=false` disables only the game observer API under `npm start`; persistent Settings/management/static delivery remain. Game API/dynamic-resource requests return HTTP 503 while stopped/not ready/disabled, not a fabricated empty world.

### LAN and peer-sensitive boundary

The public parent checks the socket peer for loopback/private LAN (including private IPv4, link-local/ULA IPv6 and CGNAT private-overlay addresses), expected Host/listener port, and same browser Origin for mutations; foreign browser origins/cross-site fetches are rejected. Trusted non-browser consumers may send the valid Host and bounded JSON without browser-only headers. There is no permissive CORS or new login, password, role system or per-device allowlist. Host/Origin protect browser requests; **they do not authenticate LAN users**. Keep the service on the intended trusted network and verify real deployment binding/firewall separately.

Clan-order/crest APIs validate their domain inputs but do not establish the browser as the clan's authenticated game-session leader. Diagnostics switches are not authorization. Raid teleport has a stricter **socket loopback** rule, rechecked at the public boundary **before** the parent forwards it over loopback; LAN callers cannot inherit the proxy's loopback privilege. Client forwarding headers are not trusted or passed as authority.

The proxy accepts only enumerated game API/icon families and the current IPC-reported endpoint, never browser-selected URLs, scans or arbitrary paths. It preserves ETag/304, 204, revision/epoch, content encoding, streaming and upstream status/errors while removing hop-by-hop/CORS/cookie headers. Generation changes invalidate endpoints and old settings/readiness replies. A 15-second upstream deadline bounds waiting; no automatic mutation retry follows disconnect.

## Settings frontend and API

Shared navigation adds Settings below exploration and above Appearance. `settings.html`, `settings.js`, `settings.css` reuse appearance/shell/router tokens without loading `app.js` or starting a world-map polling loop.

- `/observer/settings` defaults to World; `/observer/settings/world`, `/bots`, `/server` support reload/history. Unknown tabs are not found.
- Compact cards show effect, input, apply-mode badge, actual active/saved values and secondary technical key/default/source details. Locked environment/forced/read-only controls include reasons.
- Per-tab Save/Discard, dirty counts, validation and in-flight state are explicit. Only changed fields are validated/submitted; unchanged inherited/legacy numeric values outside the editor bounds remain untouched and do not block unrelated saves. Drafts survive tab changes; leaving with unsaved edits warns. Discard abandons only drafts, not saved pending values. There is no autosave/bulk reset.
- Stale revisions retain drafts. Ambiguous failures re-fetch authoritative state before permitting another explicit retry; failed re-fetch keeps Save blocked until Refresh. Saved-but-unapplied live fields prescribe Stop → Start, not a zero-dirty Save/Apply button.
- Management actions and the dedicated preset form never commit unrelated configuration drafts. Only the Server tab polls management status; World/Bot Settings do not poll world state. Authoritative Refresh and phase/generation transitions reconcile pending values.
- Progression shows active vs next-start presets, actual running rates and draft previews. Changing x1/x10/x50 belongs only to the Server form. Base SP/spoil/quest overrides resolve layer inheritance before sibling fallback.

| Endpoint | Contract |
| --- | --- |
| `GET /observer/api/settings` | Opaque revision; curated descriptors/values, defaults/inheritance/source/editability, running/saved/pending state, sanitized provider credential-presence status and progression summary. Never all options/environment. |
| `PATCH /observer/api/settings` | `{ revision, tab, changes: { settingId: value } }`; complete patch validation before persistence. Unknown/cross-tab/forced fields, invalid types/ranges and unsupported null removal are rejected. |

Bodies must be JSON objects and at most 16 KiB; unsupported methods are 405. Invalid values are 400, denied ownership 403, stale/conflict 409, storage/runtime errors are safe and do not echo private file contents. Successful responses include authoritative state plus saved/applied/pending IDs. Persist first, apply only explicitly saved live keys, then re-read the runtime. Failed IPC cannot roll back a successful file save; see [runtime recovery and numeric limitations](runtime.md).

World controls cover progression/quest modifiers, the nine enchant chance cells, safe/max limits, PK continuation, account warehouse slots, beginner policy and restart-only monster titles; protocol/level cap are read-only. Bot controls expose enforced owned-only mode, restart PvP/knowledge behavior and optional live AI enabled/model/router/concurrency. No inactive ambient/cold/clan/static-shot controls, provider key/URL editing or expert inference tuning are exposed.

## Runtime performance diagnostics

With `developerDiagnostics` enabled, `worldStatus.runtime.developerDiagnostics` includes `hotDispatch` and `eventLoop`; diagnostics-off keeps `runtime` null. The owned-only initialization starts the existing monitor without starting legacy population jobs. Existing town/path-worker statistics remain under `runtime.townNavigation`.

- Dispatcher percentiles cover the latest up to 1,024 **started tasks**, not a timed window. Sample counts and cumulative `started`/`completed`/`errors` accompany process PID/start time; collect deltas only within the same process. `oldestUrgentMs`/`oldestNormalMs` measure current pending work (null for an empty lane), including work not represented in started-task samples.
- The event-loop sampler publishes the latest completed approximately 30-second histogram window with actual start/end timestamps, sample count and p95/p99/max milliseconds. Only the existing sampler rotates it; status reads and the legacy population summary read the same cached aggregate. Before completion, or without samples, availability is false and percentiles are null, not healthy zeroes. Monitor restart clears the previous window.
- These diagnostics are bounded, read-only observations, not evidence of throughput or a supported bot count. The historical `tests/test_population_event_loop.js` still asserts the superseded read-reset contract; it is not a check for these cached windows.

## Complete Server management mapping

All routes below share the public access policy; full logs and saved-game reads are not exceptions. No lifecycle action implicitly saves a configuration/preset draft.

| `/observer/api/server/…` | UI/ownership |
| --- | --- |
| `GET status` | stopped/starting/running/stopping/error, readiness, observer status, wrapper PID, uptime, last exit, distinct cleanup/tree-confirmation state, current/last operation outcome and safe version/config-layer labels. |
| `POST start`, `POST stop` | Single child generation; no duplicate Start, Restart or force-stop button. Start validates authoritative preset/rates; Stop leaves this same UI alive. |
| `POST progression` | Dedicated `{ revision, progressionRate }` atomic preset mutation; environment-owned selection locked; active vs saved next-start displayed separately. |
| `GET logs` | Full latest log or previous fallback, available when stopped. Status carries a bounded recent tail; render as text, autoscroll only at bottom. |
| `POST inference-test` | One explicit bounded synthetic request; disabled/unconfigured/untested/testing/online/error, provider/model, endpoint **origin only** (paths may contain tokens), latency/time. No automatic inference on load/Save. |
| `GET saves`, `POST saves/create` | List name/time/size metadata; optional save name; stopped/exclusive worker and DB lock contract. |
| `POST saves/load`, `POST saves/delete` | Existing save ID plus `confirmed:true`; UI confirmation. Load replaces world/history without automatic backup and leaves the game stopped; Delete is permanent. |
| `POST wipe` | Exact scope and typed WIPE BOTS / WIPE PLAYERS / WIPE ALL. Includes owned vassals; counts/results and possible post-world-commit history failure are explicit. |

Empty Start/Stop/inference bodies are `{}` with application/json. Action payload keys/types are strictly bounded; old routes/flags are not retained for callers/tests. An operation is reserved synchronously before awaits. Start/Stop/save/load/delete/wipe conflicts return busy; data mutations require confirmed stopped descendants and the existing cross-process DB locks. HTTP disconnect does not cancel work: consult current/last operation ID/outcome before any manual retry, particularly destructive actions.

Server configuration cards include live `AuthServer.autoCreate`, restart auth/game ports and advertised IPv4, read-only bind addresses, restart diagnostics/master dependency and read-only public management address. Pending entries link back to the affected tab. Management-service restart is external and temporarily removes the UI; game restart disconnects clients but not management.

## Game route families and mutations

`WorldObserverServer.route` and delegated handlers remain the game routing authority; the parent mirrors only known dynamic families.

| Family | Purpose / boundary |
| --- | --- |
| `/observer/api/world/bootstrap`, `/world/changes`, `/world/status` | Compact world, incremental revisions and status. |
| `/observer/api/snapshot` | Full snapshot, separate from incremental projection. |
| `/observer/api/characters/search` | Bounded persisted player identity search, not an account/inventory dump. |
| Actor/bot details, collections, relationships | Live-or-persisted profiles and paginated holdings/social details. |
| Clan list/detail/social/crest reads | Projections; social diagnostics have separate gates. |
| `/observer/api/market`, `/market/history` | Cached market projection/history. |
| `/observer/api/knowledge/*`, `/observer/item-icons/*` | Generated/native catalogues and known icon resources; not a generic upstream proxy. |
| `POST /observer/api/clan/:id/craft-preview` | Planning request, not order execution. |
| `POST …/clan/:id/orders`, `PATCH …/orders/:orderId`, transition POSTs | Validated create/edit/pause/resume/replan/cancel mutations. |
| `POST` / `DELETE …/clan/:id/crest` | Replace/delete crest. Existing empty-body DELETE remains valid through forwarding. |
| `POST /observer/api/control/teleport-player-to-raid` | Socket-loopback-only movement beside a live boss. |

Live bot detail includes `movement.farmRecovery` for autonomous gather-duty stall monitoring: state, elapsed work, attempt count, last escape method/source and duty status. It is read-only live-session diagnostics, available without developer movement tracing; see [vassal recovery](vassals.md#farming-stall-recovery).

Some game read handlers do not enforce GET-only; parent management methods are stricter. Do not infer a universal method contract from a read label.

## Incremental world flow and offline behavior

1. `ensureWorldProjection` collects live actors and bounded lifecycle-cache entries.
2. Dynamic refresh builds a local first-session-by-numeric-ID map once to join the existing available hot-status list. It does not keep a permanent BotManager index or change status/detail collection, PK/lifecycle fallbacks, actor order or removal detection. `WorldObserverProjection.js` keys by kind/id and retains bounded revision history.
3. Bootstrap supplies row schema, process epoch and revision. `public/worldState.js` decodes the supplied contract.
4. Changes coalesce removals/upserts; expired/invalid cursors reset. Unchanged replies are HTTP 204 with epoch/revision headers. New process epochs invalidate old state.
5. `public/app.js` polls approximately every two seconds while visible/live, plus slower status polling. Settings is a separate entrypoint, excluded from this router interception and loop.
6. HTTP 503 and refresh failures mark the world unavailable and link Server management in the map and visible Overview/Characters/Parties/dungeon workspace, rather than reporting zero population or endless loading. A retained last observation is explicitly stale across exploration routes; successful bootstrap replaces it and clears the unavailable state before normal rendering resumes.

This is HTTP polling, not pushed native packet state. Map publication is not native-client visibility or authority.

Independent vassal detail includes `movement.journey`, projected by `BotStatus` through the existing movement payload. The inspector/profile overview displays destination, state/wait/failure reason, route/leg, current gatekeeper/destination, hop position and confirmed paid versus outstanding planned fare. It does not infer arrival from a dispatch or require developer traces. Duty ownership and the separate farming watchdog remain in [vassal execution](vassals.md#farming-stall-recovery), not the browser.

## Other caches and data sources

- Full snapshot caching/build deduplication/ETags have separate TTLs, extended for protected player/party activity. `JsonResponseCache.js` supplies compressed market JSON/ETags; market has its own poll cadence. Relationships have separate bounded caches.
- Live world is not an enumeration of all saved characters; owned-only lifecycle filtering still applies. `CharacterSearch` can find saved non-bot identities; detail/collections prefer live state, otherwise persistence with source labels. Account warehouse views are not character-owned stock.
- History projections can be stale after a failed flush barrier. Synthetic compatibility status is not authoritative event history. `KnowledgeBaseService` uses generated/native catalogues; authored spawns do not prove current presence. Progression projections have explicit rate/level assumptions.
- Native client visibility belongs to `GameServer/World/ActorVisibility.js`, not HTTP rows. Observer reads can hydrate caches and are not necessarily zero-side-effect operations.

## Dedicated bot MCP boundary

The optional [bot MCP interface](bot-mcp.md) uses `BotControlRoutes.js` before the normal dynamic/static route families in both parent and private game observer. It is disabled by default and requires a dedicated environment secret plus loopback peer/Host and non-browser requests at both hops. It does not inherit the browser's trusted-LAN mutation policy, and its route family is deliberately absent from the generic known-game proxy allowlist. P1–P4 support existing-vassal discovery, read-only bounded local/detail views, shared events/waits/diagnostics and explicit native-action leases with retained results. P4 adds issued native menu/catalog tokens and typed service/economy/quest/social commands behind the same action route, not a generic bypass proxy. P3 response data is capped at 32 KiB; private dispatch awaits bounded waits, and browser permission does not authorize them. Manual authority is separate from observation and browser permissions; world editing and lifecycle operations remain excluded. The parent still owns endpoint discovery; no additional listener or automatic Start is introduced.

## Verification and update boundary

Syntax/source checks do not establish browser keyboard/narrow/theme behavior, live IPC/readiness, proxy streaming/revision handling, LAN teleport denial, persistence errors, queue-disable behavior or save/wipe outcomes. Those require separately authorized runtime checks (destructive checks on disposable/protected paired data and provider calls only with explicit permission). Deployment remains a separate service-owner/binding confirmation and stop-and-replace gate; commits are not deployment.

Update settings descriptors/source ownership, parent/runtime IPC, routes, browser consumers, navigation and [operations](operations.md) together. Projection changes require schema/epoch/revision/reset and browser changes together; mutations require domain validation, methods/body limits, exposure policy and UI confirmations together.
