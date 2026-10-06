// Guardrails for a project that starts from zero: review lessons, a smoke check of the base branch after every
// merge, the language rule, and a doctor that says what is missing before the first hour.
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { prTeamActive, stackPath } from './bach.mjs'
import { git, logEvent, now, readJson, readText, run, writeJson, writeText } from './util.mjs'

// ---------- lessons: what reviews taught, read by every worker before it starts ----------

export function readLessons(p, cfg) {
  return readText(join(p.root, cfg.lessonsFile)).trim()
}

// line: "- [scope] rule — source"; skipped when the same rule is already there.
export function addLesson(p, cfg, { scope = '*', rule, source }) {
  const clean = String(rule ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return false
  const file = join(p.root, cfg.lessonsFile)
  const text = readText(file)
  if (text.toLowerCase().includes(clean.toLowerCase())) return false
  const head = text ? '' : '# Review lessons\n\nRules learned from reviews. Workers read them before they start. Edit freely.\n\n'
  writeText(file, `${text}${head}- [${scope}] ${clean}${source ? ` — ${source}` : ''}\n`)
  logEvent(p, 'lesson.added', { scope, source })
  return true
}

export function lessonsForPrompt(p, cfg, scope = []) {
  const lines = readLessons(p, cfg).split('\n').filter(l => l.startsWith('- ['))
  const relevant = lines.filter(l => {
    const s = /^- \[([^\]]*)\]/.exec(l)?.[1] ?? '*'
    return s === '*' || s === 'all' || scope.length === 0 || scope.some(x => x === '' || x.startsWith(s) || s.startsWith(x))
  })
  return relevant.slice(-40).join('\n')
}

// ---------- language ----------

const NAMES = { vi: 'Vietnamese', en: 'English', ja: 'Japanese', fr: 'French', de: 'German', es: 'Spanish', zh: 'Chinese', ko: 'Korean' }
const name = code => NAMES[code] ?? code

export function languageRule(cfg, who = 'main') {
  const { chat, code } = cfg.language ?? {}
  const parts = []
  if (chat && who === 'main') parts.push(`Talk to the user in ${name(chat)}.`)
  if (code) parts.push(`Write code, comments, commit messages, PR titles and bodies, and docs in ${name(code)}.`)
  return parts.join(' ')
}

// ---------- smoke check of the base branch ----------

export const smokeFile = p => join(p.state, 'smoke.json')

// A dedicated worktree on the base branch that only Focus Hour uses; reset to the latest base before each run.
function smokeWorktree(p, cfg) {
  const wt = join(p.worktrees, '_smoke')
  if (!existsSync(wt)) {
    mkdirSync(p.worktrees, { recursive: true })
    const r = git(p.root, 'worktree', 'add', '--detach', wt, cfg.baseBranch)
    if (r.code !== 0) throw new Error(`smoke worktree: ${r.stderr.trim()}`)
  }
  return wt
}

export function baseHead(p, cfg) {
  const hasRemote = git(p.root, 'remote', 'get-url', 'origin').code === 0
  if (hasRemote) {
    const r = git(p.root, 'ls-remote', 'origin', `refs/heads/${cfg.baseBranch}`)
    const sha = r.stdout.split(/\s/)[0]
    if (sha) return { sha, ref: `origin/${cfg.baseBranch}`, remote: true }
  }
  return { sha: git(p.root, 'rev-parse', cfg.baseBranch).stdout.trim(), ref: cfg.baseBranch, remote: false }
}

// Runs the smoke command when the base branch moved since the last run. Returns the result, or null when skipped.
export function smokeIfMoved(p, cfg, { force = false } = {}) {
  if (!cfg.smokeCommand) return null
  const last = readJson(smokeFile(p), null)
  const head = baseHead(p, cfg)
  if (!head.sha || (!force && last?.sha === head.sha)) return null
  const wt = smokeWorktree(p, cfg)
  if (head.remote) git(wt, 'fetch', '-q', 'origin', cfg.baseBranch)
  git(wt, 'checkout', '-q', '--detach', head.remote ? `origin/${cfg.baseBranch}` : cfg.baseBranch)
  git(wt, 'clean', '-fdq', '-e', 'node_modules', '-e', '.venv')
  const started = now()
  const r = run('sh', ['-c', cfg.smokeCommand], { cwd: wt, timeout: 30 * 60_000 })
  const result = { sha: head.sha, pass: r.code === 0, at: now(), seconds: Math.round((now() - started) / 1000), tail: (r.stdout + r.stderr).trim().split('\n').slice(-30).join('\n') }
  writeJson(smokeFile(p), result)
  logEvent(p, result.pass ? 'smoke.pass' : 'smoke.fail', { sha: head.sha.slice(0, 7), seconds: result.seconds })
  return result
}

// ---------- doctor ----------

const ok = (label, detail = '') => ({ level: 'ok', label, detail })
const warn = (label, detail = '') => ({ level: 'warn', label, detail })
const bad = (label, detail = '') => ({ level: 'bad', label, detail })

export function doctor(p, cfg, { quick = false } = {}) {
  const out = []
  const isRepo = git(p.root, 'rev-parse', '--is-inside-work-tree').code === 0
  out.push(isRepo ? ok('git repository') : bad('git repository', 'run git init'))
  if (!isRepo) return out
  out.push(git(p.root, 'rev-parse', '--verify', '--quiet', cfg.baseBranch).code === 0 ? ok(`base branch ${cfg.baseBranch}`) : bad(`base branch ${cfg.baseBranch}`, 'set baseBranch in .focus/config.json or create it'))
  const origin = git(p.root, 'remote', 'get-url', 'origin')
  if (origin.code !== 0) out.push(warn('GitHub remote', 'no origin: tasks stay local branches, no PRs, no comment loop'))
  else {
    out.push(ok('GitHub remote', origin.stdout.trim()))
    const auth = run('gh', ['auth', 'status'])
    out.push(auth.code === 0 ? ok('gh logged in') : bad('gh logged in', 'run gh auth login'))
  }
  const claude = run(cfg.worker.claudeBin, ['--version'])
  const v = /(\d+)\.(\d+)\.(\d+)/.exec(claude.stdout)
  const atLeast = v && (Number(v[1]) > 2 || (Number(v[1]) === 2 && (Number(v[2]) > 1 || (Number(v[2]) === 1 && Number(v[3]) >= 288))))
  out.push(!v ? bad('claude CLI', `${cfg.worker.claudeBin} not found`) : atLeast ? ok('claude CLI', v[0]) : warn('claude CLI', `${v[0]} < 2.1.288: run claude update (mods need it)`))
  out.push(run('node', ['--version']).code === 0 ? ok('node') : bad('node', 'install Node ≥ 18'))
  out.push(cfg.language?.chat ? ok('language', `chat ${cfg.language.chat} · code ${cfg.language.code}`) : warn('language', 'set "language": { "chat": "vi", "code": "en" } so nobody has to repeat it'))
  out.push(cfg.smokeCommand ? ok('smoke check after merges', cfg.smokeCommand) : warn('smoke check after merges', 'set "smokeCommand" (e.g. "make check") so a broken main shows up at once'))
  out.push(cfg.roadmap ? (existsSync(join(p.root, cfg.roadmap)) ? ok('roadmap', cfg.roadmap) : bad('roadmap', `${cfg.roadmap} not found`)) : warn('roadmap', 'optional: set "roadmap" to plan features with /focus-plan'))
  // `make check` may start docker inside its recipe: look at the targets it names too.
  const make = readText(join(p.root, 'Makefile'))
  const recipe = t => (new RegExp(`^${t}:.*\\n((?:\\t.*\\n?)*)`, 'm').exec(make)?.[1] ?? '')
  const cmds = [cfg.testCommand, cfg.smokeCommand].filter(Boolean).map(c => `${c} ${[...c.matchAll(/make\s+([\w-]+)/g)].map(m => recipe(m[1])).join(' ')}`).join(' ')
  if (/docker|compose/i.test(cmds) && cfg.infraGuard) out.push(warn('infra guard', 'your test/smoke command starts docker; workers are blocked from docker, so run infra yourself first'))
  if (!quick) {
    const r = run('sh', ['-c', cfg.testCommand], { cwd: p.root, timeout: 15 * 60_000 })
    out.push(r.code === 0 ? ok('test command passes', cfg.testCommand) : bad('test command passes', `${cfg.testCommand} fails: ${(r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | ').slice(0, 200)}`))
  }
  const dirty = git(p.root, 'status', '--porcelain').stdout.split('\n').filter(l => l && !l.slice(3).startsWith('.focus/'))
  out.push(dirty.length ? warn('clean checkout', `${dirty.length} changed file(s) lock overlapping task scopes`) : ok('clean checkout'))
  if (cfg.slots?.stack) {
    const s = stackPath(p, cfg)
    out.push(s ? ok('stack CLI (bach)', s) : bad('stack CLI (bach)', 'stack.toml needs scripts/stack or the bach plugin installed'))
  }
  const team = prTeamActive(p.root)
  if (team) out.push(warn('bach pr-team', `team ${team.team} is running here (${team.members.join(', ')}): Focus Hour starts no tasks until it shuts down`))
  out.push(existsSync(join(homedir(), '.claude')) ? ok('Claude Code configured') : bad('Claude Code configured', 'run claude once and log in'))
  return out
}

export function renderDoctor(rows) {
  const icon = { ok: '✅', warn: '⚠️ ', bad: '❌' }
  return rows.map(r => `${icon[r.level]} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`).join('\n')
}
