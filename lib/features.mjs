// Features (pack 1): a roadmap of features, each split into tasks by the focus-plan skill. When every task of a
// feature is merged, the roadmap gets its ✅ and the plan of the next ready feature is queued for the main session.
import { join } from 'node:path'
import { appendRequest } from './decisions.mjs'
import { listTasks } from './tasks.mjs'
import { logEvent, now, readJson, readText, writeJson, writeText } from './util.mjs'

const file = p => join(p.state, 'features.json')
export const loadFeatures = p => readJson(file(p), { current: null, features: {} })
const saveFeatures = (p, f) => writeJson(file(p), f)

// "## F3 · Post page" (also "-", ":" or "—"), with optional "Status: ⬜|✅", "Depends on: F1, F2", "AC: …", "Goal: …".
export function parseRoadmap(text) {
  const out = []
  const parts = String(text).split(/^(?=##\s+F\d+\b)/m)
  for (const part of parts) {
    const head = /^##\s+(F\d+)\s*[·:\-—–]?\s*(.*)$/m.exec(part)
    if (!head) continue
    const body = part.slice(head[0].length)
    const field = re => (re.exec(body)?.[1] ?? '').trim()
    const done = /✅/.test(head[2]) || /status\s*[:|]\s*✅/i.test(body) || /\b(done|merged)\b/i.test(field(/status\s*[:|]\s*(.+)/i))
    out.push({
      id: head[1],
      name: head[2].replace(/[✅⬜]/g, '').trim(),
      done,
      depends: (field(/depends on\s*[:|]\s*(.+)/i).match(/F\d+/g) ?? []),
      ac: (field(/\bAC(?:\s*ids?)?\s*[:|]\s*(.+)/i).match(/[A-Z]+-?\d+/g) ?? []),
      goal: field(/goal\s*[:|]\s*(.+)/i) || body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('|') && !/^(status|depends|ac)\b/i.test(l)) || '',
      body: body.trim(),
    })
  }
  return out
}

export const readRoadmap = (p, cfg) => (cfg.roadmap ? parseRoadmap(readText(join(p.root, cfg.roadmap))) : [])

// The first feature not done whose dependencies are all done.
export function nextReady(roadmap) {
  const done = new Set(roadmap.filter(f => f.done).map(f => f.id))
  return roadmap.find(f => !f.done && f.depends.every(d => done.has(d))) ?? null
}

export function startFeature(p, cfg, id, { name, goal } = {}) {
  const f = loadFeatures(p)
  const fromMap = readRoadmap(p, cfg).find(x => x.id === id)
  f.features[id] = {
    id,
    name: name || fromMap?.name || id,
    goal: goal || fromMap?.goal || '',
    ac: fromMap?.ac ?? [],
    status: 'building',
    startedAt: f.features[id]?.startedAt ?? now(),
  }
  f.current = id
  saveFeatures(p, f)
  logEvent(p, 'feature.started', { id })
  return f.features[id]
}

// Mark the feature's section done in the roadmap: "Status: ⬜" → "Status: ✅", else a ✅ on its heading.
export function markRoadmapDone(p, cfg, id) {
  if (!cfg.roadmap) return false
  const path = join(p.root, cfg.roadmap)
  const text = readText(path)
  if (!text) return false
  const parts = text.split(/^(?=##\s+F\d+\b)/m)
  let changed = false
  const next = parts.map(part => {
    if (!new RegExp(`^##\\s+${id}\\b`).test(part)) return part
    changed = true
    if (/status\s*[:|]\s*⬜/i.test(part)) return part.replace(/(status\s*[:|]\s*)⬜/i, '$1✅')
    return part.replace(/^(##\s+F\d+[^\n]*?)\s*⬜?\s*$/m, (m, h) => (h.includes('✅') ? h : `${h} ✅`))
  })
  if (changed) writeText(path, next.join(''))
  return changed
}

// Called by the worker loop: finish features whose tasks are all merged, then queue the next plan.
export function advance(p, cfg) {
  const f = loadFeatures(p)
  const tasks = listTasks(p)
  const finished = []
  for (const feat of Object.values(f.features)) {
    if (feat.status !== 'building') continue
    const mine = tasks.filter(t => t.feature === feat.id)
    if (!mine.length || !mine.every(t => ['approved', 'dropped'].includes(t.status)) || !mine.some(t => t.status === 'approved')) continue
    feat.status = 'done'
    feat.doneAt = now()
    markRoadmapDone(p, cfg, feat.id)
    logEvent(p, 'feature.done', { id: feat.id, minutes: Math.round((feat.doneAt - feat.startedAt) / 60_000), prs: mine.filter(t => t.status === 'approved').length })
    finished.push(feat.id)
  }
  if (!finished.length) return []
  saveFeatures(p, f)
  if (cfg.autoAdvance && cfg.roadmap) {
    const next = nextReady(readRoadmap(p, cfg).filter(x => !f.features[x.id] || f.features[x.id].status !== 'building'))
    if (next && !f.features[next.id]) {
      appendRequest(p, {
        type: 'prompt',
        about: next.id,
        text: `${finished.join(', ')} is merged and ticked in ${cfg.roadmap}. Use the focus-plan skill to plan the next feature: ${cfg.roadmap}#${next.id} (${next.name}).`,
      })
      logEvent(p, 'feature.next-queued', { id: next.id })
    }
  }
  return finished
}

export function featureStatus(p, cfg) {
  const f = loadFeatures(p)
  const tasks = listTasks(p)
  const roadmap = readRoadmap(p, cfg)
  const ids = [...new Set([...roadmap.map(x => x.id), ...Object.keys(f.features)])]
  return {
    current: f.current,
    roadmap: cfg.roadmap,
    list: ids.map(id => {
      const r = roadmap.find(x => x.id === id)
      const s = f.features[id]
      const mine = tasks.filter(t => t.feature === id)
      return {
        id, name: s?.name ?? r?.name ?? id, goal: s?.goal ?? r?.goal ?? '', ac: s?.ac ?? r?.ac ?? [],
        status: s?.status ?? (r?.done ? 'done' : 'todo'),
        depends: r?.depends ?? [],
        tasks: mine.length, merged: mine.filter(t => t.status === 'approved').length,
      }
    }),
  }
}
