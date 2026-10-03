---
name: focus-grill
description: Grill the user about a plan or design in batches of up to 4 independent questions per AskUserQuestion call, each tagged with the decision it records (Focus Hour decision log). Use when the user asks for /focus-grill, a grilling, or to stress-test a plan during a Focus Hour.
---

Interview me relentlessly about every aspect of this until we reach a shared understanding. Walk down the decision
tree and resolve dependencies between decisions.

Ask in rounds, not one question at a time:
- Each round is ONE AskUserQuestion call with 1-4 questions. Put in the same round only questions that are
  independent: my answer to one must not change what you would ask in another. A dependent question waits.
- Order the round from most to least important.
- Each question has 2-4 options; put your recommended answer first, mark it "(Recommended)", and give a one-line
  plain-language reason in its description.
- Tag every question with the decision it records in `metadata.source`, as `focus@<feature area>:<tag>,<tag>,…`
  (one tag per question, same order). The feature area is a short, stable name for the part of the product the batch
  is about ("Batching", "Trace replay"); reuse the areas `focus decision list` already shows. Tags:
  - `new` — a new decision (default: one question = one decision);
  - `new:<slug>` — questions sharing a slug form one decision (only when they cannot be decided apart);
  - `D012` — revisits an existing decision (run `focus decision list` first to know them);
  - `-` — a clarification, not a decision.
- If a *fact* can be found by exploring the environment, look it up rather than asking. The decisions are mine.

After each round, the tool result names the draft decisions Focus Hour recorded. For each, run
`focus decision edit <id> --why "<plain-language reason, 1-2 sentences, why I chose it over the others>" --depends <ids it builds on>`
(and `--title` if the generated one is unclear). `--depends` draws the Focus map: list every earlier decision that
would have to be revisited if this one changed. Then state in one line what is now decided and what the next round covers.

Do not act on the plan until I confirm we have reached a shared understanding.
