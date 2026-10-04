// Tasks for the background workers: storage, the scheduler's rules, stale marks and the inbox.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { asList, listDir, logEvent, now, readJson, writeJson } from './util.mjs'

export const ACTIVE = ['running']
export const WAITING_REVIEW = ['review']
export const ICON = { paused: '⏸', queued: '⚪', running: '🟢', stopped: '🔥', ready: '🟣', review: '🔵', approved: '✅', dropped: '❌' }

const taskFile = (p, id) => join(p.tasks, `${id}.json`)
export const runFile = (p, id) => join(p.tasks, `${id}.run.json`)

export function listTasks(p) {
  return listDir(p.tasks)
    .filter(f => /^T\d+\.json$/.test(f))
    .map(f => readJson(join(p.tasks, f), null))
    .filter(Boolean)
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
}

export const getTask = (p, id) => readJson(taskFile(p, id), null)
export const saveTask = (p, t) => writeJson(taskFile(p, t.id), t)

export function updateTask(p, id, fn) {
  const t = getTask(p, id)
  if (!t) throw new Error(`No task ${id}`)
  fn(t)
  saveTask(p, t)
  return t
}

export function normScope(s) {
  const x = String(s).trim().replace(/^\.\//, '').replace(/^\/+/, '')
  return x === '.' ? '' : x
}

export function addTask(p, cfg, { title, spec = '', scope, level = 'L2', resources = [], basedOn = [], area }) {
  if (!title) throw new Error('A task needs a title')
  if (!cfg.levels[level]) throw new Error(`Unknown level ${level}; known: ${Object.keys(cfg.levels).join(', ')}`)
  const scopes = asList(scope).map(normScope)
  if (scopes.length === 0) throw new Error('A task needs a scope (path prefixes it may edit), e.g. --scope tests/,docs/')
  for (const r of asList(resources)) if (!(r in cfg.resources)) throw new Error(`Unknown resource ${r}; declare it in .focus/config.json "resources"`)
  const ids = listTasks(p).map(t => Number(t.id.slice(1)))
  const t = {
    id: `T${Math.max(0, ...ids) + 1}`,
    title, spec, scope: scopes, level, startLevel: level, area: area || undefined,
    resources: asList(resources), based_on: asList(basedOn),
    status: 'queued', createdAt: now(), attempts: [], escalations: 0, stale: [], costUsd: 0,
  }
  saveTask(p, t)
  logEvent(p, 'task.added', { id: t.id, level, resources: t.resources })
  return t
}

// ---------- scheduling ----------

export function scopesOverlap(a, b) {
  return a.some(x => b.some(y => x === '' || y === '' || x.startsWith(y) || y.startsWith(x)))
}

// Why a queued task cannot start now, or null when it can. Pure: the worker passes what it sees.
export function blockedReason(task, { tasks, cfg, dirtyFiles = [] }) {
  const running = tasks.filter(t => ACTIVE.includes(t.status))
  const observe = cfg.mode === 'observe'
  if (running.length >= cfg.wip.running) return `${running.length}/${cfg.wip.running} workers busy`
  for (const r of task.resources) {
    const used = running.filter(t => t.resources.includes(r)).length
    if (used >= (cfg.resources[r] ?? 1)) return `${r} busy`
  }
  const clash = running.find(t => scopesOverlap(t.scope, task.scope))
  if (clash) return `scope locked by ${clash.id}`
  const dirty = dirtyFiles.find(f => task.scope.some(s => s === '' || f.startsWith(s)))
  if (dirty) return `scope locked: you are editing ${dirty}`
  // Workers keep going while PRs wait for you: finished work is held as "ready" (committed, not pushed) and only the
  // PRs are capped (canPublish). wip.readyBuffer, when set, caps how much finished work may pile up behind them.
  if (!observe && Number.isFinite(cfg.wip.readyBuffer)) {
    const ready = tasks.filter(t => t.status === 'ready').length
    if (ready >= cfg.wip.readyBuffer) return `finished work piled up (${ready}/${cfg.wip.readyBuffer} ready)`
  }
  return null
}

export function pickRunnable(ctx) {
  const out = []
  const tasks = ctx.tasks.map(t => ({ ...t }))
  for (const t of tasks.filter(x => x.status === 'queued')) {
    if (blockedReason(t, { ...ctx, tasks }) === null) {
      t.status = 'running'
      out.push(t.id)
    }
  }
  return out
}

// A finished task may be published (pushed + PR) while the review queue has room.
export function canPublish(tasks, cfg) {
  if (cfg.mode === 'observe') return true
  return tasks.filter(t => WAITING_REVIEW.includes(t.status)).length < cfg.wip.reviewCap
}

// ---------- stale marks and the inbox ----------

export function markStale(p, decisionIds, reason) {
  const hit = []
  for (const t of listTasks(p)) {
    if (['approved', 'dropped'].includes(t.status)) continue
    const ids = t.based_on.filter(d => decisionIds.includes(d))
    if (ids.length === 0) continue
    t.stale = [...new Set([...(t.stale ?? []), ...ids])]
    t.staleReason = reason
    // Not started yet: wait instead of building on a decision that may be wrong.
    if (t.status === 'queued') {
      t.status = 'paused'
      t.pausedBy = ids
      logEvent(p, 'task.paused', { id: t.id, decisions: ids })
    }
    saveTask(p, t)
    if (t.status === 'running') sendInbox(p, t.id, `Focus Hour notice: ${reason}. Your task is based on ${ids.join(', ')}; adjust if it matters, and say so in the packet's risks.`)
    logEvent(p, 'task.stale', { id: t.id, decisions: ids })
    hit.push(t.id)
  }
  return hit
}

export function sendInbox(p, id, text) {
  mkdirSync(p.inbox, { recursive: true })
  appendFileSync(join(p.inbox, `${id}.md`), text + '\n')
}
