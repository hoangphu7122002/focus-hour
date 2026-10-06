---
name: focus-plan
description: Plan one feature of the roadmap into small, independently mergeable tasks for the Focus Hour workers, get the user's approval in one question, then queue them. Use when the user says /focus-plan, "plan F2", "build feature X", hands over a roadmap section (roadmap.md#F1), or when Focus Hour asks to plan the next feature.
---

Plan ONE feature, then hand it to the workers. You do not write the feature's code yourself.

1. **Find the feature.** The argument is `<roadmap>#F<n>`, a feature id, or a description. Read that section of the
   roadmap (`focus roadmap` lists them; "roadmap" in `.focus/config.json` names the file), the spec next to it if any
   (acceptance criteria ids), `focus lessons`, the active decisions (`focus decision list`) and the code it touches.
   If its dependencies are not done, say so and stop.
2. **Split it into tasks** that each pass this rubric:
   - one folder (the task's scope) plus at most one shared contract file; aim for ≤ 8–10 files, one intent;
   - starts from the base branch, passes the test command alone, mergeable on its own (unfinished parts behind a flag);
   - contract first: when tasks share an API, schema or type, make that a task of its own and put it `--after` it;
   - tasks touching the same files get `--after` so they never run at once;
   - a level each: L1 small/mechanical, L2 normal, L3 hard or risky.
   Prefer 3–8 tasks. Name the acceptance criteria each task covers in its spec.
3. **One approval.** Show the plan as a compact table (id · title · scope · level · after · AC) and ask ONE
   AskUserQuestion, tagged `focus:-` in metadata.source: "Approve (Recommended)" / "Change something" / "Smaller split".
   A design choice the user must make goes in the same call as a separate, tagged decision question
   (`focus@<feature name>:new`).
4. **Queue it.**
   ```
   focus feature start F<n> --name "<name>" --goal "<one-line goal>"
   focus task add --feature F<n> --title "…" --scope a/ --level L2 [--after T7] [--based-on D012] --spec "<done when …; AC-3, AC-4>"
   ```
   Add tasks in dependency order so `--after` can name earlier ids (each `task add` prints the new id).
5. Reply in two lines: what was queued, and what the user does next (keep building the core; PRs arrive at checkpoints).
   When every task of the feature is merged, Focus Hour ticks it in the roadmap and asks you to plan the next one.

Rules:
- Feedback about Focus Hour itself is not project work: record it with `focus plugin-note "…"`, never as a task.
- Follow the language rule of the project (`.focus/config.json` "language").
