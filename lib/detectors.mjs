// Smoke detectors: settings hooks inside a worker's `claude -p` run (never in the main session).
// PreToolUse exit 2 blocks the call and its stderr goes to the agent.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { readJson, readText, writeJson, logEvent, now } from './util.mjs'
import { runFile } from './tasks.mjs'

export const IRREVERSIBLE = /\bgit\s+push\b|\bgh\s+pr\s+(merge|close)\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f|\bterraform\s+(apply|destroy)\b|\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\bkubectl\s+(delete|apply)\b|\bdrop\s+(table|database)\b/i
export const TEST_FILE = /(^|\/)(test|tests|__tests__|spec)\/|(^|\/)test_[^/]*\.py$|_test\.(go|py)$|\.(test|spec)\.[a-z]+$/
export const TEST_CASE = /\b(test|it)\s*\(|^\s*def\s+test_|^\s*func\s+Test[A-Z]|#\[test\]/gm
// Mocks, stubs, and overwriting a global (`Date.now = …`), which fakes the world just as much.
export const MOCK = /\bmock\b|\bMock\b|\bstub\b|jest\.fn|vi\.fn|MagicMock|monkeypatch|\b(?:Date\.now|Math\.random|globalThis\.\w+|global\.\w+|window\.\w+|process\.env\.\w+)\s*=(?![=>])/g
export const SAFETY = ['scope', 'tests-removed', 'irreversible', 'diff-size']

export const count = (re, text = '') => (String(text).match(re) ?? []).length
const lines = (text = '') => (text === '' ? 0 : String(text).split('\n').length)

export function emptyRun() {
  return { toolCalls: 0, linesWritten: 0, testsDelta: 0, mocksAdded: 0, files: [], errors: {}, maxRepeatedError: 0, andon: null }
}

export function inScope(rel, scope) {
  return scope.some(s => s === '' || rel === s.replace(/\/$/, '') || rel.startsWith(s.endsWith('/') ? s : s + '/') || rel.startsWith(s))
}

// Pure core of the PreToolUse detector: returns { run, deny? }.
// isNewFile(rel): the file does not exist on the base branch, so its tests are the worker's own work in progress.
export function checkPre({ run, task, cfg, tool, input, worktree, packetPath, readFile, isNewFile = () => false }) {
  const r = { ...run, files: [...run.files], errors: { ...run.errors } }
  const stop = (trigger, reason) => {
    r.andon = { trigger, reason, class: SAFETY.includes(trigger) ? 'safety' : 'technical', at: now() }
    return { run: r, deny: `FOCUS-HOUR STOP [${trigger}]: ${reason}. Stop now: do not retry or work around it. End your turn with one line saying what you were trying to do.` }
  }
  if (r.andon) return { run: r, deny: `FOCUS-HOUR STOP: this task is stopped (${r.andon.reason}). End your turn now.` }
  r.toolCalls += 1
  const d = cfg.detectors
  if (r.toolCalls > d.callBudget) return stop('budget', `over the budget of ${d.callBudget} tool calls`)

  if (tool === 'Bash' && IRREVERSIBLE.test(input.command ?? '')) {
    return stop('irreversible', `irreversible command needs the human: ${String(input.command).slice(0, 80)}`)
  }
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const raw = input.file_path ?? input.notebook_path ?? ''
    const abs = isAbsolute(raw) ? raw : resolve(worktree, raw)
    if (packetPath && abs === packetPath) return { run: r }
    const rel = relative(worktree, abs)
    if (rel.startsWith('..') || !inScope(rel, task.scope)) return stop('scope', `wants to edit ${rel.startsWith('..') ? abs : rel}, outside ${task.scope.join(', ') || '(repo)'}`)
    const before =
      tool === 'Edit' ? input.old_string ?? '' : tool === 'MultiEdit' ? (input.edits ?? []).map(e => e.old_string).join('\n') : readFile(abs)
    const after =
      tool === 'Edit' ? input.new_string ?? '' : tool === 'MultiEdit' ? (input.edits ?? []).map(e => e.new_string).join('\n') : input.content ?? input.new_source ?? ''
    if (TEST_FILE.test(rel)) {
      const lost = count(TEST_CASE, before) - count(TEST_CASE, after)
      if (lost > 0 && !isNewFile(rel)) return stop('tests-removed', `removes ${lost} existing test case(s) in ${rel}`)
      r.testsDelta += count(TEST_CASE, after) - count(TEST_CASE, before)
    }
    const written = lines(after)
    if (r.linesWritten + written > d.lineBudget) return stop('diff-size', `diff would pass ${d.lineBudget} written lines`)
    r.linesWritten += written
    r.mocksAdded += Math.max(0, count(MOCK, after) - count(MOCK, before))
    if (!r.files.includes(rel)) r.files.push(rel)
  }
  return { run: r }
}

export function checkFail({ run, cfg, tool, input }) {
  const r = { ...run, errors: { ...run.errors } }
  if (tool !== 'Bash' || r.andon) return { run: r }
  const key = String(input.command ?? '').trim().slice(0, 200)
  r.errors[key] = (r.errors[key] ?? 0) + 1
  r.maxRepeatedError = Math.max(r.maxRepeatedError, r.errors[key])
  if (r.errors[key] >= cfg.detectors.repeatLimit) {
    r.andon = { trigger: 'loop', reason: `the same command failed ${r.errors[key]} times: ${key.slice(0, 60)}`, class: 'technical', at: now() }
  }
  return { run: r }
}

// Entry for `focus hook pre|post|fail`. Returns the exit code.
export function hook(kind, { p, cfg, event }) {
  const id = process.env.FOCUS_TASK
  if (!id) return 0
  const worktree = process.env.FOCUS_WORKTREE ?? event.cwd ?? process.cwd()
  const file = runFile(p, id)
  const run = readJson(file, emptyRun())
  const task = readJson(join(p.tasks, `${id}.json`), null)
  if (!task) return 0
  const observe = cfg.mode === 'observe'
  const tool = event.tool_name
  const input = event.tool_input ?? {}

  if (kind === 'pre') {
    const res = checkPre({
      run, task, cfg, tool, input, worktree, packetPath: process.env.FOCUS_PACKET,
      readFile: f => (existsSync(f) ? readFileSync(f, 'utf8') : ''),
      isNewFile: rel => spawnSync('git', ['-C', worktree, 'cat-file', '-e', `${cfg.baseBranch}:${rel}`]).status !== 0,
    })
    if (res.deny && !run.andon) logEvent(p, observe ? 'detector.would-stop' : 'detector.stop', { id, ...res.run.andon })
    if (res.deny && observe) {
      writeJson(file, { ...res.run, andon: null, observed: [...(run.observed ?? []), res.run.andon] })
      return 0
    }
    writeJson(file, res.run)
    if (res.deny) {
      console.error(res.deny)
      return 2
    }
    return 0
  }
  if (kind === 'fail') {
    const res = checkFail({ run, cfg, tool, input })
    if (res.run.andon && !run.andon) {
      logEvent(p, observe ? 'detector.would-stop' : 'detector.stop', { id, ...res.run.andon })
      if (observe) res.run.andon = null
    }
    writeJson(file, res.run)
    return 0
  }
  if (kind === 'post') {
    // Deliver the inbox (e.g. "D012 changed") once, as context after this tool result.
    const inbox = join(p.inbox, `${id}.md`)
    const text = readText(inbox).trim()
    if (text) {
      renameSync(inbox, `${inbox}.${now()}.delivered`)
      logEvent(p, 'task.inbox-delivered', { id })
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }))
    }
    return 0
  }
  return 0
}
