# Focus Hour — spec (v0.1)

> One focused hour with Claude Code: the human works the core with the main session and decides; background
> workers do related side tasks and open real PRs at the human's review pace. Every decision is recorded with a
> plain-language *why*, and changing one shows what it affects.
>
> Builds on `proposal.md` (W4 review-paced + A jidoka). Settled in a grilling session on 2026-10-03.
> Goal of v0.1: **validate the method** (solo user, one testbed repo), while staying **general** for any repo.

## 1. Principles (inherited from the proposal)

| # | Principle | Mechanism here |
|---|---|---|
| P1 | The human reviewer is the bottleneck, so cap the work that reaches them | `reviewCap` (PRs waiting); workers hold finished work when full |
| P2 | Agents don't know when they're wrong, so trust machine checks over agent claims | Smoke detectors; packet splits *machine checks* from *agent claims* |
| P3 | Understanding comes from working with the AI, not delegating | Main session = core; decisions captured from the human's own choices |
| P4 | Interruptions are costly | Pane collapses outside checkpoints; no pings; opening it early is counted |
| P5 | Irreversible steps need human consent | Merge only from a human button press; workers never push to the base branch or merge |
| P6 | Parallel work on coupled code hurts | Scope lock: overlapping scopes queue; the main session's dirty files count as locked |

Deliberate relaxations versus the proposal (the trial decides whether they hold):
1. WIP: several workers run in parallel and up to `reviewCap = 2` PRs wait (proposal: 1).
2. Predict-first is optional (`predict: "optional"`); skipping is counted.

## 2. Roles and lanes

```text
┌───────────────────────── 1 FOCUS HOUR (configurable) ─────────────────────────┐
│ MAIN SESSION  human + AI build the core · AskUserQuestion batches → decisions │
│ WORKERS       separate headless sessions, one git worktree + branch per task  │
│               level L1/L2/L3 → model/effort · detectors stop/escalate         │
│               finished → commit → push branch → PR (if reviewCap allows)      │
│ PANE          Session · Decisions · Queue — full at checkpoints, 1 line between │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 3. Packaging

One Claude Code plugin, installed once per user; each repo holds only config and records.

```text
focus-hour/                          (this repo = the plugin)
├─ .claude-plugin/plugin.json
├─ hooks/hooks.json, register.tsx    mod: pane, decision capture, system-prompt section, checkpoint toasts
├─ skills/focus-grill, focus-task    batch questions tagged by decision · dispatch a task
├─ bin/focus, lib/*.mjs              CLI (Node ≥ 18, no dependencies): state, worker, detectors, digest
└─ prompts/worker.md                 rules every worker runs under

<any repo>/
├─ .focus/config.json                committed: numbers below, test command, resources
├─ .focus/sessions/<date>-<n>.md     committed: end-of-hour digests (trial data)
├─ .focus/state/                     gitignored: session, tasks, events.jsonl, flow.md, inbox, worktrees
└─ docs/decisions/D###.md            committed: the decision log (dir configurable)
```

`focus init` writes `.focus/config.json` by reading the repo (Makefile `test:`, package.json, pyproject, go.mod,
Cargo.toml) and adds the gitignore lines. The mod is the UI; **all logic lives in the CLI**, so everything keeps
working (as text) if mods are unavailable.

## 4. Configuration (`.focus/config.json`, every key optional)

```jsonc
{
  "focusMinutes": 60,
  "checkpoints": [20, 40, 52],          // minutes of a 60-min hour; scaled to focusMinutes
  "checkpointWindowMinutes": 3,
  "attention": { "mode": "hybrid", "waitWarnMinutes": 10, "minGapMinutes": 10 }, // hybrid | fixed
  "mainEffort": { "ask": "low", "code": "medium" }, // main session, during a focus hour; null = hands off
  "paneOutsideCheckpoint": "collapsed", // full | collapsed | hidden
  "wip": { "running": 3, "reviewCap": 2, "readyBuffer": null }, // PRs waiting for you · finished work held back
  "resources": {},                      // e.g. { "gpu": 1 } — max concurrent tasks holding it
  "levels": {
    "L1": { "model": "haiku",  "effort": "low",    "maxTurns": 30 },
    "L2": { "model": "sonnet", "effort": "medium", "maxTurns": 60 },
    "L3": { "model": "opus",   "effort": "high",   "maxTurns": 80 }
  },
  "escalate": { "max": 1, "on": ["loop", "budget", "tests-failing"] },
  "detectors": { "lineBudget": 300, "callBudget": 60, "repeatLimit": 3 },
  "predict": "optional",                // required | optional | off
  "mode": "focus",                      // focus | observe (baseline arm of the trial)
  "testCommand": "make test",
  "baseBranch": "main",
  "decisionsDir": "docs/decisions",
  "worker": { "allowedTools": [], "maxBudgetUsd": 3 }
}
```

## 5. Decisions

### 5.1 Record

`docs/decisions/D012.md`:

```markdown
---
id: D012
title: max-num-seqs = 64 on 1×L4
status: active            # draft | active | needs-review | superseded | rejected
depends_on: [D005, D009]
supersedes: D007
superseded_by:
question: Which max-num-seqs for Qwen3-4B on one L4?
chosen: "64"
rejected: ["32", "128"]
evidence: results/explore/2026-10-02_seqs_l4/
session: 2026-10-03-1
created: 2026-10-03T09:12:00Z
---
Why (plain language): above 64 the p95 TTFT breaks the SLO; 128 runs out of KV cache.
```

Decisions that shape the project long-term are promoted to an ADR (`focus decision promote D012`), which links both ways.

### 5.2 Capture (from AskUserQuestion, no extra typing)

- The model asks in **batches** (≤ 4 questions per AskUserQuestion call, the tool's limit) and tags each question in
  the hidden `metadata.source`: `focus:<tag>,<tag>,…`, one tag per question, in order.
  - `new` or `new:<slug>`: a new decision (questions sharing a slug form one decision).
  - `D012`: revisits D012 (a different answer supersedes it).
  - `-`: not a decision (clarification).
- Default: 1 question = 1 decision. Group only questions that cannot be decided apart.
- The mod reads the answers from the tool's result and calls `focus decision capture`, which writes **draft**
  D-files holding the machine facts (question, options, chosen, rejected). The tool result tells the model the new
  ids so it fills `why` (plain language) and `depends_on` with `focus decision edit`.
- If the human states a decision in free text, the model offers a yes/no AskUserQuestion to record it (back to the
  same path).
- Drafts are confirmed by the human at checkpoints (✓ / edit / ✗) in the pane.

### 5.3 Impact

When a decision is superseded or edited in place:
1. Every active decision that transitively `depends_on` it becomes `needs-review`; the pane shows the tree.
2. Every task whose `based_on` includes an affected decision is marked **stale**; a running worker gets a notice
   ("D012 changed: X → Y") in its inbox, delivered on its next tool call; an open PR is flagged ⚠ for review.

## 6. Tasks and workers

### 6.1 Task

```text
focus task add --title "sweep script for max-num-seqs" --scope scripts/sweep/ --level L2 \
               [--resources gpu] [--based-on D012] [--spec "…"]
```

The `focus-task` skill proposes level, scope and `based_on` from the conversation and confirms them with the human
in one AskUserQuestion (folded into a batch when possible).

States: `queued → running → (stopped | ready) → review → approved | dropped`, with `rework` going back to `queued`.

### 6.2 Scheduling (`focus worker`, a loop in its own terminal or `--bg`)

A queued task starts when all hold:
- running tasks < `wip.running`;
- each of its `resources` has a free slot;
- its scope does not overlap a running task's scope, nor a file the main checkout has modified (scope lock);
- (optional) finished-but-unpublished tasks < `wip.readyBuffer` (unset: no limit).

The review cap holds PRs, not workers: a finished task is committed and held as `ready`; it is pushed and gets a PR
only while PRs waiting for review < `reviewCap`, oldest first. So workers never idle on you, and you never face more
than `reviewCap` open PRs; when finished work piles up behind a full queue (`attention.readyWarn`), the pane pulls a
checkpoint early.

### 6.3 Run

- `git worktree add .focus/state/worktrees/T5 -b focus/T5 <baseBranch>`.
- `claude -p` in the worktree, model/effort/maxTurns from the level, `--permission-mode dontAsk` with an allowlist
  (read/edit tools, the test command, `git diff/status`, plus `worker.allowedTools`), `--max-budget-usd`,
  the worker rules appended to the system prompt, detector hooks passed via `--settings`.
- The worker writes a packet (`summary`, `decisions`, `risks`, `out_of_scope`) to `.focus/packet.json` in the worktree.

### 6.4 Smoke detectors (workers only)

| Trigger | When | Class |
|---|---|---|
| `scope` | Edit/Write outside the task scope | safety → stop |
| `tests-removed` | fewer test cases in a test file | safety → stop |
| `irreversible` | `git push`, `gh pr merge`, `terraform apply/destroy`, `rm -rf`, `git reset --hard`, … | safety → stop |
| `diff-size` | written lines > `lineBudget` | safety → stop |
| `loop` | the same Bash command fails `repeatLimit` times | technical → escalate |
| `budget` | tool calls > `callBudget` | technical → escalate |
| `tests-failing` | the test command fails after the worker finished | technical → escalate |

Escalation: technical triggers re-run the task one level up (max `escalate.max` times), resuming in the same worktree.
Safety triggers stop the task until the human decides (`resume` / `drop`) and label the stop (`label true|false`).
In `observe` mode detectors only log.

### 6.5 PR

Branch `focus/T5`, PR title `[T5] <title>`, body = packet:

```markdown
## Machine checks
✅ scope only scripts/sweep/ · ✅ tests +4 · ⚠ mocks +1 · ✅ 120/300 lines · ✅ `make test` passed · L2 sonnet · $0.41
## Agent claims (unverified)
summary · decisions · risks · out of scope
## Context
based on D012 · ⚠ stale: D012 changed during the run
```

## 7. Review flow

Pane row → packet + checks → optional one-line prediction (or Skip, counted) → `Open PR ↗` → back in the pane:
`match ✓/✗`, `Approve & merge`, `Rework…`, `Drop`. Merge = `gh pr merge --squash --delete-branch`, only from the human's
press (or `focus approve`). Without a GitHub remote the task stays a local branch and `focus show T5 --diff` is the review.

## 8. The hour and the pane

```text
┌ Focus ─ ⏱ 32:10 · 👀 #2 in 7:50 · 🔵2 ⚠1 🟢1 ⚪1 ─────────────────────────────┐
│ [Session] [Decisions 2 drafts] [Queue]                                         │
│ Flow: baseline ✓ → sweep seqs ▶ → decide config                               │
│ D012 ● max-num-seqs=64 · D009 ⚠ 1×L4 (D005 changed) · D013 ✎ draft            │
│ T3 🔵 sweep script  PR #14 ↗ · T4 🟢 plot TTFT 6m $0.12 · T5 ⚪ notes (gpu busy) │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- The pane opens when an hour starts. Outside checkpoint windows it shows one header line (`collapsed`); at a
  checkpoint it expands and toasts.
- **Attention (hybrid)**: fixed checkpoints are the latest you look; pressure can pull one earlier.

  | Level | When | Pane |
  |---|---|---|
  | 0 | nothing waits | dim line |
  | 1 | a PR or a decision waits | cyan line |
  | 2 | a PR waited > `waitWarnMinutes`, or the review queue is full | yellow line + one toast |
  | 3 | a worker is blocked on review, or a task stopped | red; auto-opens as an **early checkpoint** (window counts as a checkpoint), at most once per `minGapMinutes` |

  `attention.mode: "fixed"` keeps checkpoints only.
  Opening the Queue early is allowed and counted as a pull. Decisions are never gated (they are main-lane work).
- **Web dashboard** (`focus ui`, 127.0.0.1 only; docked in VS Code/Cursor by the `vscode/` extension): a **Focus map**:
  decisions and tasks as a left-to-right flow (a node sits right of what it builds on), one lane per feature `area`
  (set by the AI via `focus@<area>:` tags or `--area`, editable in the panel); selecting a node lights what it builds
  on and what it affects ("replaced by" links are history and carry no impact). Same data as for the VS Code
  extension, whose chat does not show mod panes. Buttons run a fixed allowlist of CLI commands; between
  checkpoints it raises macOS notifications (level 2) and early checkpoints (level 3).
- **Resume card** (on start): where the last hour stopped, decisions needing review, drafts, PRs waiting.
- **Flow**: the main session keeps `.focus/state/flow.md` with `focus flow set "…"` when a step completes; if stale,
  the pane derives it from decisions and tasks.
- **End-of-hour digest**: `focus stop` writes `.focus/sessions/<date>-<n>.md` (decisions, tasks, metrics, "resume from").

## 8b. Effort

- **Workers**: each level sets model and effort (`L1 haiku/low`, `L2 sonnet/medium`, `L3 opus/high`), passed to
  `claude -p --effort`; escalation raises both.
- **Main session** (the mod, during an active focus hour in focus mode): every turn starts at `mainEffort.ask` (asking,
  grilling, choosing between options) and moves to `mainEffort.code` for the rest of the turn once it edits a file.
  Typing `/effort …` yourself turns this off for the session. The effort in use shows in the status band.

## 9. Trial

- Alternate sessions: `mode: focus` and `mode: observe` (same logging; no caps, gates, or predicts; detectors log
  only). At least 5 of each. `focus start --difficulty 1-5` records how hard the session's work was.
- Metrics (from `events.jsonl`, in each digest; `focus report` aggregates across digests):

| # | Metric |
|---|---|
| ① | agent done → human review latency (min) |
| ② | human review minutes per merged PR |
| ③ | escaped defects (`focus escape T5 "…"`, logged later) |
| ④ | detector precision (labelled correct stops / labelled stops) |
| ⑤ | prediction match rate, skips |
| ⑥ | pane pulls outside checkpoints |
| ⑦ | questions per decision; seconds waiting on the main session's turns |
| $ | worker cost per merged PR, escalations per level |

- Cross-check with transcripts (`~/.claude/projects/<repo>/*.jsonl`): turns, tokens, time.
- Stop or adjust if escapes > 2× observe sessions, detector precision < 30–50%, or ⑥ doesn't drop.

## 10. Out of scope for v0.1 (phase 2)

Ready queue of drafted tasks prepared outside the hour · risk-sorted review queue · conflict detection between
decisions · workers on a remote GPU box · a web view.
