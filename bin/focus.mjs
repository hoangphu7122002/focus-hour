#!/usr/bin/env node
// focus — the Focus Hour CLI. All state lives in <repo>/.focus/ and <repo>/<decisionsDir>/.
//
//   focus init                                   write .focus/config.json (detects the test command)
//   focus start [--minutes 60] [--observe] [--difficulty 1-5]  |  focus stop [--resume "where to pick up"]
//   focus status [--json]  |  focus resume-card  |  focus report
//   focus flow ["baseline ✓ → sweep ▶ → decide"]
//   focus decision list | show D | impact D | edit D [--why --depends D1,D2 --title --chosen --evidence]
//                  [--area "feature"] · confirm D | reject D | revive D | redecide D | supersede OLD --by NEW | promote D | capture  (JSON on stdin)
//   focus task add --title "…" --scope a/,b/ [--level L2] [--resources gpu] [--based-on D012] [--spec "…"]
//   focus tasks | show T [--diff] | predict T "…" | skip T | match T yes|no
//   focus approve T | rework T "…" | drop T | resume T ["…"] | label T true|false | escape T "…"
//   focus worker [--once]                        run the background workers (own terminal, or --bg)
//   focus ui [--port 7777] [--no-worker]         dashboard at http://127.0.0.1:7777 + the workers, in one process
//   focus hook pre|post|fail                     detector hooks (workers only)
//   focus event turn --ms N | event ask          (sent by the mod)

import { DEFAULTS, init, loadConfig } from '../lib/config.mjs'
import * as D from '../lib/decisions.mjs'
import { hook } from '../lib/detectors.mjs'
import * as S from '../lib/session.mjs'
import { ICON, addTask, blockedReason, getTask, listTasks, sendInbox, updateTask } from '../lib/tasks.mjs'
import { dirtyFiles, loop, prBody, removeWorktree } from '../lib/worker.mjs'
import { status, workerAlive } from '../lib/status.mjs'
import { die, findRoot, fmtDuration, git, logEvent, now, paths, readStdin, run } from '../lib/util.mjs'

const argv = process.argv.slice(2)
const flags = {}
const pos = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) flags[k] = true
    else {
      flags[k] = v
      i++
    }
  } else pos.push(a)
}

const p = paths(findRoot())
const cfg = () => loadConfig(p)
const out = x => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2))
const need = (x, msg) => x || die(msg)

function taskLine(t, c) {
  const why = t.status === 'queued' ? blockedReason(t, { tasks: listTasks(p), cfg: c, dirtyFiles: dirtyFiles(p) }) : null
  const extra =
    t.status === 'stopped' ? ` 🔥 ${t.andon?.trigger}` :
    t.status === 'review' ? (t.prUrl ? ` ${t.prUrl}` : ' (local branch)') :
    t.status === 'queued' && why ? ` · waits: ${why}` : ''
  return `${ICON[t.status] ?? '?'} ${t.id} ${t.level} ${t.title.slice(0, 50)}${t.stale?.length ? ' ⚠stale' : ''}${extra}`
}

function decisionLine(d) {
  const mark = { active: '●', draft: '✎', dead: '✗', superseded: '○', rejected: '✗' }[d.status] ?? '?'
  return `${mark} ${d.id} ${d.area ? `[${d.area}] ` : ''}${d.title ?? ''}${d.status === 'superseded' ? ` → ${d.superseded_by}` : ''}${d.status === 'dead' ? ` ✗ dead (${d.review_reason})` : ''}`
}

function headline(c) {
  const cp = S.checkpointState(p, c)
  const tasks = listTasks(p)
  const n = st => tasks.filter(t => t.status === st).length
  const ds = D.listDecisions(p, c)
  const counts = `🔵${n('review')} 🔥${n('stopped')} 🟢${n('running')} ⚪${n('queued')} · ✎${ds.filter(d => d.status === 'draft').length} ⚠${ds.filter(d => d.status === 'dead').length}`
  if (!cp.active) return `Focus Hour (not started) · ${counts}`
  if (cp.overtime) return `⏹ time's up · ${counts} · focus stop`
  const head = cp.current ? `👀 CHECKPOINT #${cp.current}` : `⏱ ${fmtDuration(cp.left)} left · 👀 #${cp.upcoming} in ${fmtDuration(cp.inMs)}`
  return `${head}${cp.mode === 'observe' ? ' · observe' : ''} · ${counts}`
}

function showTask(id, full) {
  const c = cfg()
  const t = need(getTask(p, id), `No task ${id}`)
  if (t.status === 'review') {
    S.notePull(p, c, `show ${id}`)
    if (!t.reviewStartedAt) updateTask(p, id, x => (x.reviewStartedAt = now()))
  }
  const lines = [`${ICON[t.status]} ${t.id} · ${t.title} · ${t.status} · ${t.level} · $${(t.costUsd ?? 0).toFixed(2)}`]
  if (t.status === 'stopped') {
    lines.push(`🔥 ${t.andon?.trigger}: ${t.andon?.reason}`, `   focus resume ${id} "what to do instead"  ·  focus drop ${id}  ·  focus label ${id} true|false`)
    return lines.join('\n')
  }
  if (t.checks || t.packet) lines.push('', prBody(t, c))
  if (t.status === 'review') {
    const gate = c.predict === 'required' && !t.prediction
    lines.push('', t.prUrl ? `PR: ${t.prUrl}` : `Local branch ${t.branch}`)
    if (!t.prediction && !t.predictionSkipped && c.predict !== 'off') lines.push(`✎ Predict first: focus predict ${id} "the diff will …"${c.predict === 'optional' ? `  (or focus skip ${id})` : ''}`)
    if (full && !gate) lines.push('', git(t.worktree ?? p.root, 'diff', `${c.baseBranch}...${t.branch}`).stdout || '(no diff)')
    lines.push(`Decide: focus approve ${id} · focus rework ${id} "…" · focus drop ${id}`)
  }
  return lines.join('\n')
}

function approve(id) {
  const c = cfg()
  const t = need(getTask(p, id), `No task ${id}`)
  if (t.status !== 'review') die(`${id} is ${t.status}, not waiting for review`)
  if (c.predict === 'required' && !t.prediction) die(`Predict first: focus predict ${id} "…"`)
  if (t.prNumber) {
    const r = run('gh', ['pr', 'merge', String(t.prNumber), '--squash', '--delete-branch'], { cwd: p.root })
    if (r.code !== 0) die(`gh pr merge failed: ${(r.stderr || r.stdout).trim()}`)
  }
  removeWorktree(p, t, { deleteBranch: !!t.prNumber })
  updateTask(p, id, x => Object.assign(x, { status: 'approved', reviewedAt: now() }))
  logEvent(p, 'task.approved', { id })
  return t.prNumber ? `✅ ${id} merged (PR #${t.prNumber}).` : `✅ ${id} approved. Merge the local branch yourself: git merge --squash ${t.branch}`
}

function drop(id) {
  const t = need(getTask(p, id), `No task ${id}`)
  if (t.prNumber) run('gh', ['pr', 'close', String(t.prNumber), '--delete-branch'], { cwd: p.root })
  removeWorktree(p, t, { deleteBranch: true })
  updateTask(p, id, x => Object.assign(x, { status: 'dropped', reviewedAt: now() }))
  logEvent(p, 'task.dropped', { id })
  return `❌ ${id} dropped.`
}

const [cmd, sub, ...rest] = pos
const text = rest.join(' ').trim()

try {
  switch (cmd) {
    case 'init': {
      const r = init(p, git)
      out(`${r.created ? 'Created' : 'Kept'} .focus/config.json (test: ${r.config.testCommand}, base: ${r.config.baseBranch}); .focus/state/ is gitignored.`)
      break
    }
    case 'start': {
      const s = S.start(p, cfg(), { minutes: flags.minutes ?? sub, mode: flags.observe ? 'observe' : flags.focus ? 'focus' : undefined, difficulty: flags.difficulty })
      out(`Focus Hour ${s.id} started: ${s.minutes} min, mode ${s.mode}. Checkpoints at ${cfg().checkpoints.map(c => Math.round((c / 60) * s.minutes)).join(' / ')} min.`)
      break
    }
    case 'stop': {
      const r = S.stop(p, cfg(), { resumeFrom: flags.resume })
      out(`Digest written: ${r.file}`)
      break
    }
    case 'status':
      out(flags.json ? status(p, cfg()) : headline(cfg()))
      break
    case 'headline':
      out(headline(cfg()))
      break
    case 'resume-card':
      out(S.resumeCard(p, cfg()))
      break
    case 'report': {
      const r = S.report(p)
      out(`Sessions: focus ${r.n.focus} · observe ${r.n.observe}\n` + r.table.map(x => `${x.metric.padEnd(24)} focus ${String(x.focus).padStart(7)}   observe ${String(x.observe).padStart(7)}`).join('\n'))
      break
    }
    case 'flow':
      if (sub) {
        S.setFlow(p, [sub, ...rest].join(' '))
        out('flow updated')
      } else out(S.getFlow(p, cfg()).text)
      break
    case 'attention':
      out(S.notePressureOpen(p, cfg(), text || sub || '') ? 'early checkpoint opened' : 'no active session')
      break
    case 'pull':
      out(S.notePull(p, cfg(), sub ?? 'pane') ? 'pull counted' : 'in window')
      break
    case 'event': {
      if (sub === 'turn') logEvent(p, 'turn', { ms: Number(flags.ms) || 0 })
      else if (sub === 'ask') logEvent(p, 'ask', { questions: Number(flags.questions) || 1, tagged: !!flags.tagged })
      else if (sub === 'pane') logEvent(p, 'pane', { action: rest[0] ?? '' })
      break
    }
    case 'decision':
    case 'd': {
      const c = cfg()
      const id = rest[0]
      switch (sub) {
        case 'list':
        case undefined: {
          const all = D.listDecisions(p, c).filter(d => flags.all || (d.status !== 'superseded' && d.status !== 'rejected'))
          out(all.map(decisionLine).join('\n') || 'No decisions yet.')
          break
        }
        case 'show': {
          const d = need(D.readDecision(p, c, id), `No decision ${id}`)
          const all = D.listDecisions(p, c)
          out([
            decisionLine(d), `Q: ${d.question ?? '-'}`, `Chosen: ${d.chosen ?? '-'}   Rejected: ${(d.rejected ?? []).join(', ') || '-'}`,
            `Why: ${d.why || '-'}`, `Depends on: ${d.depends_on.join(', ') || '-'}`, d.evidence ? `Evidence: ${d.evidence}` : '',
            'Affects:', ...(D.renderTree(D.impactTree(all, d.id)).length ? D.renderTree(D.impactTree(all, d.id)) : ['   (nothing)']),
          ].filter(Boolean).join('\n'))
          break
        }
        case 'impact': {
          const tree = D.impactTree(D.listDecisions(p, c), id)
          out([`${id} affects:`, ...(tree.length ? D.renderTree(tree) : ['   (nothing)'])].join('\n'))
          break
        }
        case 'capture': {
          const res = D.capture(p, c, readStdin())
          out(res)
          break
        }
        case 'edit': {
          const r = D.edit(p, c, id, { why: flags.why, depends: flags.depends, title: flags.title, chosen: flags.chosen, evidence: flags.evidence, question: flags.question, area: flags.area })
          out(`${id} updated.${r.impact.length ? ` Impact: ${r.impact.map(x => x.id).join(', ')}` : ''}`)
          break
        }
        case 'confirm':
          out(decisionLine(D.setStatus(p, c, id, 'active', 'decision.confirmed')))
          break
        case 'reject':
          out(decisionLine(D.setStatus(p, c, id, 'rejected', 'decision.rejected')))
          break
        case 'ok':
        case 'revive':
          out(decisionLine(D.revive(p, c, id)))
          break
        case 'redecide':
          D.requestRedecide(p, c, id)
          out(`${id}: asked the main session to re-decide it (it runs when the session is idle).`)
          break
        case 'supersede': {
          const impact = D.supersede(p, c, id, need(flags.by, 'Usage: focus decision supersede OLD --by NEW'))
          out(`${id} superseded by ${flags.by}.${impact.length ? ` Impact: ${impact.map(x => x.id).join(', ')}` : ''}`)
          break
        }
        case 'promote':
          out(`Promoted to ${D.promote(p, c, id)}`)
          break
        default:
          die(`Unknown: focus decision ${sub}`)
      }
      break
    }
    case 'task': {
      if (sub !== 'add') die('Usage: focus task add --title "…" --scope a/,b/ [--level L2] [--resources gpu] [--based-on D012] [--spec "…"]')
      const c = cfg()
      const t = addTask(p, c, { title: flags.title, spec: flags.spec === true ? '' : flags.spec, scope: flags.scope, level: flags.level ?? 'L2', resources: flags.resources, basedOn: flags['based-on'], area: flags.area })
      // Built on a dead decision: wait until it is revived or re-decided.
      const deadBase = t.based_on.filter(id => D.readDecision(p, c, id)?.status === 'dead')
      if (deadBase.length) {
        updateTask(p, t.id, x => Object.assign(x, { status: 'paused', pausedBy: deadBase }))
        out(`${t.id} paused: ${deadBase.join(', ')} is dead (revive or re-decide it first).`)
        break
      }
      const why = blockedReason(t, { tasks: listTasks(p), cfg: c, dirtyFiles: dirtyFiles(p) })
      out(`${t.id} queued (${t.level}, scope ${t.scope.join(', ')}).${why ? ` Waits: ${why}.` : ''}${workerAlive(p) ? '' : ' No worker running: start one with `focus worker` in another terminal.'}`)
      break
    }
    case 'tasks': {
      const c = cfg()
      if (listTasks(p).some(t => t.status === 'review')) S.notePull(p, c, 'tasks')
      out(listTasks(p).map(t => taskLine(t, c)).join('\n') || 'No tasks yet.')
      break
    }
    case 'show':
      out(showTask(sub, !!flags.diff))
      break
    case 'predict':
      updateTask(p, sub, t => (t.prediction = text || '(empty)'))
      logEvent(p, 'task.predicted', { id: sub })
      out(showTask(sub, false))
      break
    case 'skip':
      updateTask(p, sub, t => (t.predictionSkipped = true))
      logEvent(p, 'task.predict-skipped', { id: sub })
      out(`${sub}: prediction skipped (counted).`)
      break
    case 'match':
      updateTask(p, sub, t => (t.predictionMatch = rest[0] === 'yes'))
      out(`${sub}: prediction ${rest[0] === 'yes' ? 'matched' : 'missed'}.`)
      break
    case 'approve':
      out(approve(sub))
      break
    case 'drop':
      out(drop(sub))
      break
    case 'rework':
    case 'resume': {
      const t = updateTask(p, sub, x => {
        const note = cmd === 'rework' ? `The human reviewed your work and asks for changes: ${text || '(see PR comments)'}` : `The human resumed your stopped task (${x.andon?.reason ?? ''}). ${text || 'Undo the part that was stopped and stay inside your scope.'}`
        Object.assign(x, { status: 'queued', note, andon: null, prediction: undefined, predictionMatch: undefined, predictionSkipped: undefined, reviewStartedAt: undefined })
      })
      logEvent(p, `task.${cmd}`, { id: sub })
      out(`${t.id} queued again (${cmd}).`)
      break
    }
    case 'label': {
      const t = need(getTask(p, sub), `No task ${sub}`)
      logEvent(p, 'detector.label', { id: sub, trigger: t.andon?.trigger ?? t.attempts?.at(-1)?.andon?.trigger, correct: rest[0] === 'true' })
      out(`${sub}: stop labelled ${rest[0] === 'true' ? 'correct' : 'false alarm'}.`)
      break
    }
    case 'request':
      if (sub === 'done') D.doneRequest(p, rest[0])
      out(sub === 'done' ? 'ok' : D.takeRequests(p))
      break
    case 'escape':
      logEvent(p, 'escape', { id: sub, note: text })
      out(`Escaped defect logged for ${sub}.`)
      break
    case 'notify':
      sendInbox(p, sub, text)
      out(`Sent to ${sub}.`)
      break
    case 'ui':
    case 'up': {
      // One process for the hour: the dashboard, plus the workers unless another worker already runs here.
      const { serve } = await import('../lib/ui.mjs')
      serve(p, { port: Number(flags.port) || 7777 })
      if (flags['no-worker']) break
      if (workerAlive(p)) console.log('A worker already runs for this repo; the dashboard uses it.')
      else {
        console.log('Workers: running in this process (Ctrl+C stops both).')
        await loop(p, cfg, { log: line => console.log(`  ${line}`) })
      }
      break
    }
    case 'worker':
      await loop(p, cfg, { once: !!flags.once })
      break
    case 'hook':
      process.exit(hook(sub, { p, cfg: cfg(), event: readStdin() }))
      break
    case 'defaults':
      out(DEFAULTS)
      break
    default:
      out((await import('node:fs')).readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 17).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
  }
} catch (e) {
  die(String(e.message ?? e))
}
