---
name: l2kingdom-doc-maintainer
description: Maintain concise, source-grounded documentation for the L2Kingdom repository, derived from L2Solo / NodeL2. Use for repository orientation, documentation audits and impact checks, and changes to runtime entrypoints, gameplay and vassal ownership, packets, SQLite persistence, WorldObserver, AI integrations, authored data, configuration, verification workflows, skills, or agent instructions. Keep navigation maps and feature docs synchronized without importing upstream assumptions or expanding documentation unnecessarily.
---

# L2Kingdom documentation maintainer

Adapted from `qsd-doc-maintainer` for this private Node.js game server. Keep documentation useful for finding code, understanding responsibility boundaries, and deciding what must change together. Do not import QSD's container layout, Python tools, or audit requirements.

## Read first

1. Read root `AGENTS.md` and any applicable nearer instructions.
2. Read `README.md`, `package.json`, and the relevant source/configuration before changing an unfamiliar area.
3. Read the affected navigation map and feature doc if they exist. Do not assume a `docs/` tree or a documentation auditor exists.
4. Use [references/repository-guide.md](references/repository-guide.md) for initial reading anchors, then verify the affected behavior in current source.

Load other references only when needed:

- [references/semantic-retrieval-policy.md](references/semantic-retrieval-policy.md): cross-file discovery and evidence rules.
- [references/update-policy.md](references/update-policy.md): minimum documentation scope.
- [references/document-templates.md](references/document-templates.md): creating or reshaping navigation maps and feature docs.

## Workflow

### 1. Establish the actual repository boundary

- The project and checkout are named L2Kingdom; upstream material and package names retain L2Solo / NodeL2. Do not rename runtime identifiers merely to align prose.
- This is a Node.js server with integrated observer and SQLite persistence, not QSD's backend/automation/frontend container layout.
- Distinguish code that exists from behavior enabled by runtime configuration. Legacy bot or clan simulation modules and old planning notes are not evidence that those systems run today.
- Check authored resources, generated outputs, persisted state, and local configuration separately. Never expose credentials or copy local database contents into docs.
- Installing or updating this skill does not authorize writing a full documentation tree. Respect the requested phase of work.

### 2. Retrieve only the evidence needed

Use CodeGraph or an equivalent semantic/code graph for unfamiliar cross-file flows. Start with concrete paths/symbols and a small output bound; for `codegraph_explore`, usually `maxFiles: 1–3`.

- Fresh verbatim source is already read; do not fetch it again without a conflict or staleness signal.
- Relationships identify candidates, not complete impact or runtime reachability.
- Verify dynamic wiring, packet routing, database writes, configuration precedence, ownership boundaries, and negative/exhaustive claims through targeted source/configuration reads or `rg`.
- Use direct reads for known Markdown, INI, SQL, resource files, or exact text.
- Fall back immediately when the index is unavailable, stale, or ambiguous. Do not initialize or rebuild tooling as a documentation side task.

### 3. Classify impact and update the minimum set

Use the smallest applicable class from [references/update-policy.md](references/update-policy.md):

- `no-doc`
- `map-only`
- `feature-doc`
- `contract-flow`
- `ownership-boundary`
- `convention-or-agent-instructions`

Update existing docs in place where possible. Create a feature doc only for a durable flow, contract, or state model that is costly to rediscover. Keep README as an overview and starting point, not a duplicate of detailed docs.

When a maintained documentation tree is introduced, link its entry map from README and link each new feature doc from its owning map. Until then, use README and relevant source-adjacent docs as navigation; missing maps alone do not require creating a hierarchy.

### 4. Keep documents concise and factual

- Write documentation and code comments in English; communicate with the user in Russian.
- Use explicit repo-relative code paths in backticks and document-relative Markdown links for navigation.
- Prefer short bullets, one claim per bullet, and stable headings. Labels such as `owner:`, `entrypoint:`, `code:`, `contract:`, `doc:`, and `verification:` are useful when they improve scanning.
- Maps describe ownership, reading order, anchors, and update triggers. Feature docs describe one durable flow and its side effects.
- Explain producer → consumer direction, persistence ownership, and observer/client boundaries for cross-subsystem behavior.
- Separate verified behavior, historical material, recommendations, and open checks. Neither old docs nor graph summaries alone establish current facts.
- Cite existing test paths only when relevant and inspected; do not present their existence as passing verification or a requirement to add tests.
- Do not copy generated graph inventories, symbol dumps, provider memories, investigation transcripts, or secrets into maintained docs.
- Keep task plans in `tmp/plans/`, requested reports in dedicated subfolders of `tmp/reports/`, and other retained evidence under `tmp/`, not in documentation directories.

### 5. Verify proportionately

- Inspect changed claims against source/configuration, resolve affected Markdown links relative to their documents, and verify referenced repository paths.
- Check that navigation maps include added/moved docs and that removed paths have no stale links in the affected documentation.
- Use `git diff --check` and inspect the final diff. For new files, inspect their contents before staging as well.
- After JavaScript code changes, run `npm run check`; it verifies syntax only and does not start the application. Markdown-only changes do not require it.
- Do not add or modify automated tests/test infrastructure, run suites by default, or recreate a suite as diagnostics. Missing new tests are not a defect.
- Do not build, start, stop, or restart the server unless explicitly requested. Inspect maintenance script side effects before recommending or invoking them.
- There is no documentation auditor bundled with this skill. Do not run QSD audit commands or claim automated link/runtime verification without actually performing it.
- After a non-trivial code change that used semantic retrieval, make one bounded missed-impact query and verify newly surfaced critical candidates. Skip this for documentation-only changes.

### 6. Finish according to repository policy

- Check whether README, navigation maps, feature docs, this skill, or `AGENTS.md` need synchronized updates.
- Commit only task-owned, non-ignored repository changes with a Russian description and push, as required by `AGENTS.md`. Do not trigger runtime operations.
- Report concisely which docs/instructions changed (or why none were needed), whether runtime ownership/contracts changed, and what was actually checked. Mention significant gaps or publication failures.

## Local availability

The canonical source is `skills/l2kingdom-doc-maintainer/` in this repository. The tracked project-local symlink `.agents/skills/l2kingdom-doc-maintainer` points to `../../skills/l2kingdom-doc-maintainer`. Do not install it under `~/.agents/skills/`, maintain a second copied version, or replace an unrelated existing skill.

Pi discovers the project's `.agents/skills/` from this repository and its subdirectories, not from unrelated repositories. Run `/reload` in an existing Pi session after installation or updates; `/skill:l2kingdom-doc-maintainer` explicitly loads it. Agents without skill discovery should read the canonical `SKILL.md` directly when `AGENTS.md` requires it.
