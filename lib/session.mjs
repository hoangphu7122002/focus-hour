// The hour: start/stop, checkpoint windows, flow, the end-of-hour digest, the resume card and the trial report.
import { join } from 'node:path'
import { checkpointMinutes } from './config.mjs'
import { listDecisions } from './decisions.mjs'
import { blockedReason, listTasks } from './tasks.mjs'
import { iso, listDir, logEvent, now, readEvents, readJson, readText, writeJson, writeText } from './util.mjs'

export const getSession = p => readJson(p.session, null)

export function start(p, cfg, { minutes, mode, difficulty } = {}) {
  const today = iso().slice(0, 10)
  const n = listDir(p.sessions).filter(f => f.startsWith(today)).length + 1
  const s = {
    id: `${today}-${n}`, active: true, startedAt: now(),
    minutes: Number(minutes) || cfg.focusMinutes, mode: mode ?? cfg.mode,
    difficulty: difficulty ? Number(difficulty) : null, pulls: 0,
  }
  writeJson(p.session, s)
  logEvent(p, 'session.start', { minutes: s.minutes, mode: s.mode, difficulty: s.difficulty })
  return s
}

export function checkpointState(p, cfg, at = now()) {
  const s = getSession(p)
  if (!s?.active) return { active: false, inWindow: true, collapsed: false }
  const total = s.minutes * 60_000
  const left = s.startedAt + total - at
  const ats = checkpointMinutes(cfg, s.minutes).map(m => s.startedAt + m * 60_000)
  const win = cfg.checkpointWindowMinutes * 60_000
  const current = ats.findIndex(a => at >= a && at - a <= win)
  const upcoming = ats.findIndex(a => a > at)
  const pulledEarly = (s.pressureWindowUntil ?? 0) > at
  const inWindow = s.mode === 'observe' || current !== -1 || pulledEarly || left <= 0 || at >= ats[ats.length - 1]
  return {
    active: true, id: s.id, mode: s.mode, left, elapsed: at - s.startedAt, minutes: s.minutes,
    current: current + 1, pulledEarly, upcoming: upcoming + 1, inMs: upcoming === -1 ? 0 : ats[upcoming] - at,
    inWindow, overtime: left <= 0,
    collapsed: !inWindow && cfg.paneOutsideCheckpoint !== 'full',
  }
}

const ago = min => (min < 90 ? `${Math.round(min)} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`)

// How hard the pane should ask for you: 0 quiet · 1 waiting · 2 toast · 3 auto-open (an early checkpoint).
export function attention(p, cfg, { tasks, decisions, dirtyFiles = [] }, at = now()) {
  const s = getSession(p)
  const a = cfg.attention
  const review = tasks.filter(t => t.status === 'review')
  const stopped = tasks.filter(t => t.status === 'stopped')
  const openDecisions = decisions.filter(d => d.status === 'draft' || d.status === 'dead')
  const oldestMin = review.length ? Math.max(...review.map(t => (at - (t.publishedAt ?? at)) / 60_000)) : 0
  const full = review.length >= cfg.wip.reviewCap
  const blocked = tasks.filter(t => t.status === 'queued' && /review queue full/.test(blockedReason(t, { tasks, cfg, dirtyFiles }) ?? ''))
  let level = 0
  let reason = ''
  if (review.length || openDecisions.length) {
    level = 1
    reason = [review.length && `${review.length} PR waiting`, openDecisions.length && `${openDecisions.length} decision(s) to confirm`].filter(Boolean).join(' · ')
  }
  if (oldestMin > a.waitWarnMinutes || full) {
    level = 2
    reason = full ? `review queue full (${review.length}/${cfg.wip.reviewCap})` : `a PR has waited ${ago(oldestMin)}`
  }
  if (stopped.length || (full && blocked.length)) {
    level = 3
    reason = stopped.length ? `${stopped.map(t => t.id).join(', ')} stopped, needs your call` : `${blocked.length} task(s) blocked until you review`
  }
  const active = s?.active && s.mode !== 'observe' && a.mode === 'hybrid'
  const gapOk = at - (s?.lastPressureOpenAt ?? 0) >= a.minGapMinutes * 60_000
  return { level, reason, autoOpen: Boolean(active && level === 3 && gapOk) }
}

// The pane opened on pressure: treat the next few minutes as a checkpoint window.
export function notePressureOpen(p, cfg, reason, at = now()) {
  const s = getSession(p)
  if (!s?.active) return false
  writeJson(p.session, { ...s, lastPressureOpenAt: at, pressureWindowUntil: at + cfg.checkpointWindowMinutes * 60_000 })
  logEvent(p, 'pressure.open', { reason })
  return true
}

// Looking at the review queue outside a checkpoint is a "pull" (metric ⑥).
export function notePull(p, cfg, what) {
  const c = checkpointState(p, cfg)
  if (!c.active || c.inWindow) return false
  const s = getSession(p)
  s.pulls = (s.pulls ?? 0) + 1
  writeJson(p.session, s)
  logEvent(p, 'pull', { what })
  return true
}

// ---------- flow ----------

export function setFlow(p, text) {
  writeText(p.flow, `${text.trim()}\n`)
  logEvent(p, 'flow.set', {})
}

export function getFlow(p, cfg) {
  const text = readText(p.flow).trim()
  if (text) return { text, derived: false }
  const ds = listDecisions(p, cfg).filter(d => d.status !== 'superseded' && d.status !== 'rejected').slice(-3)
  const ts = listTasks(p).filter(t => !['approved', 'dropped'].includes(t.status)).slice(-3)
  const parts = [...ds.map(d => `${d.id} ${d.title}`), ...ts.map(t => `${t.id} ${t.title} (${t.status})`)]
  return { text: parts.join(' → ') || '(no flow yet)', derived: true }
}

// ---------- metrics ----------

const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const r1 = x => (x === null ? null : Math.round(x * 10) / 10)

export function metrics(p, cfg, s, until = now()) {
  const from = s.startedAt
  const ev = readEvents(p).filter(e => e.t >= from && e.t <= until)
  const tasks = listTasks(p)
  const reviewed = tasks.filter(t => t.reviewedAt && t.reviewedAt >= from && t.reviewedAt <= until)
  const merged = reviewed.filter(t => t.status === 'approved')
  const stops = ev.filter(e => e.type === 'detector.stop' || e.type === 'detector.would-stop')
  const labels = ev.filter(e => e.type === 'detector.label')
  const captured = ev.filter(e => e.type === 'decision.captured' || e.type === 'decision.reaffirmed')
  const waits = ev.filter(e => e.type === 'turn')
  const predicted = reviewed.filter(t => t.predictionMatch !== undefined && t.predictionMatch !== null)
  const cost = merged.reduce((a, t) => a + (t.costUsd ?? 0), 0)
  return {
    session: s.id, mode: s.mode, difficulty: s.difficulty, minutes: s.minutes,
    reviewLatencyMin: r1(avg(reviewed.filter(t => t.publishedAt).map(t => (t.reviewedAt - t.publishedAt) / 60_000))),
    reviewMinutesPerMerged: r1(avg(merged.filter(t => t.reviewStartedAt).map(t => (t.reviewedAt - t.reviewStartedAt) / 60_000))),
    merged: merged.length,
    dropped: reviewed.filter(t => t.status === 'dropped').length,
    detectorStops: stops.length,
    detectorPrecision: labels.length ? r1((100 * labels.filter(l => l.correct).length) / labels.length) : null,
    predictMatch: predicted.length ? `${predicted.filter(t => t.predictionMatch).length}/${predicted.length}` : null,
    predictSkips: reviewed.filter(t => t.predictionSkipped).length,
    pulls: ev.filter(e => e.type === 'pull').length,
    decisions: ev.filter(e => e.type === 'decision.captured').length,
    questionsPerDecision: r1(avg(captured.map(e => e.questions ?? 1))),
    askRounds: ev.filter(e => e.type === 'ask').length,
    waitOnAiSec: Math.round(waits.reduce((a, e) => a + (e.ms ?? 0), 0) / 1000),
    turns: waits.length,
    costPerMergedUsd: merged.length ? Math.round((cost / merged.length) * 100) / 100 : null,
    escalations: ev.filter(e => e.type === 'task.escalated').length,
  }
}

// ---------- digest + resume card ----------

export function stop(p, cfg, { resumeFrom } = {}) {
  const s = getSession(p)
  if (!s?.active) throw new Error('No active session. Start one with: focus start')
  const end = now()
  const m = metrics(p, cfg, s, end)
  const ds = listDecisions(p, cfg).filter(d => d.session === s.id || (d.created && Date.parse(d.created) >= s.startedAt))
  const open = listDecisions(p, cfg).filter(d => d.status === 'dead' || d.status === 'draft')
  const tasks = listTasks(p).filter(t => t.createdAt >= s.startedAt || (t.reviewedAt ?? 0) >= s.startedAt || !['approved', 'dropped'].includes(t.status))
  const flow = getFlow(p, cfg).text
  const resume = resumeFrom || flow
  const md = [
    `# Focus Hour ${s.id} · ${s.mode} · ${Math.round((end - s.startedAt) / 60_000)}/${s.minutes} min${s.difficulty ? ` · difficulty ${s.difficulty}/5` : ''}`,
    '',
    `**Resume from:** ${resume}`,
    '',
    '## Decisions',
    ...(ds.length ? ds.map(d => `- ${d.id} [${d.status}] ${d.title}${d.why ? ` — ${d.why.split('\n')[0]}` : ''}`) : ['- none']),
    ...(open.length ? ['', '**Open:** ' + open.map(d => `${d.id} (${d.status})`).join(', ')] : []),
    '',
    '## Tasks',
    ...(tasks.length ? tasks.map(t => `- ${t.id} [${t.status}] ${t.title}${t.prUrl ? ` — ${t.prUrl}` : ''}${t.stale?.length ? ' ⚠ stale' : ''}`) : ['- none']),
    '',
    '## Metrics',
    '| metric | value |',
    '|---|---|',
    ...Object.entries(m).map(([k, v]) => `| ${k} | ${v ?? '-'} |`),
    '',
    `<!-- focus-metrics ${JSON.stringify(m)} -->`,
    '',
  ].join('\n')
  const file = join(p.sessions, `${s.id}.md`)
  writeText(file, md)
  writeJson(p.session, { ...s, active: false, endedAt: end, digest: file })
  logEvent(p, 'session.stop', { digest: file })
  return { file, metrics: m }
}

export function lastDigest(p) {
  const files = listDir(p.sessions).filter(f => f.endsWith('.md')).sort()
  if (!files.length) return null
  const file = join(p.sessions, files[files.length - 1])
  const text = readText(file)
  return { file, id: files[files.length - 1].slice(0, -3), resumeFrom: /\*\*Resume from:\*\* (.*)/.exec(text)?.[1] ?? null }
}

export function resumeCard(p, cfg) {
  const last = lastDigest(p)
  const ds = listDecisions(p, cfg)
  const tasks = listTasks(p)
  return {
    last: last ? { id: last.id, resumeFrom: last.resumeFrom } : null,
    needsReview: ds.filter(d => d.status === 'dead').map(d => ({ id: d.id, title: d.title, reason: d.review_reason })),
    drafts: ds.filter(d => d.status === 'draft').map(d => ({ id: d.id, title: d.title })),
    waiting: tasks.filter(t => t.status === 'review').map(t => ({ id: t.id, title: t.title, prUrl: t.prUrl ?? null, stale: (t.stale ?? []).length > 0 })),
    stopped: tasks.filter(t => t.status === 'stopped').map(t => ({ id: t.id, title: t.title, trigger: t.andon?.trigger })),
  }
}

export function report(p) {
  const rows = listDir(p.sessions)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => /<!-- focus-metrics (.*) -->/.exec(readText(join(p.sessions, f)))?.[1])
    .filter(Boolean)
    .map(j => JSON.parse(j))
  const by = mode => rows.filter(r => r.mode === mode)
  const keys = ['reviewLatencyMin', 'reviewMinutesPerMerged', 'merged', 'detectorPrecision', 'predictSkips', 'pulls', 'questionsPerDecision', 'waitOnAiSec', 'costPerMergedUsd', 'escalations', 'difficulty']
  const mean = (rs, k) => {
    const xs = rs.map(r => r[k]).filter(x => typeof x === 'number')
    return xs.length ? r1(avg(xs)) : '-'
  }
  return { rows, table: keys.map(k => ({ metric: k, focus: mean(by('focus'), k), observe: mean(by('observe'), k) })), n: { focus: by('focus').length, observe: by('observe').length } }
}
