# Integration records

Resolve these paths against the current L2Kingdom root. The skill's canonical directory owns instructions/templates only; do not put runtime progress inside it.

## Storage and authority

- Summary/queue: `tmp/upstream-integration/state.md`.
- One proposal/receipt: `tmp/upstream-integration/commits/<source>-<full-sha>.md`.
- Source keys: `l2solo`, `mobius-c4`.
- Optional retained source evidence: `tmp/upstream-integration/evidence/`; link exact artifacts from the receipt rather than duplicating them in the summary.
- Temporary clones and patch previews: `/tmp/L2Kingdom/`; not authoritative persistent evidence.

All progress is Git-ignored local task material. It survives ordinary session changes, but is not published by pushing the repository and will be lost if `tmp/` is deleted. Explain that limitation. Git trailers preserve integration provenance, not skipped decisions or historical consent. Do not force-add state, create a database/daemon, or invent approvals when recovering missing records.

Use one active proposal across both sources. Before writing, reread the affected record if another session may have changed it; preserve existing entries and stop on conflicting ownership. Keep each candidate keyed by its full source SHA even when a display uses an abbreviation.

## Summary template

Create only on first use; never reinitialize existing progress. Unknown fields stay explicitly unknown. A discovery window is not an integration baseline.

```markdown
# L2Kingdom upstream integration

Updated: <timestamp with timezone>
Active proposal: none | <source/full SHA, proposal revision, receipt path>
Last observed local HEAD: <full SHA>

## Sources

| Source | Repository / branch | Pinned discovery tip | Discovery range and coverage | Last refresh |
| --- | --- | --- | --- | --- |
| l2solo | https://github.com/pmbstyle/L2Solo.git / main | unknown | Not initialized; establish current merge base | not fetched |
| mobius-c4 | https://gitlab.com/MobiusDevelopment/L2J_Mobius.git / master | unknown | Not initialized; C4 path only; no universal import baseline | not fetched |

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

Review states: `unreviewed`, `awaiting-approval`, `approved`, `skipped`, `deferred`, `blocked`, `integrated`, `partially-integrated`. Use execution/publication fields separately: a committed but unpushed patch is not an unapplied patch. Only set an integration result after inspecting the actual local commit and checks; retain partial scope and unrun runtime acceptance. After an accepted skip/defer or a completed receipt, clear the active proposal. Keep a blocked/interrupted operation active until reconciled.

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

Approval refers to this one saved proposal, not an upstream branch, an entire discovery window or future commits.
