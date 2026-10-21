# a-neat-session

Run a coding task through small, focused workers so your main Claude Code
session only ever receives short, fixed-shape reports.

`/neat:do <task>` turns your session into an orchestrator. Fresh worker agents
explore the code, research open questions, implement the plan, review the
diff, run the tests and update the docs. Each worker starts with a brief file
on disk, does the heavy reading and writing in its own context, and hands back
a report of at most 300 words. Everything else (briefs, reports, the plan, the
diff, review findings, test logs) stays in files under `.neat/runs/<id>/`, so
the main window stays small and a run can be resumed after `/clear`.

Optional extras:

- Routing picks a model and effort for each worker from a profile and the
  task's complexity, and steps down when your account usage is high.
- The Codex CLI can take over workers near your usage limit and acts as a
  second, independent reviewer.
- Three hooks keep the main window small: a report guard, a re-inject after
  compaction or `/clear`, and a filter that trims noisy test and build output.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Uninstall](#uninstall)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Modes](#modes)
- [Stages](#stages)
- [Model profiles and routing](#model-profiles-and-routing)
- [Configuration](#configuration)
- [Usage capture (status line)](#usage-capture-status-line)
- [Codex workers](#codex-workers)
- [Context guards and hooks](#context-guards-and-hooks)
- [Session agent](#session-agent)
- [Run files](#run-files)
- [Safety notes](#safety-notes)
- [Troubleshooting](#troubleshooting)

## Requirements

- Node.js 20 or newer
- Claude Code
- git, for the per-stage guard and the final commit (a project that is not a
  git repository still runs, but nothing is committed)
- Optional: the Codex CLI, for Codex workers and the second reviewer
- Optional: tmux, to watch Codex workers live

The package has no dependencies and no install scripts.

## Install

Install for all your projects (into `$CLAUDE_CONFIG_DIR`, default `~/.claude`):

```sh
npx a-neat-session --global
```

Or for the current project only (into `./.claude`):

```sh
npx a-neat-session --local
```

Without `--global` or `--local` the installer asks on the terminal which
scope you want; without a terminal it stops and asks you to re-run with one of
the two flags.

All installer flags (`npx a-neat-session --help`):

| Flag | What it does |
|------|--------------|
| `--global` | install for all projects into `$CLAUDE_CONFIG_DIR` (default `~/.claude`) |
| `--local` | install for this project into `./.claude` |
| `--uninstall` | remove the files and settings entries the installer added |
| `--force` | overwrite files you edited or that the installer does not own; the previous file is saved as `<file>.neat-old` |
| `--orchestrator-default` | start every session in that scope as the neat orchestrator (see [Session agent](#session-agent)) |
| `-h`, `--help` | show the help |

What gets installed into the target directory:

- `commands/neat/` with the slash commands `/neat:do`, `/neat:status`,
  `/neat:result`, `/neat:cancel` and `/neat:resume`
- `agents/` with the six workers `neat-explorer`, `neat-researcher`,
  `neat-implementer`, `neat-reviewer`, `neat-tester`, `neat-docs` and the
  session agent `neat-orchestrator`
- `neat/` with the helper `neat/bin/neat.cjs`, its library, two guides and
  `neat/manifest.json`, which records every file (with its sha256) and every
  settings entry the installer added

The installer also merges these entries into the scope's settings file
(`settings.json` for `--global`, `settings.local.json` for `--local`):

| Settings entry | Why |
|----------------|-----|
| `permissions.allow`: `Bash(node <target>/neat/bin/neat.cjs *)` | the slash commands run the helper without a prompt |
| `permissions.allow`: `Bash(set -o pipefail)` | the output filter prefixes this to the commands it trims; your original command is still checked against your own rules |
| `hooks.SessionStart` (matcher `compact\|resume\|clear`) | runs `node <helper> hook session-start` |
| `hooks.SubagentStop` (matcher: the six worker agents) | runs `node <helper> hook subagent-stop` |
| `hooks.PreToolUse` (matcher `Bash`) | runs `node <helper> hook pre-bash` |
| `agent: "neat-orchestrator"` | only with `--orchestrator-default` |

Before the first change the original settings file is copied once to
`<settings file>.neat-bak`. See [Context guards and hooks](#context-guards-and-hooks)
for what each hook does.

**Restart Claude Code (or start a new session) after installing.** Commands,
agents, hooks and the session agent are loaded when a session starts.

Re-running the installer upgrades in place. Files you edited since the last
install are kept (with a warning) unless you pass `--force`. A file at an
install path that the installer does not own is skipped and the install
reports itself incomplete; if such a file is part of the helper itself, nothing
is installed at all, because the allow rule would otherwise approve code the
installer did not write.

The install path must contain only letters, digits and `. _ / + @ -`, because
the helper path appears unquoted in the settings entries. For `--global`, point
`CLAUDE_CONFIG_DIR` at such a directory; for `--local`, run from one.

## Uninstall

Use the same scope you installed with:

```sh
npx a-neat-session --uninstall --global
npx a-neat-session --uninstall --local
```

Uninstall removes:

- every installed file that still has the recorded sha256 (files you edited
  are kept and listed)
- exactly the settings entries the installer added (allow rules, the three
  hooks); a settings file the installer created is deleted again when nothing
  else is left in it
- the `agent` setting, put back to its previous value while it still says
  `neat-orchestrator` (a value you changed afterwards is left alone, with a
  warning)
- the manifest and the empty directories the installer created

It keeps the settings backup `<settings file>.neat-bak`, any `<file>.neat-old`
written by `--force`, and the `.neat/` run directories in your projects.

## Quick start

```text
/neat:do add a --dry-run option to the export command
```

In the default `gate` mode the orchestrator explores the code, rates the task,
picks the stages, writes a plan and asks you to approve it before any file
changes. It then implements, reviews, tests, updates the docs, commits the
files the plan owned and prints a summary of at most 13 lines with the run
directory for details.

Check progress at any time with `/neat:status`.

## Commands

| Command | What it does |
|---------|--------------|
| `/neat:do [flags] TASK` | run a task through the neat workers |
| `/neat:status` | show neat runs, the current stage, active workers and Codex jobs |
| `/neat:result [job-id]` | show the short report of a Codex job (the newest job when no id is given) |
| `/neat:cancel <job-id>` | stop a running Codex job and mark it cancelled |
| `/neat:resume [run-id]` | continue an unfinished run in this session from its files on disk (the newest unfinished run when no id is given) |

`/neat:do` flags go before the task (`--mode` and `--profile` may also come
last):

| Flag | Values | Default |
|------|--------|---------|
| `--mode` | `gate`, `auto`, `step` | `gate` |
| `--profile` | `adaptive`, `quality`, `balanced`, `budget`, `inherit` | the `profile` config key (`adaptive`) |
| `--research` | add the research stage | off |
| `--tmux` | run this run's Codex workers in tmux windows | off |
| `--` | end of flags, for a task that starts with `--` | |

```text
/neat:do --mode auto --profile budget fix the typo in the CLI help
/neat:do --research --tmux migrate the cache layer to the new client
/neat:do -- --verbose should print the config path
```

## Modes

- `gate` (default): asks before implementing (Approve / Revise / Cancel on
  the plan), offers the research stage when the explorer listed open
  questions, asks on guard violations and before committing when tests
  failed.
- `auto`: never asks. A guard violation stops the run; failing tests leave the
  changes uncommitted.
- `step`: like `gate`, and also asks `Continue?` after every stage and commits
  after the implement, review fix and docs stages.

## Stages

A run moves through these stages, in this order: explore, research, plan,
implement, review, test, docs.

Explore always runs: the explorer maps the relevant code, and from its report
the orchestrator rates the task `trivial`, `normal` or `risky` (used for
routing) and picks a task type, which selects the stages:

| Task type | Stages |
|-----------|--------|
| `small-fix` | explore, plan, implement, test |
| `feature` | explore, plan, implement, review, test, docs |
| `refactor` | explore, plan, implement, review, test, docs |
| `research` | explore, research (no edits) |
| `docs` | explore, plan, docs |

`--research` (or accepting the offer in `gate` and `step`) adds the research
stage. The plan starts with an overview (goal, approach, up to 5 key points)
and splits the work into tasks that each own a set of files and say why they
are needed; tasks
with disjoint files run in parallel, the rest in later batches. The review
stage runs two reviewers on the same diff; see [Two reviewers](#two-reviewers).

## Model profiles and routing

Every worker gets a model and an effort from the profile, its role and the
task's complexity. The orchestrator passes both to the Agent tool.

| Profile | Explorer, tester, docs | Implementer, researcher | Reviewer |
|---------|------------------------|-------------------------|----------|
| `adaptive` (default) | haiku: low / medium / high effort for trivial / normal / risky | haiku low (trivial), sonnet medium (normal), opus high (risky) | sonnet medium (trivial), opus medium (normal), opus high (risky) |
| `quality` | sonnet medium | opus high | opus high |
| `balanced` | sonnet medium | sonnet medium | opus medium |
| `budget` | haiku low | haiku low | sonnet medium |
| `inherit` | the session's model, no effort set | same | same |

Usage-based adjustments read your account usage from the
[usage capture](#usage-capture-status-line): the higher of the five-hour and
seven-day rate-limit windows.

- At or above `thresholds.soft` (default 70%) every worker moves one tier
  down (opus to sonnet, sonnet to haiku; haiku stays). `inherit` never steps
  down.
- At or above `thresholds.hard` (default 90%) a worker that Codex can run
  (implementer, tester, docs, reviewer) goes to Codex when Codex is available.
  Every other worker pauses: `gate` and `step` ask whether to continue on
  Claude, `auto` stops the run.
- Without a capture, usage is unknown and nothing changes.

The second reviewer runs on another model than the first: on Codex when it
is available, else on the alternate Claude tier (opus and sonnet swap, haiku
moves to opus, `inherit` uses sonnet).

See the route of a worker with
`node <target>/neat/bin/neat.cjs route <run-id> --all`.

## Configuration

Two optional JSON files, both strictly validated (an unknown key or a bad
value is an error that names the file):

- global: `<claude config dir>/neat/config.json`, where the Claude config dir
  is `$CLAUDE_CONFIG_DIR` or `~/.claude`
- project: `<project root>/.neat/config.json`

Later layers win: defaults, then global, then project, then the run's
`--profile`.

| Key | Default | Values | Project file |
|-----|---------|--------|--------------|
| `profile` | `adaptive` | `adaptive`, `quality`, `balanced`, `budget`, `inherit` | yes |
| `thresholds.soft` | `70` | 0-100, at most `thresholds.hard` | yes |
| `thresholds.hard` | `90` | 0-100 | yes |
| `usage.capturePath` | `<claude config dir>/neat/usage.json` | an absolute path (`~/` allowed) | no, global only |
| `codex.enabled` | `auto` | `auto` (use when found), `on` (required), `off` | only `off` |
| `codex.model` | unset (Codex default) | a model name | no, global only |
| `codex.sandboxDefault` | `workspace-write` | `read-only`, `workspace-write` | no, global only |
| `review.maxRounds` | `2` | integer 0-5: review fix rounds before you are asked | yes |
| `context.warn` | `60` | 0-100, at most `context.critical` | yes |
| `context.critical` | `75` | 0-100 | yes |
| `filter.enabled` | `true` | `true`, `false` | yes |

Example global config:

```json
{
  "profile": "balanced",
  "thresholds": { "soft": 75, "hard": 92 },
  "codex": { "enabled": "auto", "sandboxDefault": "workspace-write" },
  "review": { "maxRounds": 1 },
  "context": { "warn": 55, "critical": 70 },
  "filter": { "enabled": true }
}
```

Show the effective values, where each comes from and both file paths:

```sh
node ~/.claude/neat/bin/neat.cjs config show
node ~/.claude/neat/bin/neat.cjs config get profile
```

(Use `.claude/neat/bin/neat.cjs` for a local install.)

## Usage capture (status line)

Routing and the context warnings need your usage and context-window numbers.
Claude Code sends them to the status line command on stdin, so the helper
offers a pass-through filter, `usage-capture`, that you put in front of your
status line. It copies stdin to stdout unchanged, saves a copy as the capture
file, always exits 0 and never writes to stderr, so it cannot break your status
line.

With an existing status line command, chain it in your `settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /home/you/.claude/neat/bin/neat.cjs usage-capture | your-existing-status-command"
  }
}
```

Without one, add `--quiet` (nothing is printed, the status line stays empty):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /home/you/.claude/neat/bin/neat.cjs usage-capture --quiet"
  }
}
```

The capture goes to `<claude config dir>/neat/usage.json`, or to the global
`usage.capturePath`. `--path <file>` writes elsewhere; routing reads only
`usage.capturePath`, so set both to the same file if you use it.

The capture is a single file written by whichever session refreshed its
status line last. Rate-limit windows count until their reset time; the
context percentage counts only while the file is younger than 15 minutes and
does not name another session. When the capture or the reading session has
no session id, the percentage is used as it is, even if another session
wrote it.

## Codex workers

Setup:

1. Install the Codex CLI (`npm install -g @openai/codex`) and log in with
   `codex login`.
2. Make sure `codex` is on your `PATH` (absolute `PATH` entries only), or set
   `NEAT_CODEX_BIN` to the absolute path of the binary (`none` turns detection
   off).
3. Check detection with `node ~/.claude/neat/bin/neat.cjs codex detect`.

`codex.enabled` decides how Codex is used: `auto` (default) uses it when found,
`on` makes `/neat:do` refuse to start when it is missing, `off` never looks
for it (a project config may only set `off`).

Codex runs:

- the second reviewer, whenever Codex is available
- implementer, tester, docs and reviewer workers at or above
  `thresholds.hard`
- write roles only while `codex.sandboxDefault` is `workspace-write`; the
  reviewer always runs `read-only`

Each Codex worker is a background job: the orchestrator starts it with
`neat codex run`, waits with `neat codex wait` as a background command and
reads the outcome only through `neat codex result`. With `--tmux` on
`/neat:do` (and tmux installed) each job opens a tmux window instead: inside
tmux in your current session, otherwise in a detached session `neat-<run-id>`.
The orchestrator shows the `attach:` line, for example
`tmux attach -t neat-20261019-101500-add-a-dry-run-option`. Without tmux the
job runs in the background with a note.

At any time, `/neat:result [job-id]` shows a job's short report and
`/neat:cancel <job-id>` stops it. A Codex worker that fails below the hard
threshold is retried once on Claude.

### Two reviewers

The review stage runs `reviewer` and `reviewer-2` in parallel on the same
diff, on different models (see routing). `neat review merge` combines their
findings into `review-merged.md`: agreements are marked `[both]` and come first,
a critical finding only one reviewer reported is marked `(disputed)`. Critical
and warning findings in files a plan task owns become a fix round for those
tasks, followed by a fresh review. After `review.maxRounds` fix rounds (or for
a critical finding in a file no task owns), `gate` and `step` ask whether to
fix again, continue or stop; `auto` stops and leaves the changes uncommitted.

## Context guards and hooks

All three hooks call the installed helper (`node <helper> hook <name>`). They
read the hook input, never fail the session (no output and exit 0 on any
error), and stay silent unless the project has an active neat run: unfinished
and updated within the last 24 hours. When a project has its own local install,
the global install's hooks stay silent there.

### Report guard (SubagentStop)

When a neat worker stops, its final message is checked against the report
contract: the five headings `## Status`, `## Findings`, `## Decisions`,
`## Open questions`, `## Artifacts`, a valid status line, at most 300 words,
and every path listed under `## Artifacts` must exist (relative paths are
resolved against the run dir).
A worker is matched to its run by the brief it was given, else by the
session's own run. A broken report is sent back to the worker with the
checker's error lines. After
two rejections the worker may stop anyway and a warning is kept in the run.
Other agents are never checked.

### Re-inject after compaction, resume and /clear (SessionStart)

After a compaction or a resumed session, the hook tells the session which run
of this session is active: its id, mode, stage, the first line of the task,
the exact next step and the pointer `/neat:resume <id>`. After `/clear` it
prints a one-line pointer to the newest unfinished run. It never injects
report, brief or plan text. `/neat:resume` ties the run to the session that
resumes it, so the hooks follow the run into that session.

### Context warnings

`neat brief`, `neat run stage` (except for `done` and `cancelled`) and
`neat route` print a `context:` line when this session's context window
reaches `context.warn` (default 60%). At
`context.critical` (default 75%) the orchestrator finishes the current step,
starts no new workers and tells you to run `/clear` and then
`/neat:resume <id>`. The resumed session reads the run state from disk and
continues at the right section: `neat run resume` prints the task text, each
worker report's status, the plan batches and the next step, and the
orchestrator gets back a report or the plan it no longer has with
`neat report show <run-id> <worker>` and `neat plan show <run-id>` (or
`neat plan view <run-id>` for the readable plan at approval). Context
numbers come from the
[usage capture](#usage-capture-status-line).

### Noisy output filter (PreToolUse)

While this session's run is active and `filter.enabled` is `true`, a plain
known noisy command is rewritten to

```text
set -o pipefail; <your command> 2>&1 | node <helper> filter <run-id> <test|build|install> <log>
```

The full output goes to `.neat/runs/<id>/logs/`. A first line naming that log
is printed as soon as the command starts, so the path is known even when the
command times out or is interrupted. When the command ends, output up to 40
lines and 2000 characters comes back unchanged; longer output is trimmed to a
header, the failure-relevant lines with a little context and the last lines.
The command's own exit code is kept.

Only the session that started the run is filtered, and its logs go to that
run; other sessions in the same project are left alone. A run that recorded
no session id is used only while it is the only active run.

Recognized commands:

- tests: `npm test`, `npm run test*` and the same for pnpm, yarn and bun;
  `node --test`, `pytest`, `python -m pytest`, `tox`, `go test`,
  `cargo test`, `cargo nextest run`, `mvn test|verify`, `gradle test|check`,
  `ctest`, `dotnet test`, `rspec`, `bundle exec rspec`, `phpunit`, `mix test`,
  `make test|check`; jest, mocha, `vitest run` and `playwright test`, directly
  or through npx, bunx, `pnpm exec` or `yarn exec`
- builds: `npm run build*` (and pnpm, yarn, bun), `tsc`, webpack, `vite build`,
  `next build`, `go build|vet`, `cargo build|check|clippy`,
  `mvn compile|package|install`, `gradle build`, `cmake --build`, ninja,
  `dotnet build`, other `make` targets
- installs: `npm install|i|ci`, `pnpm install|i|add`, `yarn install|add`,
  `bun install|add`, `pip install`, `python -m pip install`,
  `go mod download`, `bundle install`, `poetry install`, `uv sync`,
  `uv pip install`, `composer install`

It leaves alone anything with pipes, redirects, `;`, `&&` (except one leading
`cd <dir> &&`), subshells or substitutions, watch modes and dev servers
(including `test*` and `build*` scripts whose name contains `watch`, `dev`,
`serve` or `start`), `make clean|install|run` and background commands.

The rewrite does not approve anything: Claude Code checks the rewritten
command against your permission rules, `set -o pipefail` is covered by the
installed allow rule, and your original command must still be allowed by your
own rules. Wildcard rules such as `Bash(npm test *)` match the rewritten form;
an exact rule without `*` may not, and then you get a prompt. Turn the filter
off with `"filter": { "enabled": false }` in either config file.

## Session agent

`--orchestrator-default` sets `"agent": "neat-orchestrator"` in the scope's
settings, so every new session in that scope starts as the neat orchestrator:
it runs each coding task as a neat run without `/neat:do`, answers plain
questions directly and offers `/neat:resume` for unfinished runs. Your slash
commands keep working.

- Prefer `npx a-neat-session --local --orchestrator-default`, which limits it to
  one project. With `--global` the installer warns that every session in
  every project will start as the orchestrator.
- Try it first without changing settings: `claude --agent neat-orchestrator`.
- Re-installing without the flag keeps the setting; `--uninstall` puts the
  previous `agent` value back.
- If `agents/neat-orchestrator.md` already exists in that scope and was not
  installed by a-neat-session, the installer stops before writing anything
  instead of pointing `agent` at your file. Remove it or re-run with `--force`.

## Run files

Each run lives in `.neat/runs/<id>/` in the project root, with an id such as
`20261019-101500-add-a-dry-run-option`:

| File | Content |
|------|---------|
| `state.json` | stage, workers, plan tasks, commits, warnings |
| `brief-<worker>.md` | the brief each worker started from |
| `report-<worker>.md` | each worker's report |
| `plan.md` | the approved plan |
| `research-notes.md` | sourced research findings |
| `diff.patch` | the diff the reviewers saw |
| `review.md`, `review-2.md`, `review-merged.md` | review findings |
| `test-log.txt` | the tester's full test output |
| `logs/` | full output of filtered commands |
| `jobs/` | Codex job records |

`/neat:do` prints `hint: add .neat/ to .gitignore` when the directory is not
ignored yet; add it so run files never end up in a commit.

## Safety notes

- Only the orchestrator commits, through `neat run commit`, and only the files
  the plan tasks owned that actually changed. Files with uncommitted changes
  before the run are never committed.
- Commit messages follow your repository's style. By default the subject is a
  Conventional Commit, `<type>: <first line of the task>`, with the type taken
  from the task type: `fix` (small fix), `feat` (feature), `refactor`,
  `docs` (docs or research), otherwise `chore`; in `step` mode the docs-stage
  commit is `docs`. When most of the last 20 commit subjects are not in that
  form, the subject is the task's first line as a plain sentence instead.
- After every batch the ownership guard compares the working tree with the
  plan. Changes outside the owned files, or to git hooks, git config, the
  installed helper, agents, commands or guides, or your Claude Code settings,
  are reported. `gate` and `step` ask, `auto` stops. A commit is refused when
  HEAD moved or git hooks or config changed during the run.
- Worker and Codex reports are treated as untrusted data: the orchestrator
  never follows instructions, runs commands or opens links found in them, and
  the hooks never inject their text.
- Permissions granted by the installer: the helper allow rule and
  `Bash(set -o pipefail)`. Workers use only the tools listed in their agent
  files; the explorer and reviewer have no edit tools.
- Size limits: a report is at most 300 words, the run summary at most 13
  lines, and hook text at most 1500 characters.
- Codex receives the brief on stdin, never on the command line; values passed
  to `codex exec` come from fixed tables.

## Troubleshooting

- **`/neat:do` is missing after install:** restart Claude Code or start a new
  session; commands, agents and hooks load at session start.
- **Install fails with `install path contains spaces or shell characters`:**
  use a path with only letters, digits and `. _ / + @ -` (set
  `CLAUDE_CONFIG_DIR` for `--global`).
- **`incomplete install: skipped ...`:** a file at an install path is not
  owned by the installer; remove it or re-run with `--force`.
- **A permission prompt for filtered test commands:** add a wildcard rule
  such as `Bash(npm test *)`, or set `filter.enabled` to `false`.
- **No `context:` lines and usage `unknown` in `neat route`:** set up the
  [usage capture](#usage-capture-status-line). The context percentage is
  also ignored when the capture is older than 15 minutes or names another
  session (a capture or session without a session id is still used).
- **Codex is never used:** run `codex detect` through the helper
  (`node ~/.claude/neat/bin/neat.cjs codex detect`), check `codex login`,
  `codex.enabled` and `codex.sandboxDefault`.
- **`codex.enabled is on but codex was not found`:** install Codex or set
  `codex.enabled` to `auto`.
- **Routing ignores the profile:** the environment variables
  `CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` override
  the routed effort and model; the helper prints a `note:` when they are set.
- **Hooks do nothing for an old run:** runs not updated for 24 hours are
  ignored by the hooks. `/neat:status` and `/neat:resume <id>` still find them.
- **Something is left after uninstall:** files you edited are kept and listed;
  `<settings file>.neat-bak`, `*.neat-old` and `.neat/` stay by design and can
  be deleted by hand.

## License

MIT
