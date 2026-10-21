# Plan format

Write plan.md for the user first, then for the workers. Start with the `stages ...` line, then an overview the user reads at approval:

```
## Overview
goal: {one sentence: what the user gets when the run is done}
approach: {one or two sentences: how the tasks get there}
key: risk: {what could go wrong or break}
key: decision: {a choice you made that the user may want to change}
key: assumption: {something you assumed instead of asking}
```

Use up to 5 `key:` lines and only the ones that matter; plain `key: {text}` is a note.

Then one block per task. Each starts with a heading line, `## T1: {title}` for implementer tasks (T1, T2, ...) or `## D1: {title}` for docs tasks (D1, D2, ...), followed by these lines in this order:

- `worker: implementer` (or `worker: docs`)
- `owns: {repo-relative paths, comma-separated}`
- `why: {one line: why this task is needed}`
- `do: {clear instructions}` (may continue on the following lines)

Write titles and `why:` lines in plain words the user understands without reading code. Give each file to one task where possible and group tightly coupled edits in one task, because tasks owning disjoint files run in parallel. Include implementer tasks only when the implement stage is selected and docs tasks only when the docs stage is selected (`README.md` when unsure).

Then run `node {{NEAT_BIN}} plan check {id}`. On exit 1, fix the plan from the error lines and write it again, at most twice; then Stop. On success keep the line `plan ok tasks={n} stages=... implement=[...] docs=[...]`: each bracket is a batch.
