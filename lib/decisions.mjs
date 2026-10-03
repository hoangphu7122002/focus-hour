// The decision log: docs/decisions/D###.md, captured from AskUserQuestion, with an impact graph.
import { join } from 'node:path'
import { asList, iso, listDir, logEvent, parseFrontmatter, readJson, readText, stringifyFrontmatter, writeJson, writeText } from './util.mjs'
import { listTasks, markStale, saveTask } from './tasks.mjs'

const FIELDS = ['id', 'title', 'area', 'status', 'prev_status', 'depends_on', 'supersedes', 'superseded_by', 'question', 'chosen', 'rejected', 'evidence', 'adr', 'review_reason', 'session', 'created']
const ID = /^D(\d+)$/
const PLACEHOLDER = '(to fill: plain-language reason)'

const dir = (p, cfg) => join(p.root, cfg.decisionsDir)
const file = (p, cfg, id) => join(dir(p, cfg), `${id}.md`)

export function listDecisions(p, cfg) {
  return listDir(dir(p, cfg))
    .filter(f => /^D\d+\.md$/.test(f))
    .map(f => readDecision(p, cfg, f.slice(0, -3)))
    .filter(Boolean)
    .sort((a, b) => num(a.id) - num(b.id))
}

const num = id => Number(ID.exec(id)?.[1] ?? 0)

export function readDecision(p, cfg, id) {
  const text = readText(file(p, cfg, id), null)
  if (text === null) return null
  const { data, body } = parseFrontmatter(text)
  return {
    ...data,
    status: data.status === 'needs-review' ? 'dead' : data.status, // v0.1.5 files
    id: data.id ?? id,
    depends_on: asList(data.depends_on),
    rejected: asList(data.rejected),
    why: body.replace(/^Why[^:]*:\s*/i, '').replace(PLACEHOLDER, '').trim(),
  }
}

export function writeDecision(p, cfg, d) {
  const data = {}
  for (const k of FIELDS) if (d[k] !== undefined && d[k] !== null && !(Array.isArray(d[k]) && d[k].length === 0 && k !== 'depends_on')) data[k] = d[k]
  data.depends_on = d.depends_on ?? []
  writeText(file(p, cfg, d.id), stringifyFrontmatter(data, `Why: ${d.why || PLACEHOLDER}`))
  return d
}

export function nextId(p, cfg, taken = []) {
  const max = Math.max(0, ...listDecisions(p, cfg).map(d => num(d.id)), ...taken.map(num))
  return `D${String(max + 1).padStart(3, '0')}`
}

// ---------- capture from AskUserQuestion ----------

// payload: { questions, answers, tags?, session? } as the mod hands them over.
// tags: one per question: "new", "new:<slug>", "D012", or "-" (not a decision).
export function capture(p, cfg, payload) {
  const questions = payload.questions ?? []
  const answers = payload.answers ?? {}
  const tags = payload.tags
  const area = payload.area || undefined
  if (!tags && !cfg.captureUntagged) return []
  const groups = new Map()
  questions.forEach((q, i) => {
    const answer = answers[q.question]
    if (answer === undefined || answer === null || answer === '') return
    const tag = (tags?.[i] ?? 'new').trim()
    if (tag === '-' || tag === '') return
    const key = tag === 'new' ? `new#${i}` : tag
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ q, answer: String(answer) })
  })

  const out = []
  const taken = []
  for (const [key, items] of groups) {
    const chosen = items.length === 1 ? items[0].answer : items.map(x => `${x.q.header || x.q.question}: ${x.answer}`).join('; ')
    const picked = new Set(items.flatMap(x => x.answer.split(',').map(s => s.trim())))
    const rejected = items.flatMap(x => (x.q.options ?? []).map(o => o.label).filter(l => !picked.has(l)))
    const question = items.map(x => x.q.question).join(' / ')
    const title = items.length === 1 ? `${items[0].q.header || 'Decision'}: ${items[0].answer}`.slice(0, 80) : `${key.replace(/^new:/, '')}: ${chosen}`.slice(0, 80)

    if (ID.test(key)) {
      const old = readDecision(p, cfg, key)
      if (old && old.chosen === chosen) {
        logEvent(p, 'decision.reaffirmed', { id: key, questions: items.length })
        out.push({ id: key, action: 'reaffirmed' })
        continue
      }
      const id = nextId(p, cfg, taken)
      taken.push(id)
      writeDecision(p, cfg, {
        id, title, area: old?.area, status: 'draft', depends_on: old?.depends_on ?? [], supersedes: old ? key : undefined,
        question, chosen, rejected, session: payload.session, created: iso(),
      })
      logEvent(p, 'decision.captured', { id, questions: items.length, supersedes: key })
      out.push({ id, action: 'supersedes', of: key })
      if (old) out.push(...supersede(p, cfg, key, id).map(x => ({ ...x, action: 'impact' })))
      continue
    }
    const id = nextId(p, cfg, taken)
    taken.push(id)
    writeDecision(p, cfg, { id, title, area, status: 'draft', depends_on: [], question, chosen, rejected, session: payload.session, created: iso() })
    logEvent(p, 'decision.captured', { id, questions: items.length })
    out.push({ id, action: 'new' })
  }
  return out
}

// ---------- graph ----------

export function dependents(all, id) {
  return all.filter(d => d.depends_on.includes(id) && d.status !== 'superseded' && d.status !== 'rejected')
}

// Every decision that transitively depends on `id`, as a tree [{ d, children }].
export function impactTree(all, id, seen = new Set([id])) {
  return dependents(all, id)
    .filter(d => !seen.has(d.id) && seen.add(d.id))
    .map(d => ({ d, children: impactTree(all, d.id, seen) }))
}

const flatten = tree => tree.flatMap(n => [n.d, ...flatten(n.children)])

// A decision changed (superseded or edited): dependents need review, tasks built on it go stale.
export function propagate(p, cfg, id, reason) {
  const all = listDecisions(p, cfg)
  const affected = flatten(impactTree(all, id))
  for (const d of affected) {
    if (d.status === 'active' || d.status === 'draft') {
      writeDecision(p, cfg, { ...d, status: 'dead', prev_status: d.status, review_reason: reason })
      logEvent(p, 'decision.dead', { id: d.id, because: id })
    }
  }
  const stale = markStale(p, [id, ...affected.map(d => d.id)], reason)
  return [...affected.map(d => ({ id: d.id, kind: 'decision' })), ...stale.map(t => ({ id: t, kind: 'task' }))]
}

export function supersede(p, cfg, oldId, newId) {
  const old = readDecision(p, cfg, oldId)
  if (!old) return []
  const neu = readDecision(p, cfg, newId)
  writeDecision(p, cfg, { ...old, status: 'superseded', superseded_by: newId })
  if (neu && !neu.supersedes) writeDecision(p, cfg, { ...neu, supersedes: oldId })
  logEvent(p, 'decision.superseded', { id: oldId, by: newId })
  // What built on the old decision stays attached to it as a dead branch until revived or re-decided.
  return propagate(p, cfg, oldId, `${oldId} changed: ${old.chosen ?? ''} → ${neu?.chosen ?? ''} (${newId})`)
}

// ---------- edits ----------

export function edit(p, cfg, id, changes) {
  const d = readDecision(p, cfg, id)
  if (!d) throw new Error(`No decision ${id}`)
  const next = { ...d }
  if (changes.title) next.title = changes.title
  if (changes.why) next.why = changes.why
  if (changes.evidence) next.evidence = changes.evidence
  if (changes.depends) next.depends_on = asList(changes.depends).filter(x => x !== id)
  if (changes.question) next.question = changes.question
  if (changes.area) next.area = changes.area
  const chosenChanged = changes.chosen !== undefined && changes.chosen !== d.chosen
  if (chosenChanged) next.chosen = changes.chosen
  writeDecision(p, cfg, next)
  logEvent(p, 'decision.edited', { id, fields: Object.keys(changes) })
  const impact = chosenChanged && d.status !== 'draft' ? propagate(p, cfg, id, `${id} changed: ${d.chosen} → ${changes.chosen}`) : []
  return { decision: next, impact }
}

export function setStatus(p, cfg, id, status, event) {
  const d = readDecision(p, cfg, id)
  if (!d) throw new Error(`No decision ${id}`)
  const next = { ...d, status }
  if (status === 'active') delete next.review_reason
  writeDecision(p, cfg, next)
  logEvent(p, event, { id })
  return next
}

export function promote(p, cfg, id) {
  const d = readDecision(p, cfg, id)
  if (!d) throw new Error(`No decision ${id}`)
  const adrDir = join(p.root, cfg.adrDir)
  const nums = listDir(adrDir).map(f => Number(/^(\d+)/.exec(f)?.[1] ?? 0))
  const n = String(Math.max(0, ...nums) + 1).padStart(4, '0')
  const slug = (d.title ?? id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
  const name = `${n}-${slug}.md`
  const rel = `${cfg.adrDir}/${name}`
  writeText(
    join(adrDir, name),
    `# ADR-${n}: ${d.title}\n\n## Status\n\nAccepted (${iso().slice(0, 10)}). Promoted from [${id}](../${cfg.decisionsDir.split('/').slice(1).join('/') || 'decisions'}/${id}.md).\n\n` +
      `## Context\n\n${d.question ?? ''}\n\n## Decision\n\n${d.chosen ?? ''}\n\nRejected: ${(d.rejected ?? []).join(', ') || '-'}\n\n## Consequences\n\n${d.why}\n`,
  )
  writeDecision(p, cfg, { ...d, adr: rel })
  logEvent(p, 'decision.promoted', { id, adr: rel })
  return rel
}

export function renderTree(tree, indent = '   ') {
  return tree.flatMap((n, i) => {
    const last = i === tree.length - 1
    return [`${indent}${last ? '└─' : '├─'} ${n.d.id} ${n.d.title ?? ''}  [${n.d.status}]`, ...renderTree(n.children, indent + (last ? '   ' : '│  '))]
  })
}

export const isOpenDecision = d => d.status === 'draft' || d.status === 'dead'

// The live replacement of a decision: follow "superseded by" to the end of the chain.
export function latest(all, id, seen = new Set()) {
  const d = all.find(x => x.id === id)
  if (!d || d.status !== 'superseded' || !d.superseded_by || seen.has(id)) return id
  seen.add(id)
  return latest(all, d.superseded_by, seen)
}

// "Still holds": a dead decision comes back, now built on the replacements of what it built on.
export function revive(p, cfg, id) {
  const all = listDecisions(p, cfg)
  const d = all.find(x => x.id === id)
  if (!d) throw new Error(`No decision ${id}`)
  if (d.status !== 'dead') return d
  const next = { ...d, status: d.prev_status === 'draft' ? 'draft' : 'active', depends_on: [...new Set(d.depends_on.map(x => latest(all, x)))] }
  delete next.prev_status
  delete next.review_reason
  writeDecision(p, cfg, next)
  logEvent(p, 'decision.revived', { id })
  resumePaused(p, cfg)
  return next
}

// Queued tasks paused by a dead branch go back to the queue once nothing they rely on is dead.
export function resumePaused(p, cfg) {
  const dead = new Set(listDecisions(p, cfg).filter(x => x.status === 'dead').map(x => x.id))
  const back = []
  for (const t of listTasks(p)) {
    if (t.status !== 'paused' || t.based_on.some(b => dead.has(b))) continue
    saveTask(p, { ...t, status: 'queued', pausedBy: undefined })
    logEvent(p, 'task.unpaused', { id: t.id })
    back.push(t.id)
  }
  return back
}

// "Re-decide": ask the main session (through the mod) to grill this one decision again.
export function requestRedecide(p, cfg, id) {
  const d = readDecision(p, cfg, id)
  if (!d) throw new Error(`No decision ${id}`)
  const text = `Use the focus-grill skill to re-decide ${id} (${d.title}). It was built on a decision that changed (${d.review_reason ?? 'see the Focus map'}). ` +
    `Ask again with the options that make sense now, tagged \`${id}\` so the new answer replaces it.`
  appendRequest(p, { type: 'prompt', text, about: id })
  logEvent(p, 'decision.redecide-requested', { id })
  return text
}

export function appendRequest(p, req) {
  const file = join(p.state, 'requests.json')
  const list = readJson(file, [])
  list.push({ id: `R${Date.now()}`, at: Date.now(), ...req })
  writeJson(file, list)
}

export function takeRequests(p) {
  return readJson(join(p.state, 'requests.json'), [])
}

export function doneRequest(p, rid) {
  const file = join(p.state, 'requests.json')
  writeJson(file, readJson(file, []).filter(r => r.id !== rid))
}
