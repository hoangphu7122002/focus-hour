// Environment slots (pack 4): parallel workers each get their own ports and env (a database name, a Redis index…),
// so two of them can run a dev server or tests at once. No daemon: a small lease file, one slot per running task.
import { join } from 'node:path'
import { stackLease, stackPath, stackRelease } from './bach.mjs'
import { logEvent, now, readJson, run, writeJson, writeText } from './util.mjs'

const file = p => join(p.state, 'slots.json')

const fill = (v, slot) => String(v).replaceAll('{slot}', String(slot))

// The env a slot gives: each port is base + slot, each env value has {slot} filled in, plus FOCUS_SLOT.
export function slotEnv(cfg, slot) {
  const env = { FOCUS_SLOT: String(slot) }
  for (const [k, base] of Object.entries(cfg.slots?.ports ?? {})) env[k] = String(Number(base) + slot)
  for (const [k, v] of Object.entries(cfg.slots?.env ?? {})) env[k] = fill(v, slot)
  return env
}

export function lease(p, cfg, taskId, isAlive = () => true) {
  if (!cfg.slots?.count) return null
  const leases = readJson(file(p), {})
  // Slots whose task no longer runs are free again.
  for (const [n, l] of Object.entries(leases)) if (!isAlive(l.task)) delete leases[n]
  const held = Object.entries(leases).find(([, l]) => l.task === taskId)
  if (held) return { slot: Number(held[0]), env: slotEnv(cfg, Number(held[0])), owner: taskId }
  for (let n = 1; n <= cfg.slots.count; n++) {
    if (leases[n]) continue
    leases[n] = { task: taskId, at: now() }
    writeJson(file(p), leases)
    logEvent(p, 'slot.leased', { task: taskId, slot: n })
    return { slot: n, env: slotEnv(cfg, n), owner: taskId }
  }
  return null
}

export function release(p, taskId) {
  const leases = readJson(file(p), {})
  for (const [n, l] of Object.entries(leases)) if (l.task === taskId) delete leases[n]
  writeJson(file(p), leases)
}

// Writes .env.slot in the worktree and runs the slot's setup command there (e.g. clone a dev database).
// With "slots": { "stack": "auto" | path } the repo's stack.toml decides ports and databases: bach's stack CLI
// leases the slot (cloned dev DB, test DB, ports) and writes .env.slot; Focus Hour only caps how many run at once.
export function prepare(cfg, wt, s, p) {
  if (!s) return { ok: true }
  const stack = p && stackPath(p, cfg)
  if (cfg.slots?.stack) {
    if (!stack) return { ok: false, tail: 'stack.toml found but no stack CLI (scripts/stack or the bach plugin)' }
    const r = stackLease(stack, wt, s.owner ?? `focus-${s.slot}`)
    if (!r.ok) return r
    s.env = r.env
    s.stack = stack
    return { ok: true }
  }
  writeText(join(wt, '.env.slot'), Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  if (!cfg.slots.setup) return { ok: true }
  const r = run('sh', ['-c', fill(cfg.slots.setup, s.slot)], { cwd: wt, env: { ...process.env, ...s.env }, timeout: 10 * 60_000 })
  return { ok: r.code === 0, tail: (r.stdout + r.stderr).trim().split('\n').slice(-10).join('\n') }
}

export function teardown(cfg, wt, s) {
  if (s?.stack) return stackRelease(s.stack, wt)
  if (!s || !cfg.slots?.teardown) return
  run('sh', ['-c', fill(cfg.slots.teardown, s.slot)], { cwd: wt, env: { ...process.env, ...s.env }, timeout: 5 * 60_000 })
}
