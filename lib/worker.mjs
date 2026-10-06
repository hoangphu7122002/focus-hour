// The worker loop: starts queued tasks in their own worktree + headless session, checks the result,
// escalates or stops, then publishes finished work as a PR while the review queue has room.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, nextLevel } from './config.mjs'
import { MOCK, SAFETY, TEST_CASE, TEST_FILE, count, emptyRun, inScope } from './detectors.mjs'
import { advance, loadFeatures } from './features.mjs'
import { comment, feedbackNote, markReady, newFeedback, prSnapshot, repoSlug } from './github.mjs'
import { addLesson, languageRule, lessonsForPrompt } from './guard.mjs'
import { bigReasons, reviewerName, runReviewer, verdictComment } from './review.mjs'
import { prTeamActive, stackTestArgs } from './bach.mjs'
import { lease, prepare, release, teardown } from './slots.mjs'
import { canPublish, getTask, listTasks, pickRunnable, runFile, saveTask, updateTask } from './tasks.mjs'
import { git, listDir, logEvent, now, readJson, readText, run, writeJson } from './util.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(PLUGIN_ROOT, 'bin', 'focus.mjs')

export const branchOf = t => `focus/${t.id}`
const worktreeOf = (p, t) => join(p.worktrees, t.id)
const packetOf = (p, t) => join(p.packets, `${t.id}.json`)

// ---------- the prompt ----------

export function buildPrompt(p, cfg, t, note, slot) {
  const feature = t.feature ? loadFeatures(p).features[t.feature] : null
  const lessons = lessonsForPrompt(p, cfg, t.scope)
  return [
    `FOCUS TASK ${t.id}: ${t.title}`,
    `Your working copy is ${worktreeOf(p, t)} (a git worktree on branch ${branchOf(t)}). Read and edit files ONLY under it, with paths under it; never touch ${p.root}.`,
    t.spec ? `\nSpec:\n${t.spec}` : '',
    `\nAllowed scope (the only paths you may create or edit, relative to the repo root): ${t.scope.map(s => s || '(whole repo)').join(', ')}`,
    `Test command: ${cfg.testCommand}`,
    `Packet file (write it last, absolute path): ${packetOf(p, t)}`,
    `Budget: at most ${cfg.detectors.callBudget} tool calls and ${cfg.detectors.lineBudget} written lines.`,
    t.based_on.length ? `Based on decisions: ${t.based_on.join(', ')} (in ${cfg.decisionsDir}/; read them if relevant).` : '',
    feature ? `Part of feature ${feature.id} · ${feature.name}${feature.goal ? `: ${feature.goal.replace(/\.+$/, '')}` : ''}${feature.ac?.length ? ` (acceptance criteria ${feature.ac.join(', ')})` : ''}.` : '',
    slot ? `Environment slot ${slot.slot}: ${Object.entries(slot.env).map(([k, v]) => `${k}=${v}`).join(' ')} (also in .env.slot; already in your environment).${slot.stack ? ` The repo has a stack.toml: run anything that needs a database, Redis or a port through \`$STACK run [--db dev|test] [--ports] [--heavy] -- <cmd>\` (STACK=${slot.stack}); the slot is leased and released for you.` : ''}` : '',
    cfg.screenshots?.enabled ? `Screenshots folder (for UI changes): ${cfg.screenshots.dir}/` : '',
    languageRule(cfg, 'worker'),
    lessons ? `\nProject lessons (rules from earlier reviews of this project):\n${lessons}` : '',
    note ? `\nNOTE FROM FOCUS HOUR:\n${note}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function settingsFor(p, t) {
  const cmd = kind => `node "${CLI}" hook ${kind}`
  const file = join(p.tasks, `${t.id}.settings.json`)
  writeJson(file, {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('pre') }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('post') }] }],
      PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd('fail') }] }],
    },
  })
  return file
}

export function allowedTools(cfg, slot) {
  const test = cfg.testCommand
  return [
    ...(slot?.stack ? [`Bash(${slot.stack} run:*)`, 'Bash($STACK run:*)', `Bash(${slot.stack} ls)`] : []),
    'Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite',
    `Bash(${test})`, `Bash(${test}:*)`,
    'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git show:*)',
    'Bash(ls:*)', 'Bash(pwd)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(grep:*)', 'Bash(rg:*)',
    ...cfg.worker.allowedTools,
  ]
}

// ---------- worktree ----------

function ensureWorktree(p, cfg, t) {
  const wt = worktreeOf(p, t)
  if (existsSync(wt)) return wt
  mkdirSync(p.worktrees, { recursive: true })
  const hasBranch = git(p.root, 'rev-parse', '--verify', '--quiet', branchOf(t)).code === 0
  const r = hasBranch ? git(p.root, 'worktree', 'add', wt, branchOf(t)) : git(p.root, 'worktree', 'add', '-b', branchOf(t), wt, cfg.baseBranch)
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`)
  if (cfg.worktreeSetup) {
    const s = run('sh', ['-c', cfg.worktreeSetup], { cwd: wt, timeout: 15 * 60_000 })
    if (s.code !== 0) {
      git(p.root, 'worktree', 'remove', '--force', wt) // try again from scratch next time
      throw new Error(`worktreeSetup failed: ${(s.stdout + s.stderr).trim().split('\n').slice(-5).join(' | ').slice(0, 300)}`)
    }
  }
  return wt
}

export function removeWorktree(p, t, { deleteBranch = false } = {}) {
  const wt = worktreeOf(p, t)
  if (existsSync(wt)) git(p.root, 'worktree', 'remove', '--force', wt)
  git(p.root, 'worktree', 'prune')
  if (deleteBranch) git(p.root, 'branch', '-D', branchOf(t))
}

// ---------- one attempt ----------

function runClaude(p, cfg, t, wt, prompt, slot) {
  const lvl = cfg.levels[t.level]
  const args = [
    '-p', prompt,
    '--model', lvl.model,
    '--effort', lvl.effort,
    '--max-turns', String(lvl.maxTurns),
    '--permission-mode', 'dontAsk',
    '--allowedTools', allowedTools(cfg, slot).join(','),
    '--settings', settingsFor(p, t),
    '--add-dir', p.packets,
    '--output-format', 'json',
    '--append-system-prompt', readText(join(PLUGIN_ROOT, 'prompts', 'worker.md')),
    '--max-budget-usd', String(cfg.worker.maxBudgetUsd),
    ...(t.sessionId ? ['--resume', t.sessionId] : []),
  ]
  mkdirSync(p.logs, { recursive: true })
  mkdirSync(p.packets, { recursive: true })
  const env = { ...process.env, ...(slot?.env ?? {}), FOCUS_TASK: t.id, FOCUS_ROOT: p.root, FOCUS_WORKTREE: wt, FOCUS_PACKET: packetOf(p, t) }
  return new Promise(resolve => {
    const child = spawn(cfg.worker.claudeBin, args, { cwd: wt, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', e => resolve({ ok: false, error: String(e), out, err }))
    child.on('close', code => {
      writeFileSync(join(p.logs, `${t.id}-${t.attempts.length + 1}.log`), `exit ${code}\n--- stdout\n${out}\n--- stderr\n${err}\n`)
      let json = null
      try {
        json = JSON.parse(out.trim().split('\n').pop())
      } catch {}
      resolve({ ok: code === 0, code, json, err })
    })
  })
}

export function runTests(cfg, wt, slot) {
  const [bin, args] = slot?.stack ? stackTestArgs(slot.stack, cfg.testCommand) : ['sh', ['-c', cfg.testCommand]]
  const r = run(bin, args, { cwd: wt, env: { ...process.env, ...(slot?.env ?? {}) }, timeout: 30 * 60_000 })
  return { pass: r.code === 0, tail: (r.stdout + r.stderr).trim().split('\n').slice(-25).join('\n') }
}

export function diffChecks(p, cfg, t, wt) {
  const base = git(wt, 'merge-base', cfg.baseBranch, 'HEAD').stdout.trim() || cfg.baseBranch
  const numstat = git(wt, 'diff', '--numstat', base, 'HEAD').stdout.trim().split('\n').filter(Boolean)
  const files = numstat.map(l => {
    const [a, d, f] = l.split('\t')
    return { file: f, added: Number(a) || 0, removed: Number(d) || 0 }
  })
  let testsDelta = 0
  let mocksAdded = 0
  for (const f of files) {
    const patch = git(wt, 'diff', base, 'HEAD', '--', f.file).stdout
    const plus = patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)).join('\n')
    const minus = patch.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).map(l => l.slice(1)).join('\n')
    if (TEST_FILE.test(f.file)) testsDelta += count(TEST_CASE, plus) - count(TEST_CASE, minus)
    mocksAdded += Math.max(0, count(MOCK, plus) - count(MOCK, minus))
  }
  return {
    files: files.map(f => f.file),
    outOfScope: files.map(f => f.file).filter(f => !inScope(f, t.scope) && !(cfg.screenshots?.dir && f.startsWith(`${cfg.screenshots.dir}/`))),
    added: files.reduce((s, f) => s + f.added, 0),
    removed: files.reduce((s, f) => s + f.removed, 0),
    testsDelta,
    mocksAdded,
  }
}

function commitAll(t, wt, cfg) {
  git(wt, 'add', '-A')
  if (cfg?.screenshots?.dir) git(wt, 'reset', '-q', '--', cfg.screenshots.dir, '.env.slot')
  else git(wt, 'reset', '-q', '--', '.env.slot')
  if (git(wt, 'diff', '--cached', '--quiet').code === 0) return false
  const r = git(wt, 'commit', '-q', '-m', `focus(${t.id}): ${t.title}`, '-m', `Focus Hour worker, level ${t.level}.`)
  return r.code === 0
}

function escalateOrStop(p, cfg, t, andon) {
  const up = nextLevel(cfg, t.level)
  const canEscalate = andon.class === 'technical' && cfg.escalate.on.includes(andon.trigger) && t.escalations < cfg.escalate.max && up
  if (canEscalate) {
    const from = t.level
    t.level = up
    t.escalations += 1
    t.status = 'queued'
    t.note = `A previous attempt at ${from} was stopped: ${andon.reason}. You are now running at ${up}; continue from the current state of the worktree.`
    logEvent(p, 'task.escalated', { id: t.id, from, to: up, trigger: andon.trigger })
  } else {
    t.status = 'stopped'
    t.andon = andon
    logEvent(p, 'task.stopped', { id: t.id, trigger: andon.trigger, class: andon.class })
  }
}

export async function runTask(p, cfg, id) {
  let t = getTask(p, id)
  const wt = ensureWorktree(p, cfg, t)
  writeJson(runFile(p, t.id), emptyRun())
  const slot = lease(p, cfg, t.id, id2 => /^reviewer-/.test(id2) || ['running', 'queued'].includes(getTask(p, id2)?.status ?? '') || id2 === t.id)
  if (cfg.slots?.count && !slot) {
    updateTask(p, id, x => (x.status = 'queued'))
    return getTask(p, id)
  }
  const prep = prepare(cfg, wt, slot, p)
  if (!prep.ok) {
    release(p, t.id)
    return updateTask(p, id, x => Object.assign(x, { status: 'stopped', andon: { trigger: 'slot-setup', reason: `slot setup failed: ${prep.tail}`, class: 'safety', at: now() } }))
  }
  const prompt = t.sessionId && t.note ? `NOTE FROM FOCUS HOUR:\n${t.note}\nFinish the task, rewrite the packet file, then end with: done.` : buildPrompt(p, cfg, t, t.note, slot)
  t = updateTask(p, id, x => Object.assign(x, { status: 'running', startedAt: x.startedAt ?? now(), worktree: wt, branch: branchOf(x), note: undefined }))
  logEvent(p, 'task.started', { id, level: t.level })

  const res = await runClaude(p, cfg, t, wt, prompt, slot)
  const finish = () => { teardown(cfg, wt, slot); release(p, id) }
  const runState = readJson(runFile(p, id), emptyRun())
  t = getTask(p, id)
  if (t.status !== 'running') { finish(); return t } // dropped while it ran
  const attempt = { level: t.level, at: now(), costUsd: res.json?.total_cost_usd ?? 0, turns: res.json?.num_turns ?? 0, toolCalls: runState.toolCalls, andon: runState.andon }
  t.attempts.push(attempt)
  t.costUsd = (t.costUsd ?? 0) + attempt.costUsd
  if (res.json?.session_id) t.sessionId = res.json.session_id
  t.run = runState

  if (runState.andon) {
    finish()
    escalateOrStop(p, cfg, t, runState.andon)
    saveTask(p, t)
    return t
  }
  if (!res.json) {
    finish()
    escalateOrStop(p, cfg, t, { trigger: 'crash', reason: `claude exited ${res.code}: ${(res.err || res.error || '').slice(0, 200)}`, class: 'safety', at: now() })
    saveTask(p, t)
    return t
  }

  const tests = runTests(cfg, wt, slot)
  finish()
  if (!tests.pass && cfg.escalate.on.includes('tests-failing') && t.escalations < cfg.escalate.max && nextLevel(cfg, t.level)) {
    escalateOrStop(p, cfg, t, { trigger: 'tests-failing', reason: `\`${cfg.testCommand}\` fails:\n${tests.tail}`, class: 'technical', at: now() })
    saveTask(p, t)
    return t
  }
  const committed = commitAll(t, wt, cfg)
  t.packet = readJson(packetOf(p, t), null)
  for (const l of t.packet?.lessons ?? []) {
    const m = /^\s*\[([^\]]*)\]\s*(.+)$/.exec(String(l))
    addLesson(p, cfg, { scope: m?.[1] ?? '*', rule: m?.[2] ?? l, source: `${t.id}${t.prNumber ? ` (PR #${t.prNumber})` : ''}, from review` })
  }
  t.checks = { ...diffChecks(p, cfg, t, wt), testsPass: tests.pass, testTail: tests.pass ? '' : tests.tail, committed, toolCalls: runState.toolCalls }
  t.status = 'ready'
  t.doneAt = now()
  saveTask(p, t)
  logEvent(p, 'task.done', { id, testsPass: tests.pass, files: t.checks.files.length })
  return t
}

// ---------- PR ----------

const tick = ok => (ok ? '✅' : '⚠️')

export function prBody(t, cfg) {
  const c = t.checks ?? {}
  const lvl = cfg.levels[t.level] ?? {}
  const pk = t.packet ?? {}
  const list = (title, xs) => (xs?.length ? [`**${title}**`, ...xs.map(x => `- ${x}`)] : [])
  return [
    `> Focus Hour task **${t.id}** · level ${t.level} (${lvl.model}/${lvl.effort})${t.escalations ? ` · escalated from ${t.startLevel}` : ''} · $${(t.costUsd ?? 0).toFixed(2)}`,
    '',
    '## Machine checks',
    `- ${tick(!c.outOfScope?.length)} scope: ${t.scope.join(', ') || '(repo)'}${c.outOfScope?.length ? ` — outside: ${c.outOfScope.join(', ')}` : ''}`,
    `- ${tick((c.testsDelta ?? 0) >= 0)} test cases: ${(c.testsDelta ?? 0) >= 0 ? '+' : ''}${c.testsDelta ?? 0}`,
    `- ${tick(!c.mocksAdded)} mocks added: ${c.mocksAdded ?? 0}`,
    `- ${tick((c.added ?? 0) <= cfg.detectors.lineBudget)} diff: +${c.added ?? 0} / -${c.removed ?? 0} in ${c.files?.length ?? 0} file(s)`,
    `- ${tick(c.testsPass)} \`${cfg.testCommand}\` ${c.testsPass ? 'passed' : 'FAILED'}`,
    ...(c.testTail ? ['', '```', c.testTail, '```'] : []),
    '',
    ...(t.review ? ['', '## Review', `- ${t.review.status === 'ok' ? '✅ reviewer: no blockers' : t.review.status === 'blocked' ? '⛔ reviewer: blocked (sent back to the worker)' : '⏳ reviewer running — this PR stays a draft until it finishes'} · why: ${(t.review.reasons ?? []).join('; ')}`] : []),
    ...(t.fixRounds ? [`- fix rounds: ${t.fixRounds}/${cfg.review.maxFixRounds}`] : []),
    ...(t.screenshots?.length ? ['', '## Screenshots', ...t.screenshots] : []),
    '',
    '## Agent claims (not verified)',
    pk.summary ? `- ${pk.summary}` : '- (no packet)',
    ...list('Decisions', pk.decisions),
    ...list('Risks', pk.risks),
    ...list('Out of scope', pk.out_of_scope),
    '',
    '## Context',
    `- based on: ${t.based_on.join(', ') || '-'}${t.feature ? ` · feature ${t.feature}` : ''}`,
    ...(t.stale?.length ? [`- ⚠️ **stale**: ${t.staleReason ?? t.stale.join(', ')} — check the parts that depend on it`] : []),
    t.spec ? `\n<details><summary>Spec</summary>\n\n${t.spec}\n</details>` : '',
  ].join('\n')
}

export const hasGitHub = p => git(p.root, 'remote', 'get-url', 'origin').code === 0 && run('gh', ['--version']).code === 0

// Screenshots the worker left in the screenshots folder: committed once so GitHub can show them, then removed again,
// so the branch's final diff has no PNGs. Returns markdown image lines.
function publishScreenshots(p, cfg, t) {
  const dir = cfg.screenshots?.dir
  if (!cfg.screenshots?.enabled || !dir) return []
  const shots = listDir(join(t.worktree, dir)).filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f))
  if (!shots.length) return []
  git(t.worktree, 'add', '-f', '--', dir)
  if (git(t.worktree, 'commit', '-q', '-m', `focus(${t.id}): screenshots for review`).code !== 0) return []
  const sha = git(t.worktree, 'rev-parse', 'HEAD').stdout.trim()
  git(t.worktree, 'rm', '-rq', '--', dir)
  git(t.worktree, 'commit', '-q', '-m', `focus(${t.id}): remove review screenshots`)
  const slug = repoSlug(p)
  return slug ? shots.map(f => `![${f}](https://github.com/${slug}/blob/${sha}/${dir}/${encodeURIComponent(f)}?raw=true)`) : shots.map(f => `- ${dir}/${f} (commit ${sha.slice(0, 7)})`)
}

export function publish(p, cfg, id) {
  const t = getTask(p, id)
  const reasons = bigReasons(t, cfg)
  const github = t.checks?.committed !== false && hasGitHub(p)
  const needsReview = reasons.length > 0
  if (github) {
    const shots = publishScreenshots(p, cfg, t)
    if (shots.length) t.screenshots = shots
  }
  if (needsReview) t.review = { ...(t.review ?? {}), status: 'pending', reasons, since: t.review?.sha ?? null }
  const bodyFile = join(p.tasks, `${t.id}.pr.md`)
  writeFileSync(bodyFile, prBody(t, cfg))
  if (github) {
    const push = git(t.worktree, 'push', '-u', 'origin', branchOf(t))
    if (push.code === 0) {
      if (t.prNumber) {
        run('gh', ['pr', 'edit', String(t.prNumber), '--body-file', bodyFile], { cwd: p.root })
        const replies = t.packet?.replies ?? []
        if (t.reworkFrom) comment(p, t.prNumber, `**Focus Hour · ${t.id} updated** (${git(t.worktree, 'rev-parse', '--short', 'HEAD').stdout.trim()})${replies.length ? `\n${replies.map(r => `- ${r}`).join('\n')}` : ''}`)
      } else {
        const args = ['pr', 'create', '--base', cfg.baseBranch, '--head', branchOf(t), '--title', `[${t.id}] ${t.title}`, '--body-file', bodyFile]
        if (needsReview) args.push('--draft') // leaves draft when the reviewer finds no blockers
        const r = run('gh', args, { cwd: p.root })
        const url = /https:\/\/\S+\/pull\/(\d+)/.exec(r.stdout + r.stderr)
        if (url) Object.assign(t, { prUrl: url[0], prNumber: Number(url[1]), seenFeedback: [] })
        else t.publishError = (r.stderr || r.stdout).trim().slice(0, 300)
      }
      if (t.prNumber && needsReview) run('gh', ['pr', 'ready', String(t.prNumber), '--undo'], { cwd: p.root })
    } else t.publishError = push.stderr.trim().slice(0, 300)
  }
  t.reworkFrom = undefined
  t.status = 'review'
  t.publishedAt = now()
  saveTask(p, t)
  logEvent(p, 'task.published', { id, pr: t.prNumber ?? null, review: needsReview ? reasons : null })
  return t
}

// ---------- the reviewer ----------

export async function reviewTask(p, cfg, id) {
  // The verdict is about the commit the reviewer was given, never a later one (bach: "ok" on a stale sha).
  const sha = git(getTask(p, id).worktree, 'rev-parse', 'HEAD').stdout.trim()
  let t = updateTask(p, id, x => (x.review = { ...x.review, status: 'running', startedAt: now(), reviewing: sha }))
  const feature = t.feature ? loadFeatures(p).features[t.feature] : null
  // The reviewer gets an environment slot of its own when the repo uses them (e2e checks, screenshots).
  const owner = reviewerName(t)
  const slot = lease(p, cfg, owner, o => o === owner || ['running', 'queued'].includes(getTask(p, o)?.status ?? '') || /^reviewer-/.test(o))
  const prep = slot ? prepare(cfg, t.worktree, slot, p) : { ok: true }
  let res
  try {
    res = await runReviewer(p, cfg, t, { feature, since: t.review.since, slot: prep.ok ? slot : null })
  } finally {
    if (slot) { teardown(cfg, t.worktree, slot); release(p, owner) }
  }
  t = getTask(p, id)
  if (t.status !== 'review') return t // merged, dropped or reworked meanwhile
  const head = git(t.worktree, 'rev-parse', 'HEAD').stdout.trim()
  if (head !== sha) {
    // New commits arrived while it read: look again, at the new diff only.
    t.review = { ...t.review, status: 'pending', since: sha, sessionId: res.sessionId ?? t.review.sessionId }
    saveTask(p, t)
    return t
  }
  if (!res.verdict) {
    t.review = { ...t.review, status: 'error', error: res.error ?? 'no verdict', at: now() }
    saveTask(p, t)
    logEvent(p, 'review.error', { id })
    return t
  }
  const v = res.verdict
  t.review = { ...t.review, status: v.verdict, sha, reviewer: owner, sessionId: res.sessionId ?? t.review.sessionId, blockers: v.blockers, nits: v.nits, summary: v.summary, at: now(), costUsd: (t.review.costUsd ?? 0) + (res.costUsd ?? 0) }
  t.costUsd = (t.costUsd ?? 0) + (res.costUsd ?? 0)
  for (const l of v.lessons) {
    const m = /^\s*\[([^\]]*)\]\s*(.+)$/.exec(String(l))
    addLesson(p, cfg, { scope: m?.[1] ?? '*', rule: m?.[2] ?? l, source: `${t.id}${t.prNumber ? ` (PR #${t.prNumber})` : ''}, reviewer` })
  }
  if (t.prNumber) comment(p, t.prNumber, verdictComment(t, v, t.review.reasons ?? []))
  logEvent(p, 'review.done', { id, verdict: v.verdict, blockers: v.blockers.length })
  if (v.verdict === 'ok') {
    if (t.prNumber) markReady(p, t.prNumber)
  } else if ((t.fixRounds ?? 0) >= cfg.review.maxFixRounds) {
    t.status = 'stopped'
    t.andon = { trigger: 'fix-rounds', reason: `still blocked after ${t.fixRounds} fix rounds — your call`, class: 'safety', at: now() }
  } else {
    t.fixRounds = (t.fixRounds ?? 0) + 1
    t.status = 'queued'
    t.reworkFrom = 'reviewer'
    t.note = `The reviewer blocked this PR. Fix every blocker (inside your scope), then rewrite the packet with "replies":\n${v.blockers.map(b => `- ${typeof b === 'string' ? b : `${b.file ?? ''}${b.line ? `:${b.line}` : ''} ${b.issue ?? ''}${b.fix ? ` → ${b.fix}` : ''}`}`).join('\n')}`
  }
  saveTask(p, t)
  return t
}

// ---------- the watcher: what happened to open PRs on GitHub ----------

export function watchPrs(p, cfg, log = () => {}) {
  if (!hasGitHub(p)) return
  const slug = repoSlug(p)
  for (const t of listTasks(p).filter(x => x.status === 'review' && x.prNumber)) {
    const snap = prSnapshot(p, t.prNumber, slug)
    if (!snap) continue
    if (snap.state === 'MERGED') {
      const early = t.review && ['pending', 'running', 'blocked'].includes(t.review.status)
      removeWorktree(p, t, { deleteBranch: true })
      updateTask(p, t.id, x => Object.assign(x, { status: 'approved', reviewedAt: Date.parse(snap.mergedAt) || now(), mergedOn: 'github', mergedBeforeReview: early || undefined }))
      logEvent(p, 'task.approved', { id: t.id, on: 'github', beforeReview: !!early })
      log(`✅ ${t.id} merged on GitHub${early ? ' (before the review finished)' : ''}`)
      continue
    }
    if (snap.state === 'CLOSED') {
      removeWorktree(p, t, { deleteBranch: true })
      updateTask(p, t.id, x => Object.assign(x, { status: 'dropped', reviewedAt: now() }))
      logEvent(p, 'task.dropped', { id: t.id, on: 'github' })
      continue
    }
    const fresh = newFeedback(t, snap, cfg)
    if (!fresh.length) continue
    const seen = [...(t.seenFeedback ?? []), ...fresh.map(i => i.id)]
    if ((t.fixRounds ?? 0) >= cfg.review.maxFixRounds) {
      updateTask(p, t.id, x => Object.assign(x, { seenFeedback: seen, status: 'stopped', andon: { trigger: 'fix-rounds', reason: `${x.fixRounds} fix rounds on PR #${x.prNumber}; new comments wait for you`, class: 'safety', at: now() } }))
      comment(p, t.prNumber, `**Focus Hour**: ${t.fixRounds} fix rounds already; this one needs a human decision.`)
      continue
    }
    updateTask(p, t.id, x => Object.assign(x, { seenFeedback: seen, status: 'queued', reworkFrom: 'github', fixRounds: (x.fixRounds ?? 0) + 1, note: feedbackNote(t.prNumber, fresh) }))
    logEvent(p, 'task.feedback', { id: t.id, comments: fresh.length })
    log(`💬 ${t.id}: ${fresh.length} comment(s) on PR #${t.prNumber} → rework`)
  }
}

// ---------- smoke check of the base branch, in a child process so the loop never waits on it ----------

let smoking = null
function smokeInBackground(p, cfg, log) {
  if (!cfg.smokeCommand || smoking) return
  smoking = spawn(process.execPath, [CLI, 'smoke', '--if-moved'], { cwd: p.root, env: { ...process.env, FOCUS_ROOT: p.root }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  smoking.stdout.on('data', d => (out += d))
  smoking.on('close', () => {
    smoking = null
    if (out.trim()) log(out.trim().split('\n')[0])
  })
}

// ---------- the loop ----------

// Files you are editing in the main checkout (they lock overlapping task scopes). Focus Hour's own records
// (.focus/, the decision log, ADRs) are written there by Focus itself and never lock anything.
export function dirtyFiles(p) {
  const cfg = loadConfig(p)
  const own = ['.focus/', `${cfg.decisionsDir.replace(/\/$/, '')}/`, `${cfg.adrDir.replace(/\/$/, '')}/`]
  return git(p.root, 'status', '--porcelain', '--untracked-files=all')
    .stdout.split('\n')
    .filter(Boolean)
    .map(l => l.slice(3).replace(/^.* -> /, ''))
    .filter(f => !own.some(o => f.startsWith(o)))
}

function publishReady(p, cfg, log) {
  const ready = listTasks(p).filter(t => t.status === 'ready').sort((a, b) => a.doneAt - b.doneAt)
  for (const t of ready) {
    // A rework of an open PR goes straight back; only new PRs wait for a free review slot.
    if (!t.prNumber && !canPublish(listTasks(p), cfg)) continue
    const done = publish(p, cfg, t.id)
    log(`🔵 ${t.id} ready for review${done.prUrl ? `: ${done.prUrl}` : done.publishError ? ` (local only: ${done.publishError})` : ' (local branch)'}`)
  }
}

export async function loop(p, loadCfg, { once = false, intervalMs = 3000, log = console.log } = {}) {
  const live = new Map()
  const reviews = new Map()
  let lastWatch = 0
  // A task marked running with no process here was orphaned by a previous worker: queue it again.
  for (const t of listTasks(p).filter(x => x.status === 'review' && x.review?.status === 'running')) {
    updateTask(p, t.id, x => (x.review.status = 'pending'))
    release(p, reviewerName(t))
  }
  let warnedTeam = false
  for (const t of listTasks(p).filter(x => x.status === 'running')) {
    updateTask(p, t.id, x => Object.assign(x, { status: 'queued', note: x.sessionId ? 'The worker restarted; continue where you left off.' : undefined }))
  }
  mkdirSync(p.state, { recursive: true })
  writeFileSync(p.workerPid, String(process.pid))
  for (;;) {
    const cfg = loadCfg()
    const tasks = listTasks(p)
    // One executor per repo: while a bach pr-team builds here, Focus Hour starts nothing (both would open PRs and
    // answer the same comments). Reviews and the watcher of PRs it already opened keep going.
    const team = prTeamActive(p.root)
    if (team && !warnedTeam) log(`⏸ bach pr-team "${team.team}" is running here (${team.members.join(', ')}): no new tasks until it shuts down`)
    warnedTeam = !!team
    for (const id of team ? [] : pickRunnable({ tasks, cfg, dirtyFiles: dirtyFiles(p) })) {
      updateTask(p, id, x => (x.status = 'running'))
      log(`▶ ${id} starting`)
      const job = runTask(p, cfg, id)
        .then(t => log(`${t.status === 'ready' ? '✔' : t.status === 'queued' ? '↑' : '🔥'} ${id} → ${t.status}${t.andon ? ` (${t.andon.trigger})` : ''}`))
        .catch(e => {
          updateTask(p, id, x => Object.assign(x, { status: 'stopped', andon: { trigger: 'crash', reason: String(e.message ?? e).slice(0, 300), class: 'safety', at: now() } }))
          log(`🔥 ${id} crashed: ${e.message ?? e}`)
        })
        .finally(() => live.delete(id))
      live.set(id, job)
    }
    publishReady(p, cfg, log)
    // Reviewers on demand: one per big PR, up to review.maxParallel at once, oldest PR first.
    const pending = listTasks(p).filter(t => t.status === 'review' && t.review?.status === 'pending' && !reviews.has(t.id)).sort((a, b) => a.publishedAt - b.publishedAt)
    for (const next of pending.slice(0, Math.max(0, (cfg.review.maxParallel ?? 3) - reviews.size))) {
      {
        log(`🔎 ${reviewerName(next)} ${next.review.sessionId ? 're-checks the fix' : 'started'} (${next.review.reasons.join('; ')})`)
        const job = reviewTask(p, cfg, next.id)
          .then(t => log(`🔎 ${next.id} review: ${t.review?.status}${t.status === 'queued' ? ' → back to the worker' : ''}`))
          .catch(e => log(`🔎 ${next.id} review crashed: ${e.message ?? e}`))
          .finally(() => reviews.delete(next.id))
        reviews.set(next.id, job)
      }
    }
    if (now() - lastWatch >= cfg.watch.intervalSeconds * 1000) {
      lastWatch = now()
      try {
        watchPrs(p, cfg, log)
      } catch (e) {
        log(`watch failed: ${e.message ?? e}`)
      }
    }
    for (const f of advance(p, cfg)) log(`🏁 feature ${f} done${cfg.autoAdvance && cfg.roadmap ? ' · next feature queued for planning' : ''}`)
    smokeInBackground(p, cfg, log)
    if (once) {
      await Promise.all([...live.values(), ...reviews.values()])
      publishReady(p, loadCfg(), log)
      // What was just published still gets its reviewer before --once returns.
      for (const t of listTasks(p).filter(x => x.status === 'review' && x.review?.status === 'pending')) {
        log(`🔎 ${reviewerName(t)} ${t.review.sessionId ? 're-checks the fix' : 'started'}`)
        const r = await reviewTask(p, loadCfg(), t.id)
        log(`🔎 ${t.id} review: ${r.review?.status}${r.status === 'queued' ? ' → back to the worker' : ''}`)
      }
      return
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

