# WorldObserver backend and L2Kingdom frontend

Read this before changing browser settings, lifecycle/data controls, map revisions or HTTP routing. This local-project observer is **not universally read-only**; browser users authenticate with personal keys and all have full admin access, not game-character ownership. See [runtime/configuration](runtime.md), [operations](operations.md) and the [project map](README.md).

## Owners and public origin

- `scripts/start.js` owns the persistent management **API** listener at `[WorldObserver] hostname/port` (default `127.0.0.1:8088`), not browser pages/static assets. It does not start gameplay automatically. `[WorldObserver] publicOrigin` selects the separate HTTP frontend origin and enables the parent-only proxy boundary; empty disables proxy trust and browser auto-open.
- `ManagementController.js` owns the wrapper/game generation, logs, exclusive lifecycle/data operations and explicit inference test. `ManagementRoutes.js` owns the final `/observer/api/server/*` namespace, access checks and bounded known-route forwarding.
- `ManagementStatic.js` retains static helpers used by standalone authentication; the management parent no longer calls its static router. Parent requests for pages, login HTML and frontend assets return 404, with no fallback frontend. There is no inline launcher frontend or old `/api/*` compatibility namespace.
- `SettingsService.js`, `SettingsRoutes.js`, `SettingsDescriptors.js` own the curated API and sole local INI writer; `ManagementPresetStore.js` owns the separate JSON preset selection. `SettingsRuntime.js` is a narrow IPC read/live-apply adapter, not an HTTP route or second disk writer.
- `src/NodeL2.js` initializes the private game observer after bots; `WorldObserverServer.js` retains game projections/routing. In managed mode it binds `127.0.0.1:0` and reports the actual port by generation-bound IPC. Standalone runtime remains a game entrypoint, not an alternative persistent management UI.
- `WorldObserver.enabled=false` disables only the game observer API under `npm start`; persistent Settings/auth/management APIs remain. Game API/dynamic-resource requests return HTTP 503 while stopped/not ready/disabled, not a fabricated empty world.

### L2Kingdom frontend sources and deployment boundary

Browser HTML/CSS/JS, maps, atlas and icon catalogs live in `src/frontend/public/`. The visible frontend brand and tab titles are L2Kingdom; `l2kingdom-logo.png` retains the original artwork. HTTP paths, browser globals/preferences and shared resource contents are unchanged. Backend `WorldObserverServer.js` still imports `mapAtlas.js` metadata and reads item-icon catalogs from this tree; atlas/catalog/API changes require coordinated releases. Item-icon validation/delivery remains backend-owned. Standalone/private-child static routing and cache validators are retained, with filesystem paths retargeted to the moved tree; the child is never a frontend upstream.

`src/frontend/` now includes `Dockerfile`, its allowlist `Dockerfile.dockerignore`, `nginx.conf.template`, `compose.yaml` and `compose.dev.yaml`. Compose project `l2kingdom` has only service `frontend`, container `l2kingdom_frontend`, image `l2kingdom_frontend:local`. The digest-pinned official Nginx Alpine base provides template substitution; there is no Node runtime, backend dependency installation or application build step. The build context is only `src/frontend`; allowed inputs are the template, root browser assets and map tiles. Backend-owned `public/item-icons/` catalogs/files are excluded from the image and still delivered through management.

**Source readiness is not deployment:** adding these files neither builds an image nor switches existing services. A new parent is API-only; prepare and verify the frontend, actual LAN bindings and backend configuration during separately authorized cutover. The frontend never targets the IPC-selected child.

### Frontend configuration and independent operations

Use Docker Engine/Compose on the same Linux host as native management. Host networking has no `ports:` mapping. Supply all four required environment inputs; no LAN addresses/subnets are guessed or read from backend INI:

| Input | Required value / matching backend contract |
| --- | --- |
| `L2KINGDOM_FRONTEND_IP` | Exact server LAN IPv4 address, not a wildcard or loopback UI alias. |
| `L2KINGDOM_FRONTEND_PORT` | Browser HTTP port; `publicOrigin` must equal this listener's HTTP origin. |
| `L2KINGDOM_ALLOWED_SUBNET` | Actual trusted client CIDR, including the server's LAN address if it accesses its own frontend. Applies to login assets and redirects too. |
| `L2KINGDOM_BACKEND_PORT` | Existing `[WorldObserver] port`; upstream and its source address are fixed to `127.0.0.1`. |

Backend configuration remains separately owned: `[WorldObserver] hostname=127.0.0.1`, matching `port`, and `publicOrigin=http://<LAN-IP>:<frontend-port>`. Prefer retaining the backend port with distinct exact listener addresses; inspect conflicts/firewall first. Keep browser origin and backend port stable on later frontend updates to retain cookie identity and browser preferences. Nginx never writes INI or copies backend configuration/secrets into its image.

From the repository root, with those inputs exported (or an explicitly selected local `--env-file`):

```sh
# Configuration rendering only; no image build or container/server operation.
docker compose -f src/frontend/compose.yaml config --quiet
docker compose -f src/frontend/compose.yaml -f src/frontend/compose.dev.yaml config --quiet

# Only with separate build/container authorization; affects frontend only.
docker compose -f src/frontend/compose.yaml build frontend
docker compose -f src/frontend/compose.yaml up -d --no-deps --no-build --pull never --force-recreate frontend

# Development alternative, using the same previously built image.
docker compose -f src/frontend/compose.yaml -f src/frontend/compose.dev.yaml up -d --no-deps --no-build --pull never --force-recreate frontend
```

Production reads assets from the image. Development overlays only `src/frontend/public/` read-only; edit browser files and manually reload, with no watcher/HMR/bundler or backend restart. Template/Dockerfile changes still require an authorized frontend image rebuild/recreate. Do not use broad Compose shutdown or restart management/game for a frontend-only replacement. Initial builds, `nginx -t`/module availability, actual listeners, session continuity and unchanged game/management PID or generation still need separately authorized operational acceptance.

### Frontend routes and response handling

- Nginx uses the bounded document grammar from `ManagementStatic.js`: Settings → `settings.html`, market → `market.html`, database/item/NPC routes → `knowledge-base.html`, existing world/actor/clan/dungeon/ranking/raid routes → `index.html`. Trailing-slash forms remain. Unknown paths/assets fail, never a catch-all SPA response. Root paths redirect to `/observer/`.
- `/observer/login[/]` and exactly `auth.js`, `login.css`, `appearance.js`, `l2kingdom-logo.png` are public within the allowed subnet. Protected documents/assets/maps use uncached `auth_request` to management's session endpoint with GET, cookies and no body/Content-Length. A 401 redirects documents to login, but returns JSON 401 for assets. Auth backend failure is an error, never a login redirect or successful page.
- Document redirects carry the original path/query in the login URL fragment, avoiding unescaped query interpolation. `auth.js` accepts that fragment and legacy `?next=` links, validates a local `/observer/` destination and excludes login destinations. The login page probes the session and redirects already signed-in users; 401 leaves the form available, other failures show an inline availability error.
- `/observer/api/*` and `/observer/item-icons/*` proxy directly to management without a second static-session check. Backend auth, icon validation and existing method semantics remain authoritative; no static icon fallback. The bot-control prefix is rejected by Nginx; local MCP stays direct.
- Proxying preserves original Host including port, Origin, cookies, methods/bodies, queries, validators, content encoding and upstream statuses/bodies. It overwrites `X-Real-IP`, clears client forwarding-chain/protocol headers and disables caching, request/response buffering and retries. Nginx-generated API failures are JSON/non-success; backend errors are not intercepted. A timeout/disconnect is not proof that a mutation failed.
- Frontend responses set `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff` themselves, including errors. Static HEAD/conditional handling comes from Nginx, not an auth-subrequest header copy. Unhashed assets have no long-lived cache policy.

### LAN and peer-sensitive boundary

Direct requests retain socket-peer loopback/private-LAN checks (including private IPv4, link-local/ULA IPv6 and CGNAT private-overlay addresses), backend Host/listener-port checks and same browser Origin for mutations. Standalone observers always use this direct contract, even when the INI contains `publicOrigin`.

The parent validates `publicOrigin` at startup as one absolute HTTP origin without credentials, non-root path, query or fragment; an optional root slash is normalized for comparisons/links. Setting it requires `hostname=127.0.0.1`. Only a request carrying one valid `X-Real-IP` from socket peer `127.0.0.1` (or its IPv4-mapped representation) selects proxy authority. Invalid/chain values or a header from another peer are rejected in proxy mode. The resolved client must still be private/loopback, and Host must match `publicOrigin`; unsafe methods check the **preserved browser Origin**, not a rewritten backend Origin. Without `X-Real-IP`, direct backend-binding checks still apply, preserving local MCP. With proxy mode disabled, forwarding headers grant no authority. `Forwarded`, `X-Forwarded-For` and forwarded protocol are never identity/scheme authority.

The Nginx template overwrites `X-Real-IP` from its connection peer, preserves Host/Origin, and uses a socket-peer `geo` gate for the selected LAN subnet even on public login assets and rewrite-phase redirects. Backend private-peer checks do not enforce that deployment-specific subnet. There is no permissive CORS, password login, role editor or per-device allowlist. Host/Origin do not identify users; personal-key sessions remain a separate boundary. Plain HTTP is only for the trusted home LAN, not Internet exposure; verify actual listener/firewall/subnet configuration separately.

Clan-order/crest APIs validate their domain inputs but do not establish the browser as the clan's authenticated game-session leader. Diagnostics switches are not authorization. Raid teleport requires the **resolved client** to be loopback, checked **before** the parent forwards it to the child; a proxied LAN client cannot inherit the proxy's loopback privilege. The socket is not overwritten. Bot-control retains its independent socket/Host/token checks, and the parent additionally rejects proxied bot-control requests. No client forwarding headers are passed to the child as authority.

The proxy accepts only enumerated game API/icon families and the current IPC-reported endpoint, never browser-selected URLs, scans or arbitrary paths. It preserves ETag/304, 204, revision/epoch, content encoding, streaming and upstream status/errors while removing hop-by-hop/CORS/cookie headers. Generation changes invalidate endpoints and old settings/readiness replies. A 15-second upstream deadline bounds waiting; no automatic mutation retry follows disconnect.

## Personal keys and browser sessions

- `ObserverAuth.js` gates parent APIs and backend-owned item icons before Settings, lifecycle actions or game proxying; missing sessions return JSON 401. The parent uses `servePages: false`, including for login HTML. Standalone authentication retains its existing page/asset gate, login redirects and exact public login exceptions. The centered, compact form shows **Welcome to L2Kingdom** and a single key field with **Enter your key..**; submit with Enter or the inline arrow button. There is no user name, browser key generation or user administration. Failed attempts and session-availability failures appear inline; an unauthenticated session probe leaves the form blank.
- Restarting gameplay via Settings does not reload the parent's HTTP routes. An older management process needs a separately authorized management restart to activate new API behavior; a frontend update alone cannot do so. The login document belongs to the separate frontend, not the new parent's route table. Missing auth API endpoints (404) produce an explicit management-restart message rather than an invalid-key error.
- Run `npm run observer:key -- "User name"` to generate a cryptographically random 256-bit key. The name is required, unique, trimmed and limited to 80 characters; every key grants full `admin` access. The CLI prints the key once; the server stores only its SHA-256 hash. Losing a key requires issuing another key under a different name; there is no recovery of the original value. The CLI neither starts nor reloads the server; an existing management process sees newly issued keys immediately.
- `ObserverAuthStore.js` owns separate SQLite tables in `tmp/observer-auth/auth.sqlite`, or `observer-auth/auth.sqlite` under `L2NODE_RUNTIME_DIR`. Use the same runtime directory/environment for key generation and management. Keys/sessions are independent of world/history saves, wipes and restores; protect the auth directory separately and do not commit it. New auth directories/files use owner-only permissions.
- Sessions use independent random tokens, stored only as hashes in SQLite. Cookies are `HttpOnly`, `SameSite=Strict`, scoped to `/observer/`, named per listener port, and expire after a fixed 30 days without sliding renewal. Sessions survive browser and management restarts. At most ten sessions per key are retained; a later login can evict the oldest. The navigation footer shows the user name/admin role and **Sign out**, which deletes the server session and clears its cookie. API 401 responses send an open application back to sign-in.
- Login accepts only `POST { key }`; `GET /observer/api/auth/session` returns `{ user: { name, role: "admin" } }`; `POST /observer/api/auth/logout` revokes the current session. JSON limits and same-origin mutation checks apply. Login attempts are limited to ten per resolved client IP per minute (socket peer for direct/standalone requests), with bounded in-memory bookkeeping. Ordinary authenticated reads perform an indexed session lookup, not a database write or world/bot scan.
- The HTTP listener does not provide TLS. `Secure` is set only on an actually encrypted socket; forwarded scheme headers are not trusted. The sole forwarded identity input is the parent-only validated `X-Real-IP` contract above. Plain LAN HTTP does not protect a key or session from network interception. Authentication is not authorization for Internet exposure or arbitrary proxy/TLS-offload topologies.
- Managed game observers remain private loopback endpoints; direct browser requests are rejected, and the parent checks the session before forwarding known routes. `/observer/api/bot-control/*` remains a separate loopback-only, browser-denied MCP token boundary, not an admin-key/session exception usable by a browser. A browser admin session does not grant MCP authority.

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

Server configuration cards include live `AuthServer.autoCreate`, restart auth/game ports and advertised IPv4, read-only bind addresses, restart diagnostics/master dependency and read-only management binding/frontend `publicOrigin`. These service-owned fields show saved versus active startup values; edits/restarts are external, not live game apply. Pending entries link back to the affected tab. Management-service restart temporarily removes API access; game restart disconnects clients but not management.

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

1. `refreshDynamicProjection` owns the single readiness check per bootstrap/changes request. `ensureWorldProjection` coalesces first initialization and resets from lean live-bot input plus up to 2,000 recent lifecycle-cache entries; once initialized, readiness returns without materializing a snapshot. Failed collection remains retryable, and the cold-change subscription is retained.
2. Initialization and dynamic refresh use `BotManager.getAllBotMapStatuses`, without publishing lean input to the full `session.botStatus` cache. Both use collection-local first-session-by-numeric-ID joins; aggregate live PK membership and last-applied duplicate row winners remain separate rules. Refresh retains cached non-hot PK supplements (including outside the recent-state seed), prior/current persisted PK membership, cold fallbacks and removals. No permanent session index or new cache is introduced. `WorldObserverProjection.js` still owns kind/id keys and bounded revision history.
3. First bootstrap keeps initial reset followed by a fresh dynamic pass. Read-time expiry/restore can change later sampled fields, and reset/apply have different duplicate-winner rules; do not collapse the passes without preserving these effects and PK supplementation. Bootstrap then reads the snapshot needed for its unchanged row schema, process epoch and revision. `src/frontend/public/worldState.js` decodes the supplied contract.
4. Changes coalesce removals/upserts; expired/invalid cursors reset. Unchanged replies are HTTP 204 with epoch/revision headers. New process epochs invalidate old state.
5. `src/frontend/public/app.js` polls approximately every two seconds while visible/live, plus slower status polling. Settings is a separate entrypoint, excluded from this router interception and loop.
6. HTTP 503 and refresh failures mark the world unavailable and link Server management in the map and visible Overview/Characters/Parties/dungeon workspace, rather than reporting zero population or endless loading. A retained last observation is explicitly stale across exploration routes; successful bootstrap replaces it and clears the unavailable state before normal rendering resumes.

Full snapshot, clan/native panels and actor/bot detail paths retain the full status reader. Lean map reads still perform necessary native expiry/policy/party work, including internal scans; see the [status read contract](bot-runtime.md#full-and-map-status-reads). Unchanged changes requests do not create discarded readiness actor arrays, but still refresh current dynamic state.

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
