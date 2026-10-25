# Semantic retrieval and documentation evidence

## Core rule

Fresh verbatim source returned by CodeGraph is direct evidence for those lines and is already read. Graph relationships, inferred owners, and impact radii are candidates, not proof of completeness or live runtime behavior.

## Choose the cheapest useful retrieval

- For an unfamiliar cross-file flow, read the relevant existing map, then explore concrete symbols or paths with a small file limit.
- For shared API changes, inspect candidate callers and impact before editing; verify the important consumers in source.
- For known Markdown, INI, SQL, HTML/resources, exact text, or unindexed paths, use targeted `rg` and direct reads.
- For a small known-file edit, skip graph discovery unless impact is uncertain.
- Expand a query only when a concrete missing hop matters. Do not replace a broad filesystem crawl with repeated broad graph queries.

## Verify decision-critical claims

Check the narrowest relevant source/configuration anchors for:

- authentication, authorization, and player/vassal ownership;
- packet registration, dispatch, serialization, and protocol expectations;
- SQLite writes, transactions, schema changes, restores, checkpoints, and worker handoffs;
- event/callback/timer wiring, simulation activation, and asynchronous work;
- startup and shutdown order, configuration precedence, and enforced policy overrides;
- observer routes, mutations, snapshots, and frontend consumers;
- external AI requests, failure behavior, and persistence side effects;
- claims such as “unused,” “disabled,” “no callers,” “all consumers,” or “complete impact.”

The presence of a module or INI option does not prove that a subsystem runs. The absence of an edge does not prove dead code. Test source may inform an expected contract; it does not prove tests passed or authorize executing suites.

## Freshness and fallback

Check index health when staleness or lock errors are reported. After moves or branch changes, verify freshness before relying on indexed source. Read pending or conflicting paths directly rather than rereading everything.

When the index is unavailable, stale, ambiguous, or inconsistent with current source, continue with targeted `rg` and direct reads. Do not install or rebuild a graph provider as part of routine documentation maintenance.

## Completion and documentation boundary

After a non-trivial code change that used semantic retrieval, make one bounded missed-impact query over the changed symbols/files. Inspect only newly surfaced candidates that could change correctness or documentation scope. Skip this for documentation-only changes or unavailable indexes.

Curated docs own stable responsibility boundaries, reading order, durable contracts, and update triggers. The index owns volatile symbol/caller discovery. Do not paste graph dumps or generated inventories into docs.
