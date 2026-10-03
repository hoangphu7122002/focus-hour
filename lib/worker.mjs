// The worker loop: starts queued tasks in their own worktree + headless session, checks the result,
// escalates or stops, then publishes finished work as a PR while the review queue has room.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, nextLevel } from './config.mjs'
import { MOCK, SAFETY, TEST_CASE, TEST_FILE, count, emptyRun, inScope } from './detectors.mjs'
import { canPublish, getTask, listTasks, pickRunnable, runFile, saveTask, updateTask } from './tasks.mjs'
import { git, logEvent, now, readJson, readText, run, writeJson } from './util.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(PLUGIN_ROOT, 'bin', 'focus.mjs')

export const branchOf = t => `focus/${t.id}`
const worktreeOf = (p, t) => join(p.worktrees, t.id)
const packetOf = (p, t) => join(p.packets, `${t.id}.json`)

// ---------- the prompt ----------

export function buildPrompt(p, cfg, t, note) {
  return [
    `FOCUS TASK ${t.id}: ${t.title}`,
    `Your working copy is ${worktreeOf(p, t)} (a git worktree on branch ${branchOf(t)}). Read and edit files ONLY under it, with paths under it; never touch ${p.root}.`,
    t.spec ? `\nSpec:\n${t.spec}` : '',
    `\nAllowed scope (the only paths you may create or edit, relative to the repo root): ${t.scope.map(s => s || '(whole repo)').join(', ')}`,
    `Test command: ${cfg.testCommand}`,
    `Packet file (write it last, absolute path): ${packetOf(p, t)}`,
    `Budget: at most ${cfg.detectors.callBudget} tool calls and ${cfg.detectors.lineBudget} written lines.`,
    t.based_on.length ? `Based on decisions: ${t.based_on.join(', ')} (in ${cfg.decisionsDir}/; read them if relevant).` : '',
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

export function allowedTools(cfg) {
  const test = cfg.testCommand
  return [
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
  return wt
}

export function removeWorktree(p, t, { deleteBranch = false } = {}) {
  const wt = worktreeOf(p, t)
  if (existsSync(wt)) git(p.root, 'worktree', 'remove', '--force', wt)
  git(p.root, 'worktree', 'prune')
  if (deleteBranch) git(p.root, 'branch', '-D', branchOf(t))
}

// ---------- one attempt ----------

function runClaude(p, cfg, t, wt, prompt) {
  const lvl = cfg.levels[t.level]
  const args = [
    '-p', prompt,
    '--model', lvl.model,
    '--effort', lvl.effort,
    '--max-turns', String(lvl.maxTurns),
    '--permission-mode', 'dontAsk',
    '--allowedTools', allowedTools(cfg).join(','),
    '--settings', settingsFor(p, t),
    '--add-dir', p.packets,
    '--output-format', 'json',
    '--append-system-prompt', readText(join(PLUGIN_ROOT, 'prompts', 'worker.md')),
    '--max-budget-usd', String(cfg.worker.maxBudgetUsd),
    ...(t.sessionId ? ['--resume', t.sessionId] : []),
  ]
  mkdirSync(p.logs, { recursive: true })
  mkdirSync(p.packets, { recursive: true })
  const env = { ...process.env, FOCUS_TASK: t.id, FOCUS_ROOT: p.root, FOCUS_WORKTREE: wt, FOCUS_PACKET: packetOf(p, t) }
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

function runTests(cfg, wt) {
  const r = run('sh', ['-c', cfg.testCommand], { cwd: wt, timeout: 30 * 60_000 })
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
    outOfScope: files.map(f => f.file).filter(f => !inScope(f, t.scope)),
    added: files.reduce((s, f) => s + f.added, 0),
    removed: files.reduce((s, f) => s + f.removed, 0),
    testsDelta,
    mocksAdded,
  }
}

function commitAll(t, wt) {
  git(wt, 'add', '-A')
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
  const prompt = t.sessionId && t.note ? `NOTE FROM FOCUS HOUR:\n${t.note}\nFinish the task, rewrite the packet file, then end with: done.` : buildPrompt(p, cfg, t, t.note)
  t = updateTask(p, id, x => Object.assign(x, { status: 'running', startedAt: x.startedAt ?? now(), worktree: wt, branch: branchOf(x), note: undefined }))
  logEvent(p, 'task.started', { id, level: t.level })

  const res = await runClaude(p, cfg, t, wt, prompt)
  const runState = readJson(runFile(p, id), emptyRun())
  t = getTask(p, id)
  if (t.status !== 'running') return t // dropped while it ran
  const attempt = { level: t.level, at: now(), costUsd: res.json?.total_cost_usd ?? 0, turns: res.json?.num_turns ?? 0, toolCalls: runState.toolCalls, andon: runState.andon }
  t.attempts.push(attempt)
  t.costUsd = (t.costUsd ?? 0) + attempt.costUsd
  if (res.json?.session_id) t.sessionId = res.json.session_id
  t.run = runState

  if (runState.andon) {
    escalateOrStop(p, cfg, t, runState.andon)
    saveTask(p, t)
    return t
  }
  if (!res.json) {
    escalateOrStop(p, cfg, t, { trigger: 'crash', reason: `claude exited ${res.code}: ${(res.err || res.error || '').slice(0, 200)}`, class: 'safety', at: now() })
    saveTask(p, t)
    return t
  }

  const tests = runTests(cfg, wt)
  if (!tests.pass && cfg.escalate.on.includes('tests-failing') && t.escalations < cfg.escalate.max && nextLevel(cfg, t.level)) {
    escalateOrStop(p, cfg, t, { trigger: 'tests-failing', reason: `\`${cfg.testCommand}\` fails:\n${tests.tail}`, class: 'technical', at: now() })
    saveTask(p, t)
    return t
  }
  const committed = commitAll(t, wt)
  t.packet = readJson(packetOf(p, t), null)
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
    '## Agent claims (not verified)',
    pk.summary ? `- ${pk.summary}` : '- (no packet)',
    ...list('Decisions', pk.decisions),
    ...list('Risks', pk.risks),
    ...list('Out of scope', pk.out_of_scope),
    '',
    '## Context',
    `- based on: ${t.based_on.join(', ') || '-'}`,
    ...(t.stale?.length ? [`- ⚠️ **stale**: ${t.staleReason ?? t.stale.join(', ')} — check the parts that depend on it`] : []),
    t.spec ? `\n<details><summary>Spec</summary>\n\n${t.spec}\n</details>` : '',
  ].join('\n')
}

export const hasGitHub = p => git(p.root, 'remote', 'get-url', 'origin').code === 0 && run('gh', ['--version']).code === 0

export function publish(p, cfg, id) {
  const t = getTask(p, id)
  const body = prBody(t, cfg)
  const bodyFile = join(p.tasks, `${t.id}.pr.md`)
  writeFileSync(bodyFile, body)
  if (t.checks?.committed !== false && hasGitHub(p)) {
    const push = git(t.worktree, 'push', '-u', 'origin', branchOf(t))
    if (push.code === 0) {
      if (t.prNumber) {
        run('gh', ['pr', 'edit', String(t.prNumber), '--body-file', bodyFile], { cwd: p.root })
      } else {
        const r = run('gh', ['pr', 'create', '--base', cfg.baseBranch, '--head', branchOf(t), '--title', `[${t.id}] ${t.title}`, '--body-file', bodyFile], { cwd: p.root })
        const url = /https:\/\/\S+\/pull\/(\d+)/.exec(r.stdout + r.stderr)
        if (url) Object.assign(t, { prUrl: url[0], prNumber: Number(url[1]) })
        else t.publishError = (r.stderr || r.stdout).trim().slice(0, 300)
      }
    } else t.publishError = push.stderr.trim().slice(0, 300)
  }
  t.status = 'review'
  t.publishedAt = now()
  saveTask(p, t)
  logEvent(p, 'task.published', { id, pr: t.prNumber ?? null })
  return t
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
    if (!canPublish(listTasks(p), cfg)) break
    const done = publish(p, cfg, t.id)
    log(`🔵 ${t.id} ready for review${done.prUrl ? `: ${done.prUrl}` : done.publishError ? ` (local only: ${done.publishError})` : ' (local branch)'}`)
  }
}

export async function loop(p, loadCfg, { once = false, intervalMs = 3000, log = console.log } = {}) {
  const live = new Map()
  // A task marked running with no process here was orphaned by a previous worker: queue it again.
  for (const t of listTasks(p).filter(x => x.status === 'running')) {
    updateTask(p, t.id, x => Object.assign(x, { status: 'queued', note: x.sessionId ? 'The worker restarted; continue where you left off.' : undefined }))
  }
  mkdirSync(p.state, { recursive: true })
  writeFileSync(p.workerPid, String(process.pid))
  for (;;) {
    const cfg = loadCfg()
    const tasks = listTasks(p)
    for (const id of pickRunnable({ tasks, cfg, dirtyFiles: dirtyFiles(p) })) {
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
    if (once) {
      await Promise.all(live.values())
      publishReady(p, loadCfg(), log)
      return
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

