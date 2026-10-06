// bach-workflow interop: a repo scoped with bach:demo-scope (roadmap.md, specs/spec.md) and possibly built before
// with bach:pr-team (review-lessons.md, stack.toml) runs under Focus Hour without converting anything.
// Focus Hour only reads bach's files and calls its stack CLI; it never edits bach's plugin or run state.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { readJson, readText, run } from './util.mjs'

const BACH_CACHE = () => join(homedir(), '.claude', 'plugins', 'cache', 'bach-workflow', 'bach')
const semver = v => v.split('.').map(Number)
const newer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0 }

// The stack CLI: the repo's own scripts/stack wins (as in pr-team), else the newest installed bach plugin's.
export function findStack(root) {
  const own = join(root, 'scripts', 'stack')
  if (existsSync(own) && statSync(own).isFile()) return own
  let versions = []
  try { versions = readdirSync(BACH_CACHE()).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(newer) } catch {}
  for (const v of versions.reverse()) {
    const s = join(BACH_CACHE(), v, 'skills', 'pr-team', 'stack', 'stack')
    if (existsSync(s)) return s
  }
  return null
}

// The newest demo-scope run's roadmap (scope/<date>-<slug>/roadmap.md), relative to the repo.
export function findRoadmap(root) {
  const dir = join(root, 'scope')
  let runs = []
  try { runs = readdirSync(dir).filter(d => existsSync(join(dir, d, 'roadmap.md'))).sort() } catch {}
  return runs.length ? relative(root, join(dir, runs.at(-1), 'roadmap.md')) : null
}

const PR_TEAM_LESSONS = '.claude/pr-team/review-lessons.md'

// What `focus init` fills in for a bach repo. Empty object when the repo has nothing of bach.
export function detectBach(root) {
  const out = {}
  const roadmap = findRoadmap(root)
  if (roadmap) out.roadmap = roadmap
  if (existsSync(join(root, PR_TEAM_LESSONS))) out.lessonsFile = PR_TEAM_LESSONS
  if (existsSync(join(root, 'stack.toml'))) {
    const count = Number(/^\s*slots\s*=\s*(\d+)/m.exec(readText(join(root, 'stack.toml')))?.[1] ?? 3)
    out.slots = { stack: 'auto', count: Math.min(count, 5) }
  }
  return out
}

// A pr-team whose builders/watcher run in this repo right now. The team file outlives the team, but after a
// shutdown only the lead is left in it.
export function prTeamActive(root, teamsDir = join(homedir(), '.claude', 'teams')) {
  let teams = []
  try { teams = readdirSync(teamsDir) } catch {}
  for (const t of teams) {
    const cfg = readJson(join(teamsDir, t, 'config.json'), null)
    const members = (cfg?.members ?? []).filter(m => m.name !== 'team-lead' && String(m.cwd ?? '').startsWith(root))
    if (members.length) return { team: t, members: members.map(m => m.name) }
  }
  return null
}

// ---------- slots through the stack CLI ----------

export const stackPath = (p, cfg) => (cfg.slots?.stack === 'auto' ? findStack(p.root) : cfg.slots?.stack ?? null)

const parseEnv = text => Object.fromEntries(String(text).split('\n').map(l => /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2].replace(/^["']|["']$/g, '')]))

// `stack lease` writes .env.slot in the worktree; its env is what the worker and the tests get.
export function stackLease(stack, wt, owner) {
  const r = run(stack, ['lease', owner], { cwd: wt, timeout: 5 * 60_000 })
  if (r.code !== 0) return { ok: false, tail: (r.stdout + r.stderr).trim().split('\n').slice(-5).join('\n') }
  const env = parseEnv(readText(join(wt, '.env.slot')))
  const slot = Number(env.STACK_SLOT ?? /slot (\d+):/.exec(r.stdout)?.[1] ?? 0)
  return { ok: true, slot, env: { ...env, STACK: stack, FOCUS_SLOT: String(slot) } }
}

export function stackRelease(stack, wt) {
  run(stack, ['release'], { cwd: wt, timeout: 5 * 60_000 })
}

// Tests need a slot database: `stack run --db test --heavy` creates it and queues behind the heavy limit.
export const stackTestArgs = (stack, testCommand) => [stack, ['run', '--db', 'test', '--db', 'dev', '--ports', '--heavy', '--', 'sh', '-c', testCommand]]
