"""README figures (AWS-diagram style).  python docs/assets/make_figures.py   (needs Google Chrome)
Facts: README.md (How it works, Architecture), lib/*.mjs, bin/focus.mjs, hooks/register.tsx, skills/, vscode/, ui/."""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from awsfig import BLUE, GREY, INK, ORANGE, PURPLE, RED, TEAL, Fig  # noqa: E402

CLI = "programming/language/nodejs"
USER = "onprem/client/user"
STORE = "generic/storage/storage"
GIT = "onprem/vcs/git"
GH = "onprem/vcs/github"

# ======================================================= figure 1: one hour
c = Fig(1600, 1100, HERE / "icons")
c.title("Focus Hour: one hour, from /focus start to /focus stop",
        "you build the core in the main session; workers take side tasks and come back as reviewed PRs")

c.group(20, 110, 690, 510, "Main session (you and Claude)", stroke=INK)
c.group(720, 110, 1580, 510, "Background workers (claude -p, one git worktree each)", stroke=TEAL, dash="7,5")
c.group(20, 540, 1580, 810, "Checkpoint and close", stroke=GREY, dash="6,4")

c.node(110, 225, USER, "You", ["/focus start"])
c.node(320, 225, "programming/framework/react", "Claude chat", ["AskUserQuestion batches"], size=50)
c.node(560, 225, STORE, "Draft decisions", ["D012 with a why"], size=48)
c.node(320, 395, CLI, "focus task add", ["--scope tests/"], size=50)
c.arrow([(145, 225), (285, 225)])
c.arrow([(355, 225), (525, 225)])
c.plate(440, 217, "answers", 14)
c.step(215, 200, 1)
c.step(440, 192, 2)
c.arrow([(320, 318), (320, 365)])
c.plate(420, 345, "\"give this to a worker\"", 14)
c.step(292, 345, 3)

c.node(820, 395, GIT, "Worker", ["claude -p in its own", "worktree and branch"], size=50)
c.node(1020, 395, GH, "PR opened", ["draft if big;", "opus reviewer checks it"], size=50)
c.node(820, 190, "saas/alerting/pagerduty", "Worker stops", ["detector fired:", "you resume, label or drop"], size=50)
c.arrow([(355, 395), (785, 395)])
c.step(560, 395, 4)
c.arrow([(855, 395), (985, 395)])
c.step(920, 365, 5)
c.arrow([(820, 365), (820, 285)], color=RED, dash="4,4")
c.plate(900, 335, "detector fires", 14, color=RED)

c.node(1000, 640, "programming/flowchart/display", "Checkpoint", ["the panel opens: confirm drafts,", "predict, open the PR"], size=50)
c.node(1220, 640, "programming/flowchart/decision", "Decision", ["approve / rework / drop"], size=50)
c.node(1440, 640, GIT, "Merged", ["base fast-forwarded,", "smokeCommand on main"], size=50)
c.node(740, 640, CLI, "/focus stop", ["end of the hour"], size=50)
c.node(440, 640, STORE, "Digest", [".focus/sessions/", "date-n.md + metrics"], size=48)
c.arrow([(1020, 495), (1020, 605)])
c.step(1050, 520, 6)
c.arrow([(1040, 640), (1185, 640)], head=True)
c.arrow([(1255, 640), (1405, 640)])
c.plate(1330, 632, "merged", 14)
c.step(1330, 605, 7)
c.arrow([(960, 640), (775, 640)])
c.arrow([(705, 640), (475, 640)])
c.step(620, 610, 8)

c.legend_steps(40, 880, [
    "/focus start; you and Claude build the core",
    "Answers to AskUserQuestion become draft decisions",
    "\"Give this to a worker\" runs focus task add",
    "A worker runs claude -p in its own worktree and branch",
    "It opens a PR (draft if big); an opus reviewer checks it",
    "At a checkpoint the panel opens: confirm drafts, predict, open the PR",
    "approve: merged, local base fast-forwarded, smokeCommand runs; rework or drop otherwise",
    "/focus stop writes the session digest and metrics",
], cols=1, colw=760)
c.legend_arrows(1240, 880, [("request or flow", INK, ""), ("stop / rework", RED, "4,4")])
c.save(HERE / "how-it-works")

# ======================================================= figure 2: architecture
c = Fig(1600, 1000, HERE / "icons")
c.title("Focus Hour architecture: three thin front ends over one CLI",
        "the CLI keeps everything as files in your repo; the chat, the panel and the workers never write those files themselves")

c.group(170, 110, 470, 650, "VS Code / Cursor", stroke=BLUE, dash="6,4")
c.group(520, 110, 1110, 690, "focus-hour plugin", stroke=INK)
c.group(1160, 110, 1580, 650, "Your repo (files)", stroke=GREY, dash="6,4")

c.node(80, 400, USER, "You")
c.node(320, 255, "programming/framework/react", "Claude chat", ["main session"], size=50)
c.node(320, 560, "programming/flowchart/display", "Focus map panel", ["vscode/ extension"], size=50)
c.node(660, 215, "programming/language/typescript", "Mod", ["hooks/register.tsx", "captures decisions"], size=50)
c.node(660, 390, "aws/general/toolkit", "Skills", ["focus-grill, focus-plan,", "focus-task"], size=50)
c.node(900, 300, CLI, "focus CLI", ["bin/focus.mjs, lib/*.mjs"], size=56)
c.node(900, 560, "programming/language/javascript", "focus ui", ["dashboard + workers", "ui/, 127.0.0.1:7777"], size=50)
c.node(1280, 230, STORE, "docs/decisions/", ["committed"], size=48)
c.node(1280, 380, STORE, ".focus/state/", ["gitignored"], size=48)
c.node(1280, 530, STORE, ".focus/sessions/", ["digests, committed"], size=48)
c.node(1280, 760, GIT, "Workers", ["claude -p in a worktree", "prompts/"], size=50)
c.node(1500, 760, GH, "GitHub PRs", size=50)

# you <-> chat / panel
c.arrow([(115, 390), (200, 390), (200, 255), (285, 255)], both=True)
c.arrow([(115, 410), (200, 410), (200, 560), (285, 560)], both=True)
# chat -> mod / skills
c.arrow([(355, 255), (560, 255), (560, 215), (625, 215)])
c.arrow([(560, 255), (560, 390), (625, 390)])
c.step(500, 235, 1)
# mod / skills -> cli
c.arrow([(695, 215), (770, 215), (770, 300), (865, 300)])
c.arrow([(695, 390), (770, 390), (770, 300)], head=False)
c.step(745, 255, 2)
# panel -> ui -> cli
c.arrow([(355, 560), (865, 560)])
c.plate(560, 552, "opens the dashboard", 14)
c.step(420, 530, 3)
c.arrow([(900, 520), (900, 395)])
c.plate(900, 470, "calls", 14)
# cli <-> files
c.arrow([(935, 300), (1040, 300), (1040, 230), (1245, 230)], both=True)
c.arrow([(1040, 300), (1040, 380), (1245, 380)], both=True)
c.arrow([(1040, 380), (1040, 530), (1245, 530)])
c.step(1135, 230, 4)
# ui -> workers -> gh
c.arrow([(935, 560), (1000, 560), (1000, 760), (1245, 760)])
c.plate(1120, 752, "spawns", 14)
c.arrow([(1315, 760), (1465, 760)])
c.plate(1390, 752, "PR", 14)
c.step(1000, 700, 5)

c.legend_steps(40, 850, [
    "You talk to Claude chat (the main session) or the Focus map panel",
    "The mod and the skills call the focus CLI",
    "The panel starts and shows focus ui",
    "The CLI reads and writes the files in your repo",
    "focus ui starts workers, which open GitHub PRs",
], cols=1, colw=700)
c.legend_arrows(1100, 850, [("call or write", INK, "")])
c.save(HERE / "architecture")
