# WorldObserver API, projections and UI

Read this before changing browser data, map revisions or HTTP controls. The observer is integrated into the game process and is **not universally read-only**. See the [project map](README.md), [runtime](runtime.md) and [persistence](persistence.md).

## Entrypoints and exposure boundary

- `src/NodeL2.js` initializes the observer after `BotManager.init`.
- `src/WorldObserver/WorldObserverServer.js` owns HTTP routing, projection assembly and the listener.
- Committed defaults enable it at `127.0.0.1:8088`; private effective deployment settings are not described here.
- `src/WorldObserver/public/` owns browser assets and API consumers. `spaRouter.js` parses deep links; world/profile/clan pages share the main application, while market and knowledge pages have separate entry assets.

The router does not provide a general authenticated player session for observer APIs. Clan-order/crest controls validate their domain inputs, but do not establish the requesting browser as the clan's game-session leader. Optional diagnostics switches are not authorization controls.

The raid teleport control has a separate **socket loopback** check. A loopback reverse proxy can satisfy that check on behalf of a remote requester; do not treat it as browser-user authentication. Keep this local tool's exposure boundary explicit when changing bind addresses or proxies. This document is not an assessment of an actual network deployment.

## Route families and mutation distinction

Paths below are representative contracts; `WorldObserverServer.route` and its delegated handlers are the routing authority.

| Family | Purpose / boundary |
| --- | --- |
| `/observer/api/world/bootstrap`, `/world/changes`, `/world/status` | Compact initial world, incremental revisions and status. |
| `/observer/api/snapshot` | Compatibility full snapshot, separate from incremental projection. |
| `/observer/api/characters/search` | Bounded persisted player-identity search, not an account/inventory dump. |
| Actor/bot detail, collection and relationship routes | Live-or-persisted profile sections, paginated holdings and separate social details. |
| Clan list/detail/social and crest reads | Clan projections; social diagnostics have their own gates. |
| `/observer/api/market`, `/market/history` | Cached market projection and historical price buckets. |
| `/observer/api/knowledge/*` | Generated/native catalogue views, not live entity presence. |
| `POST /observer/api/clan/:id/craft-preview` | Validated planning request, distinct from order execution. |
| `POST .../clan/:id/orders`, `PATCH .../orders/:orderId` and transition POSTs | Create/edit/pause/resume/replan/cancel player-managed clan orders. These are mutations, not passive observation. |
| `POST` / `DELETE /observer/api/clan/:id/crest` | Replace/delete a player-managed clan crest. |
| `POST /observer/api/control/teleport-player-to-raid` | Loopback-only movement of a named online player beside a live boss. |

Some read handlers do not enforce GET-only methods. Do not infer a complete method contract from the label “read”; inspect the specific handler before writing a client.

## Incremental world flow

1. `WorldObserverServer.ensureWorldProjection` collects live actors and bounded lifecycle-cache entries.
2. `WorldObserverProjection.js` keys actors by kind/id, compares serialized rows and retains a bounded revision history.
3. Bootstrap returns the row format/field description, process epoch and revision; consumers must use the supplied field contract rather than hard-coded object assumptions.
4. Changes coalesce additions/updates/removals after a revision. Invalid or expired cursors require a full reset.
5. Unchanged changes return HTTP 204 with epoch/revision headers. A process epoch change also invalidates old browser state.
6. `public/worldState.js` decodes/applies changes; `public/app.js` bootstraps and polls approximately every two seconds while visible/live, with a separate slower status poll.

This is HTTP polling, not a pushed C4 packet stream. Map publication is not a native-client visibility or permission decision.

## Other caches and consumers

- The compatibility snapshot has separate caching/build deduplication and ETag/304 handling. Its TTL increases under protected player/party activity; it is not the incremental map's freshness guarantee.
- `JsonResponseCache.js` supplies shared market JSON builds, compression and ETags; `public/market.js` has its own polling cadence.
- Relationship details use a separate bounded cache, not the map payload.
- Most other JSON is served without storage caching; static assets revalidate and versioned crests can be immutable. Inspect the route before changing client caching assumptions.
- `ActorEconomyProjection.js` supplies selected plan summaries rather than exposing arbitrary internal planner state.

## Live, persisted and generated data are different

- World collection uses live actors plus a bounded lifecycle cache; it is not an enumeration of every persisted character. Owned-only filtering still applies to bot lifecycle data.
- `CharacterSearch.js` can find saved non-bot players. Detail/collection paths prefer live state when present and otherwise load persisted data; `ActorCollections.js` identifies the source and paginates results.
- Human personal warehouse views are account-shared. A character profile does not mean that stock is character-owned.
- `Relationships.js` and market/history services have separate data freshness and failure paths. Reads can hydrate caches; “read API” is not a zero-side-effect execution guarantee.
- Compatibility synthetic status events are not authoritative event history.
- `KnowledgeBaseService.js` loads generated catalogue data and can use a native adapter. Known spawn definitions do not prove an NPC is currently alive; reward projections have explicit rate/level assumptions.
- Actual game-client publication belongs to `src/GameServer/World/ActorVisibility.js`, not observer collections.

## Update together

Projection changes require server row schema, epoch/revision/reset handling and `public/worldState.js`/`app.js` changes together. Detail/collection changes require the corresponding browser consumer and live/persisted source labels. Mutation changes require domain validation, HTTP method/body behavior, exposure policy and UI controls. Neither an HTTP payload nor a map marker proves gameplay acceptance; live API/client checks are separate work.
