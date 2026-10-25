# Documentation templates and compression rules

Use these shapes only when creating or reorganizing a document is part of the requested work. They are recommendations, not an auditor-enforced schema. Omit empty sections; never fabricate anchors to fill them.

## Navigation map

A map should answer where to start, what owns the behavior, what crosses the boundary, and which doc to update. Prefer roughly 60–160 lines; a smaller map is better when sufficient.

```md
# <Repository or subsystem> map

One or two sentences describing scope and when to read this map.

## 1. Scope and ownership
- owner: primary responsibility
- boundary: responsibilities owned elsewhere

## 2. Reading order
- Start with applicable agent instructions and the relevant configuration.
- Read the entrypoint, owner module, and feature document in that order.

## 3. Verified anchors
- entrypoint: `<verified repo-relative path>` — role
- code: `<verified repo-relative path>` — owner implementation
- contract: `<verified repo-relative path>` — producer → consumer
- verification: `<existing check or source anchor>` — what it does and does not establish

## 4. Runtime and data boundaries
- Distinguish authored inputs, generated outputs, and persisted state.
- Describe only verified activation/configuration constraints and side effects.

## 5. Documentation map
- doc: [Feature name](<document-relative path>) — purpose and reading trigger

## 6. Update triggers
- update-when: entrypoints, ownership, contracts, or navigation change
- skip-when: local implementation changes leave the map accurate
```

Use an area map only when its detail would otherwise overwhelm the entry map. Do not create one per source folder automatically. If a map owns a documentation folder, ensure its maintained feature docs are discoverable there; cross-link other areas only when relevant.

## Narrow feature document

Explain one durable flow rather than retelling a subsystem. Prefer roughly 40–140 lines, but correctness matters more than a line quota.

```md
# <Feature or flow>

One or two sentences describing scope and when to read this document.

## 1. Owner and entrypoints
- owner: subsystem responsible for state and validation
- entrypoint: `<verified repo-relative path>`
- doc: [Owning map](<document-relative path>)

## 2. Main flow
1. Input or trigger and its validation owner.
2. State transition and any persistence or asynchronous boundary.
3. Output, recipient, and externally visible side effects.

## 3. Contracts and configuration
- contract: producer → consumer, data/packet shape, and invariants
- configuration: defaults, override/activation rules, and relevant source anchors

## 4. Failure clues and verification
- failure-clue: verified error path or diagnostic source to inspect first
- verification: existing checks or source inspection and their limitations

## 5. Update triggers
- update-when: concrete behavior, contract, or ownership changes
```

## Writing discipline

- One verified claim per bullet; use English and explicit paths.
- Use Markdown links relative to the document; code anchors are repo-relative unless explicitly marked otherwise.
- Label proposed paths as proposals, not existing files. Replace template placeholders before publishing an actual map/doc.
- Link instead of duplicating. Keep workflow policy in `AGENTS.md`, navigation in maps, and durable behavior in feature docs.
- Do not require tests, metrics, logging fields, or failure guarantees that do not exist. Mention existing anchors only when inspected and relevant.
- Do not expand documentation with generated inventories, implementation history, model-version advice, or transient investigation evidence.
