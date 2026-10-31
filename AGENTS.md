# Working Principles

Work from evidence, keep designs direct, and make effort proportionate to the task.
Meet requirements with the least implementation, verification, and maintenance cost consistent with correctness and clarity.

- Inspect relevant code and contracts; treat proposed diagnoses as hypotheses. Ask about consequential choices that inspection cannot resolve; make minor, reversible choices yourself. If evidence contradicts the approach or progress stalls, seek new evidence, change approach, or report the blocker.
- Implement the requested outcome and necessary related changes. Preserve unrelated behavior and others' changes. Analysis requests do not authorize edits.
- Prefer the simplest adequate design. Reuse suitable code and dependencies. Add abstractions, dependencies, configuration, compatibility layers, or infrastructure only for concrete current needs. Similar-looking code alone does not justify an abstraction.
- High server performance with thousands of active bots is a project priority. Evaluate every proposed change for its performance impact at that scale, including CPU cost, memory use, event-loop blocking, and database/network load. Prefer more efficient solutions when correctness and clarity are comparable; avoid unnecessary per-bot work and repeated full-world scans.
- Fix causes at the narrowest coherent layer. Do not hide failures with silent catches, fabricated defaults, or misleading fallbacks. Recovery behavior must match the intended contract.
- Verify proportionately and report significant verification gaps.

# Project Context

This repository is a private personal project deployed on a local home server. The author has no plans to sell it or make it publicly available.

The repository is L2Kingdom, derived from L2Solo / NodeL2. The existing README and package metadata retain upstream names. The runtime is a Node.js Lineage II server emulator with an integrated web observer and SQLite persistence. `package.json` requires Node.js >=22.5.0.

# Project Workflow

Read `README.md`, `package.json`, and the relevant source and configuration before changing an unfamiliar area. Preserve the existing directory structure when adding files.

Key entry points and areas:

- `scripts/start.js` (`npm start`): persistent WorldObserver management parent and sole Settings/preset writer; launches the game only on an explicit Start action. `scripts/run-server.js` / `src/NodeL2.js`: wrapper/runtime entrypoints, not a second management frontend. Inspect without automatically starting the server.
- `src/AuthenticationServer/`: authentication server.
- `src/GameServer/`: game server and simulation.
- `src/Packet/`: packet handling.
- `src/WorldObserver/`: management/auth/Settings APIs and game observer backend. The management parent is API-only; `publicOrigin` enables its explicit same-host proxy boundary, not static delivery.
- `src/frontend/`: independent Nginx/Docker/Compose frontend (service `frontend`, container `l2kingdom_frontend`); `public/` contains browser sources, maps and shared atlas/icon catalogs. Backend file consumers remain coupled to shared resources; standalone/private-child static routing is retained. Build/container operations require explicit authorization; frontend-only replacements must not restart management/game.
- `src/Database.js` and adjacent database modules: persistence.
- `config/default.ini`, `config/local.example.ini`: configuration defaults and local override example. `config/local.ini` is Git-ignored.
- `data/`, `database/`: inspect the relevant files before changing authored resources or database assets.
- `scripts/`: maintenance, generation, and verification commands. Inspect side effects before invoking them.
- `planning/`: existing upstream planning material; confirm current behavior in source. Store new task plans in `tmp/plans/`.

At the end of a task, check whether `README.md`, these instructions, or other affected documentation needs updating. Do not introduce documentation infrastructure solely to mirror another repository.

## Documentation Maintenance

- Use the `l2kingdom-doc-maintainer` skill for repository orientation, documentation audits and impact checks, and changes to code layout, runtime entrypoints, documented gameplay, ownership boundaries, packets, persistence, WorldObserver, AI integrations, authored resources, configuration, verification workflows, skills, agent instructions, or documentation itself.
- The canonical skill is `skills/l2kingdom-doc-maintainer/SKILL.md`. If skill discovery is unavailable, read that file directly. Repository-only discovery uses `.agents/skills/l2kingdom-doc-maintainer` as a relative symlink to the canonical directory; do not install it under `~/.agents/skills/`.
- Start with `docs/README.md`, then read the affected feature docs before deep implementation. Use `README.md` for player-facing setup and relevant source-adjacent docs for detailed contracts; verify historical `planning/` material and legacy subsystem descriptions against current source and configuration.
- Keep documentation changes proportionate. Update affected maps, links, and feature docs in the same task when their claims change; installing the skill alone does not require creating a documentation tree.
- Validate changed claims, paths, and links and inspect `git diff --check`. There is no bundled documentation auditor; do not import QSD-specific commands or create test infrastructure merely to mirror its workflow.

## Incremental Upstream Integration

- Use `skills/l2kingdom-upstream-integrator/SKILL.md` for L2Solo and Mobius C4 updates, one active proposal per source. Separate source sessions may analyze and implement in parallel with source-owned progress, declared disjoint write scopes and compatible contracts; serialize overlapping work and shared Git publication operations using the skill's cooperative ownership protocol. Automatically skip confirmed test-only commits before detailed analysis or an approval request, recording each full SHA and classification evidence as `skipped` in source-owned progress; mixed or unclear commits are not eligible. For other candidates, analyze one exact upstream commit, explain its local effects in Russian, and wait for the user's approval before implementation. Approval does not extend to the other source, the next commit or unreviewed prerequisites.
- L2Solo is the Git upstream; Mobius C4 is a source for native behavior/content adaptations, not a rebase target. Preserve local ownership, runtime, persistence and performance contracts.
- Keep source-owned resumable decisions under ignored `tmp/upstream-integration/sources/<source>/state.md` and per-commit receipts; recover legacy combined state without overwriting an active session. Record source provenance in integration commits. Do not silently mark skipped/deferred commits as applied. See the skill for approval, recovery and publication boundaries.
- Repository-only skill discovery uses `.agents/skills/l2kingdom-upstream-integrator` as a relative symlink to the canonical repository directory; do not install it under `~/.agents/skills/`. Installing the skill does not authorize any upstream integration.

## Code Intelligence Retrieval

Use CodeGraph or an equivalent semantic/code graph for bounded cross-file discovery.

- Treat fresh returned source as already read; do not repeat the same read without a conflict or staleness signal.
- Treat graph relationships as candidates, not proof of completeness.
- Verify negative, exhaustive, dynamic, and high-risk conclusions against source, runtime configuration, or targeted `rg` searches.
- Fall back to `rg` and direct reads when the index is unavailable, stale, ambiguous, or conflicting.
- For documentation impact decisions, follow `skills/l2kingdom-doc-maintainer/references/semantic-retrieval-policy.md`.

## Verification and Tests

- GitHub Actions are disabled for this workspace. Do not rely on CI or add workflows unless explicitly requested.
- Do not write, extend, or modify automated tests or test infrastructure unless explicitly requested by the user. This includes temporary test scripts and tests delegated to other agents. Do not routinely ask for exceptions.
- Use `npm run check` for JavaScript syntax verification after code changes. It checks syntax without starting the application; it does not verify runtime behavior.
- Do not run automated test suites by default. Use the least costly adequate existing checks or explicitly authorized direct application checks. Do not recreate a test suite under the label of diagnostics or smoke checks, or build new verification infrastructure.
- Judge observed behavior against the user's requirements, not merely successful execution or the implementation's own success messages. Report what was actually checked, the result, and any significant gaps.
- The absence of new tests is not a defect and must not trigger review requests for test coverage.

## Runtime Operations

Do not automatically build, start, stop, or restart the server. Changes and Git operations must not trigger a rebuild or restart. Perform runtime operations only when explicitly requested by the user.

## Backups and Task Artifacts

- Store persistent backups only in `/data/!backups/L2Kingdom/`.
- Store task artifacts worth retaining in the repository's Git-ignored `tmp/` directory: plans in `tmp/plans/`, reports in `tmp/reports/`, and investigation results or verification evidence in appropriate subfolders.
- If the user explicitly requests a report, create it in a dedicated subfolder under `tmp/reports/`. Do not store investigation reports in documentation directories.
- Bot MCP is still under testing. After every usage session (including read-only use and failed attempts), save a diagnostic report with all encountered problems and no repair recommendations under `tmp/reports/bot-mcp/<unique-session-id>/diagnostic.md`; follow `docs/bot-mcp.md#testing-status-and-mandatory-diagnostic-report`.
- Store disposable files, temporary task artifacts, and short-lived backups only in `/tmp/L2Kingdom/`.

## Git

- After making repository changes, create a commit with a description in Russian and push it.
- Commit only changes belonging to the task; preserve unrelated user changes.
- Never commit files covered by `.gitignore`.
- If committing or pushing fails, report the blocker. Do not claim publication succeeded.
- Do not rebuild or restart the project after committing or pushing.

## Language

Write code comments and documentation in English. Communicate with the user in Russian, including the final answer.

## Comments and Local Constraints

- Before changing code, read the nearby comments and documentation relevant to it.
- Add comments only for non-obvious correctness constraints, critical ordering, side effects, or external contracts that cannot reliably be inferred from the local code.
- Explain why a constraint exists, what must remain true, and what is dangerous to simplify. Do not restate obvious implementation mechanics.
- Use a function or module comment for a constraint applying to the whole unit, and a local comment for a specific section. Keep each block concise, usually 2–5 lines, and focused on one related reason.
- Comments do not replace implementation or contracts. Update or remove stale or contradictory comments in the same change; remove blocks that no longer add useful information.
