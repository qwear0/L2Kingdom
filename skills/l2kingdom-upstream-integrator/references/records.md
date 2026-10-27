# Integration records

Resolve these paths against the current L2Kingdom root. The skill's canonical directory owns instructions/templates only; do not put runtime progress inside it.

## Storage and authority

- Source summary/queue: `tmp/upstream-integration/sources/<source>/state.md`.
- Legacy combined summary: `tmp/upstream-integration/state.md`; recovery input, not a new shared write target.
- Source ownership claims: `tmp/upstream-integration/locks/<source>.lock/`.
- Shared Git publication claim: `tmp/upstream-integration/locks/publication.lock/`.
- One proposal/receipt: `tmp/upstream-integration/commits/<source>-<full-sha>.md`.
- Source keys: `l2solo`, `mobius-c4`.
- Optional retained source evidence: `tmp/upstream-integration/evidence/`; link exact artifacts from the receipt rather than duplicating them in the summary.
- Temporary clones and patch previews: `/tmp/L2Kingdom/`; not authoritative persistent evidence.

All progress is Git-ignored local task material. It survives ordinary session changes, but is not published by pushing the repository and will be lost if `tmp/` is deleted. Explain that limitation. Git trailers preserve integration provenance, not skipped decisions or historical consent. Do not force-add state, create a database/daemon, or invent approvals when recovering missing records.

Use one active proposal and one owner **per source**. L2Solo and Mobius do not update each other's state, receipts or claims. Before writing, reread the affected record; preserve existing entries and stop on conflicting ownership. Keep each candidate keyed by its full source SHA even when a display uses an abbreviation. Evidence filenames must include the source/full SHA and an additional qualifier if multiple artifacts would otherwise collide.

### Cooperative ownership and publication

All participating sessions must agree on one absolute progress root (normally the primary L2Kingdom checkout's `tmp/upstream-integration/`). Separate checkouts' `tmp/` directories are not automatically shared. Record the progress root and Git common directory so separate sessions cannot accidentally use different lock domains for one repository.

- Before writing a source's progress, atomically create its claim directory with `mkdir` (not `mkdir -p` for the claim itself). Only the successful creator owns it. Inside, record a unique owner token, session reference if available, source, absolute checkout/progress paths, Git common directory and claim time. A directory without complete owner metadata is still occupied, not available for takeover.
- Keep the source claim through analysis, approval waits and implementation; publish the same owner token and exact write scope in its source state. Other sessions may read/analyze but cannot prepare a competing active proposal or edit that lane. A proposal may remain awaiting approval after a session explicitly yields ownership; releasing ownership never changes the user's decision or applies the patch. Record the next safe action before yielding; a new owner must revalidate the saved proposal.
- Publish exact write paths and assumption-critical dependencies before editing application/docs/resources, then reread other lanes' scopes. An unknown scope permits discovery/read-only analysis, not speculative concurrent edits. Overlapping files or incompatible contracts require coordination, even in separate checkouts. Update/recheck the declared scope before adding paths; approval still bounds actual implementation.
- Before Git mutations, atomically acquire `locks/publication.lock/` the same way and record owner token, checkout, expected HEAD, exact paths and intended operation. It serializes participating sessions' stage/commit/integration/push operations across the repository. Source files may still be edited concurrently only within previously declared disjoint scopes. Git's transient `index.lock` does not replace this multi-command claim.
- Inside the publication claim, recheck HEAD, index, approved scope and staged diff; never commit unrelated staged files, reset another session's index or publish an unexpected tip. Inspect the outgoing commit range before push: another source's unpublished commit requires its owner's explicit publication handoff, not incidental inclusion in this push. Record the resulting commit/push evidence before release. A failure is not permission to retry blindly; preserve partial-operation evidence. Do not hold this short-lived claim while waiting for approval or doing lengthy analysis.
- Release only a claim whose owner token still matches, after pending commands have settled: remove its own metadata and use `rmdir`, never recursive cleanup of another owner's directory. No timeout, PID check, missing metadata or old timestamp alone authorizes stealing a claim. After interruption, reconcile Git/receipt and verify the previous owner has stopped or explicitly handed off before recording an authorized recovery/release. Do not remove Git's own locks or override managed-worktree ownership.

These claims coordinate agents that follow the skill; they are not an executable gate or daemon. During rollout, a still-running legacy writer must explicitly adopt the protocol or finish/yield before concurrent implementation/publication in its checkout. Independent source discovery and analysis do not require stopping it.

### Legacy recovery without resetting progress

If this source has no dedicated state, inspect the old combined summary, its receipts and Git. Under this source's claim, initialize only its lane, preserving its exact inventory, decisions, pinned tip and pending approval/execution/publication. Adjust relative links for the deeper source-state path so they still resolve to existing receipts/evidence. Record the legacy path and observation time. Do not copy the other source's active proposal, rewrite the legacy file or move/delete existing receipts. Keep each source's original discovery bounds; splitting the file does not refresh upstream.

An active legacy owner must finish or explicitly hand off before that same source's state is migrated. The other source can start its independent lane without migrating or changing the active legacy lane; read the latter's receipt/scope for conflicts. Once a dedicated source state exists, it is authoritative for that lane; the combined file is historical for that source. If both records changed independently or ownership is uncertain, report the conflict rather than choosing the newest timestamp or inventing a decision.

## Summary template

Create only on first use; never reinitialize existing progress. Unknown fields stay explicitly unknown. A discovery window is not an integration baseline.

```markdown
# L2Kingdom upstream integration — <source>

Updated: <timestamp with timezone>
Source: <l2solo | mobius-c4>
Progress root / Git common directory: <absolute paths>
Owner token / session / claim: <identity and claim path | explicitly yielded>
Checkout / branch: <absolute checkout path and branch>
Active proposal: none | <source/full SHA, proposal revision, receipt path>
Declared write paths: <exact repo-relative files | none; analysis only>
Assumption-critical dependencies: <files/contracts requiring revalidation on change>
Last observed local HEAD: <full SHA>
Legacy recovery: <legacy path and observation time | not needed>

## Source discovery

| Source | Repository / branch | Pinned discovery tip | Discovery range and coverage | Last refresh |
| --- | --- | --- | --- | --- |
| <this source only> | <URL / branch> | unknown | <bounds and completeness; no invented import baseline> | not fetched |

## Candidates and decisions

| Source / full SHA | Review state | Local result | Publication | Receipt / reason |
| --- | --- | --- | --- | --- |

## Discovery notes

- Exact bounds, pagination completion and any missing source/diff evidence.
- Unexamined older history; prerequisite ordering; rewritten upstream history.
- No candidates discovered yet is not the same as no updates available.
```

Keep reviewed decisions when refreshing tips. List the actual candidate IDs for an enumerated window, or link a retained exact inventory if it is too large. Never collapse a partially processed set to one last-SHA cursor. Counts must identify their discovery window and distinguish full/partial integrations, approved skips, deferred/blocked items and unreviewed candidates.

## Per-commit proposal and receipt template

```markdown
# <source> — <full SHA> — <title>

## Identity
- Source URL / branch / pinned tip:
- Commit URL / SHA / parent(s) / date:
- Reviewed delta (parent/mainline for a merge):
- Discovery window and diff completeness:
- Local baseline HEAD / relevant working-tree state:
- Owner token / session / absolute checkout:
- Declared write paths / assumption-critical dependencies / other-source overlap check:
- Proposal revision: 1
- Review state: awaiting-approval

## Evidence and proposal
- Upstream purpose and complete in-scope change:
- Local behavior and source anchors:
- Expected behavior after integration; deliberately unchanged behavior:
- Compatibility: direct | adaptation | already-equivalent | not-applicable | blocked
- Prerequisites and whether already satisfied:
- Exact local files/owners and intended changes:
- Exclusions and full/partial coverage:
- Local ownership, lifecycle, data/protocol and performance consequences:
- Save-state/configuration/resource/license consequences, where applicable:
- Verification commands or source checks, pass conditions and known limits:
- Runtime activation/migration needs (not authorized by code approval):
- Recommendation and reason:

## User decision
- Decision: pending | integrate | skip | defer
- Exact user wording and timestamp/session reference when available:
- Bound proposal revision, source SHA, local baseline and scope:
- Revalidation after baseline drift, if any:

## Execution and receipt
- State: not-started | implementing | blocked | committed
- Actual changes and exclusions:
- Check results (command, outcome, what it proves):
- Remaining verification gaps:
- Local integration commit SHA: none | <full SHA>
- Publication: not-applicable | pending | succeeded | failed
- Push target and evidence / blocker:
- Runtime operations: none (unless separately authorized and recorded)
- Next safe action after interruption:
```

Review states: `unreviewed`, `awaiting-approval`, `approved`, `skipped`, `deferred`, `blocked`, `integrated`, `partially-integrated`. Use execution/publication fields separately: a committed but unpushed patch is not an unapplied patch. Only set an integration result after inspecting the actual local commit and checks; retain partial scope and unrun runtime acceptance. After an accepted skip/defer or a completed receipt, clear only this source's active proposal. Keep a blocked/interrupted operation active in its own lane until reconciled; it does not block unrelated work in the other lane.

Never infer user approval from a recommendation or from this template. Preserve earlier decision history when a deferred/partial item is revisited, increment the proposal revision, and request approval for additional scope.

## Russian decision card

Keep the chat explanation readable; expand only the sections material to the selected change.

> **Коммит:** source, short SHA, title/date/link.
>
> **Суть:** upstream problem or addition.
>
> **Сейчас у нас:** source-backed current behavior, including uncertainty.
>
> **После интеграции:** concrete expected effect; what stays unchanged.
>
> **Совместимость:** direct/adaptation/already equivalent/not applicable/blocked; prerequisites and exclusions.
>
> **Риски:** local features, saves/protocol and load at thousands of bots.
>
> **Проверка:** authorized checks and what remains unverified; no automatic restart.
>
> **Рекомендация:** integrate/skip/defer, with reason.
>
> **Решение:** «Интегрировать», «Пропустить» или «Отложить» этот коммит? Record: receipt path.

Approval refers to this session's one saved source/SHA/revision proposal, not the other lane's proposal, an upstream branch, an entire discovery window or future commits. Include the source and short SHA in the decision question when parallel proposals exist; ask for clarification if a reply cannot be bound unambiguously.
