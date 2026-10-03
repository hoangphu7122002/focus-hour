---
name: focus-task
description: Dispatch a side task to the Focus Hour background workers (own worktree, real PR, review-paced). Use when the user says /focus-task, "give this to a worker", "run this in the background", or wants side work (tests, docs, scripts, verification) done while they keep working on the core.
---

Turn the request into one Focus Hour task and queue it. Do not do the task yourself.

1. Draft from the conversation:
   - **title**: one line;
   - **scope**: the path prefixes the worker may edit (as narrow as possible, comma-separated; it must not overlap
     files the user is editing now);
   - **level**: L1 (search/summarise/docs/format), L2 (tests, scripts, small refactors with a clear spec),
     L3 (hard bugs, design, analysing results) — see `.focus/config.json` "levels" for the models;
   - **resources**: only names declared in `.focus/config.json` "resources" (e.g. `gpu`), if the task needs one;
   - **based_on**: the decision ids (`focus decision list`) the task relies on;
   - **spec**: what "done" means, the test to run, anything the worker must not touch.
2. Confirm with ONE AskUserQuestion (tag `-` in `metadata.source`, as `focus:-`): the level (recommended first, with
   the model and a cost hint) and, if unsure, the scope. Fold it into a pending batch when there is one.
3. Run:
   `focus task add --title "…" --scope a/,b/ --level L2 [--resources gpu] [--based-on D012,D014] --spec "…"`
4. Reply in one line: the task id and whether it starts now or what it waits for. Do not report on it again until
   the user asks; they review it at the next checkpoint.
