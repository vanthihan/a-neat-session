# a neat session

## What This Is

A Claude Code plugin, installed through npm (global or per-project), that turns the main terminal session into a thin orchestrator. When the user says "do feature X", the main session spawns focused worker agents (code explorer, researcher, implementer, reviewer, tester, docs updater) and receives only short structured reports, so the main context window stays small and manual `/compact` is rarely needed. If the Codex CLI is installed, the orchestrator can also hand work to Codex workers and monitor them.

## Core Value

The main session's context stays small: every heavy task runs in a worker, and the main window only ever receives a capped (~300-word) structured report plus pointers to artifacts on disk.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] `/neat:do <task>` entry command with options `--mode gate|auto|step` (gate-after-plan, fully autonomous, step-by-step) and `--research`
- [ ] Pipeline stages: explore → research (optional, runs on request or when orchestrator proposes it in gate/step mode) → plan → implement → review → test → docs
- [ ] Orchestrator agent that the main session can run as (plugin `settings.agent`) or invoke via command; it delegates and never does heavy reading itself
- [ ] Six worker agents with model routing: explorer (Haiku), researcher, implementer, reviewer, tester, docs (Sonnet); read-only tools for read-only roles; `maxTurns` caps
- [ ] Report contract: every worker returns a fixed-shape report (status, `file:line` findings, decisions, open questions, artifact paths) under a word cap
- [ ] Disk-artifact handoff: bulky outputs written to `.neat/runs/<run-id>/` (brief, findings, plan, diff summary, review, test log); workers read briefs from disk, not from main context
- [ ] `SubagentStop` hook that rejects/truncates over-size or malformed worker reports
- [ ] `SessionStart` (matcher `compact`) hook that re-injects current run state after a compaction
- [ ] Context/usage awareness: read statusline capture when present; warn orchestrator and suggest `/clear` + resume at thresholds
- [ ] Run state + resume: `/neat:status`, `/neat:resume` so a fresh session (after `/clear`) can continue a run from disk
- [ ] Codex driver: detect `codex` on PATH; run workers via `codex exec -o <file>` in background (default) or in a visible tmux pane (`--tmux`); `/neat:status|result|cancel` for Codex jobs; wait by PID, read only capped summary
- [ ] npm installer `npx a-neat-session --global|--local`, plus `--uninstall`; user chooses scope
- [ ] Source hygiene test: shipped files contain no mention of other plugins/frameworks (denylist grep test)

### Out of Scope

- Codex CLI as the main/orchestrator window — v2; v1 is Claude Code-led
- Experimental agent teams — documented ~7x token cost, contradicts goal
- Multi-session managers (separate parallel terminals/worktrees per task) — different problem
- Web UI / dashboard — terminal-first tool
- Claiming quota savings by delegation alone — subagent tokens bill same limits; only context savings are core

## Context

- Pain: Claude Code and Codex sessions fill the context window fast; user compacts manually near the max. Primary pain confirmed as context/compaction, not quota.
- Honest framing: delegation isolates context but subagent tokens still count toward the same 5h/weekly limits. Quota improves only indirectly (smaller main context per turn, cheaper worker models, Codex offload on a separate quota).
- User environment: Claude Code 2.1.302, codex-cli 0.162.1, WSL2 Linux. Statusline capture at `~/.claude/state/statusline-input.json` already exposes context %, 5h %, 7d %. Codex config has `[agents] max_depth = 1`.
- Lessons from user's own projects (stpro_app, mcm): spawn fresh agents with short briefs pointing at files on disk; never resume a bloated agent (one grew 117k→505k tokens and died); wait on Codex jobs by PID (`kill -0`), read the `-o` output file; don't run doc-editing Codex jobs in parallel with gates; only the orchestrator commits; Haiku for mechanical work, Sonnet for workers, strongest model once for review.
- Design references studied during bootstrap (ideas only, never named in shipped source): disk-artifact handoff with fresh-context workers, tiered model routing, compressed worker output, background Codex job verbs (status/result/cancel), tmux-visible workers.
- Claude Code primitives to build on: plugin manifest + `agents/*.md` frontmatter (`model`, `tools`, `maxTurns`, `effort`, `background`), `skills/`, `commands/`, `hooks/hooks.json` (`SubagentStop`, `SessionStart` compact matcher, `PreToolUse`), plugin `settings.agent`.

## Constraints

- **Runtime**: Claude Code plugin only in v1; Codex used as worker when detected — user choice
- **Distribution**: npm package with installer choosing global/local scope — matches how user installs tooling
- **Source hygiene**: shipped package files (code, comments, agent prompts, docs) never mention or trace to other plugins/frameworks; `.planning/` may — explicit user requirement, enforced by test
- **Context budget**: agent descriptions must stay short (startup warns when all descriptions exceed ~15k tokens); worker reports capped
- **Standalone**: no hard dependency on other plugins; optional integrations only if detected
- **Platform**: Linux/WSL2 first; macOS should work; Windows not targeted in v1

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Claude Code main + Codex as optional workers | User wants Claude to control and monitor Codex when present | — Pending |
| All autonomy modes via `--mode` | User wants gate, auto and step selectable per task | — Pending |
| npm installer, global or local | Same install experience as other tooling user uses | — Pending |
| Standalone, borrow ideas only | Avoid dependency coupling; user wants no foreign references in source | — Pending |
| Codex watch: background default, `--tmux` option | Background saves attention; tmux lets user watch | — Pending |
| Name `a-neat-session`, commands `/neat:*` | User choice | — Pending |
| Research stage optional, on request | User correction: research must exist in pipeline, run when asked | — Pending |
| Skip domain research during bootstrap | Explorer + online research already done in questioning | ✓ Good |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-10-18 after initialization*
