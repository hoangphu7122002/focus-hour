# Architecture

Focus Hour is three thin front ends over one CLI, and the CLI keeps everything as files in your repo.

## The pieces

```mermaid
flowchart LR
    you([You])

    subgraph editor["VS Code / Cursor"]
        chat["Claude chat<br/>(main session)"]
        panel["Focus map panel<br/>(extension)"]
    end

    subgraph plugin["focus-hour plugin"]
        mod["Mod<br/>captures decisions,<br/>adds the workflow to the prompt"]
        skills["Skills<br/>focus-grill · focus-task"]
        cli[["focus CLI<br/>all the logic"]]
        ui["focus ui<br/>dashboard server + workers"]
    end

    subgraph repo["Your repo (files)"]
        dec[("docs/decisions/D###.md")]
        state[(".focus/state/<br/>session · tasks · events")]
        digest[(".focus/sessions/*.md")]
    end

    workers["Workers<br/>claude -p in their own worktree"]
    gh["GitHub PRs"]

    you <--> chat
    you <--> panel
    chat --> mod --> cli
    chat --> skills --> cli
    panel --> ui --> cli
    cli <--> dec
    cli <--> state
    cli --> digest
    ui --> workers --> gh
    workers --> state
```

- **Every change goes through the CLI**: the chat, the panel and the workers never write the files themselves.
- **The repo is the database**: decisions and digests are committed; `.focus/state/` is local and gitignored.

## A decision, from question to map

```mermaid
sequenceDiagram
    participant Y as You
    participant C as Claude (main session)
    participant M as Mod
    participant F as focus CLI
    participant P as Focus map

    C->>Y: AskUserQuestion (batch of up to 4, tagged focus@Area:new)
    Y->>C: picks options
    M->>F: decision capture (question, options, answer, area)
    F-->>M: draft D012
    M-->>C: "recorded D012, fill the why"
    C->>F: decision edit D012 --why … --depends D005
    P->>F: status (every 2 s)
    F-->>P: decisions + tasks
    Y->>P: Confirm D012
```

## A decision's life

```mermaid
stateDiagram-v2
    direction LR
    [*] --> draft: you answer
    draft --> active: Confirm
    draft --> rejected: Reject
    active --> superseded: answered again, differently
    active --> dead: an upstream decision changed
    dead --> active: Still holds
    dead --> superseded: Re-decide
```

"Still holds" re-attaches the decision to the new upstream one. An active decision that shapes the whole project can
be promoted to an ADR (`docs/ADR/`).

When a decision changes, everything that builds on it turns **dead**, its queued tasks **pause**, and running
tasks get a notice.

## A task's life

```mermaid
stateDiagram-v2
    direction LR
    [*] --> queued: task add
    queued --> paused: decision dead
    paused --> queued: revived
    queued --> running: gates pass
    running --> queued: technical stop, level up
    running --> stopped: safety stop
    running --> ready: done + tests
    ready --> review: PR opened
    review --> approved: Approve
    review --> queued: Rework
    review --> dropped: Drop
    stopped --> queued: Resume
    stopped --> dropped: Drop
```

- **Gates**: fewer than 3 running, the GPU (or other resource) is free, no other task or open edit of yours touches
  the same files, and fewer than 2 PRs are waiting for you.
- **Safety stop**: an edit outside the task's scope, a deleted existing test, an irreversible command, a diff over 300
  lines. **Technical stop**: the same error 3 times, over 60 tool calls, failing tests; the task reruns one level up.

## Where the data lives

```mermaid
flowchart LR
    subgraph committed["Committed with the repo"]
        a["docs/decisions/D###.md<br/>why · depends_on · area · status"]
        b["docs/ADR/NNNN-*.md<br/>promoted decisions"]
        c[".focus/config.json<br/>hour, checkpoints, WIP, levels"]
        d[".focus/sessions/*.md<br/>digest + trial metrics"]
    end
    subgraph local["Local only"]
        e[".focus/state/<br/>session · tasks · events · inbox"]
        f["~/.focus-hour/worktrees/<br/>one checkout per task"]
    end
    subgraph remote["GitHub"]
        g["branch focus/T# → PR"]
    end
    f --> g
```

See [SPEC.md](../SPEC.md) for the full design and the reasoning behind each rule.
