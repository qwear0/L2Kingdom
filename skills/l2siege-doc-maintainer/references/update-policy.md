# Minimum documentation update policy

Choose the smallest scope that leaves existing documentation correct. Do not create documents simply to fill a template.

| Class | Trigger | Minimum update |
| --- | --- | --- |
| `no-doc` | Local implementation fix with no changed documented behavior, paths, contracts, ownership, or workflow | No doc change; explain briefly if useful |
| `map-only` | File/doc moved or added; reading order or an entrypoint anchor changed without changing behavior | Affected navigation map and links |
| `feature-doc` | Documented gameplay, state transitions, persistence, UI behavior, or external integration changed within existing ownership | Relevant feature doc; map only if navigation changed |
| `contract-flow` | Packet, server/observer, worker, persistence, resource-loader, or external API handoff changed | Relevant contract/flow doc and affected navigation/overview claims |
| `ownership-boundary` | Responsibility moved, such as vassal command validation or durable state ownership | Affected owner statements, flow docs, and maps |
| `convention-or-agent-instructions` | Commands, verification limits, documentation lookup, skill installation, or agent rules changed | `AGENTS.md` and affected skill/workflow docs; map only if reading order changed |

Categories can overlap. Update every materially affected claim, not every file mentioning a broad subsystem.

## When a feature deserves its own document

Create one when a durable feature has a non-obvious multi-step flow, state machine, ownership contract, persistence model, or recurring rediscovery cost. Prefer extending an existing relevant doc when that remains concise.

Do not create a feature doc for a cosmetic edit, routine local bug fix, unchanged refactor, or temporary investigation. Keep plans and reports under `tmp/` according to `AGENTS.md`.

## Navigation and synchronization

- Prefer the existing layout and source-adjacent docs before inventing a new hierarchy.
- When creating a maintained documentation tree, provide one entry map linked from README. Add feature docs to the owning map and link them back to it.
- Update README when user-visible behavior, setup, commands, or its navigation changes; do not duplicate detailed feature flows there.
- Remove or correct stale incoming links when merging, moving, or deleting docs.
- Keep runtime truth distinct from upstream plans and inactive subsystem descriptions.
- Keep `AGENTS.md` as the authority for repository-wide execution policy. Skills explain specialized workflows without weakening or duplicating all root rules.
- Keep one canonical skill directory; local discovery links should reference it rather than fork copies.

## Verification boundary

Use source/configuration inspection, affected path/link checks, and diff review for documentation changes. Do not port QSD's Python scanner/auditor or introduce test infrastructure solely for parity. JavaScript changes require the existing `npm run check`; tests and runtime operations remain subject to root policy.
