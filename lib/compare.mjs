// `focus compare`: the same numbers for any GitHub repos (a bach run, a Focus Hour run, a hand-made project), plus the
// Focus Hour–only numbers of this repo, so "does the method work" is a table, not an impression.
import { join } from 'node:path'
import { listTasks } from './tasks.mjs'
import { listDir, readEvents, readText, run } from './util.mjs'

const median = xs => {
  const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b)
  if (!s.length) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const r1 = x => (x === null ? null : Math.round(x * 10) / 10)
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-')

export function githubStats(repo, { since } = {}) {
  const r = run('gh', ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '300', '--json', 'number,state,createdAt,mergedAt,additions,deletions,changedFiles,labels,comments,reviews,author'])
  if (r.code !== 0) return { repo, error: (r.stderr || r.stdout).trim().slice(0, 200) }
  let prs = JSON.parse(r.stdout)
  if (since) prs = prs.filter(x => x.createdAt >= since)
  const merged = prs.filter(x => x.mergedAt)
  const minutes = merged.map(x => (Date.parse(x.mergedAt) - Date.parse(x.createdAt)) / 60_000)
  const human = x => !/\[bot\]$/.test(x.author?.login ?? '')
  const withHumanFeedback = merged.filter(x => [...(x.comments ?? []), ...(x.reviews ?? [])].some(c => human(c) && !String(c.body ?? '').includes('focus-hour') && !/^(pre-review|\*\*Focus Hour)/i.test(String(c.body ?? '').trim()) && String(c.body ?? '').trim()))
  const reviewedLabelEarly = merged.filter(x => (x.labels ?? []).some(l => /running|pending/i.test(l.name)))
  const span = merged.length ? (Math.max(...merged.map(x => Date.parse(x.mergedAt))) - Math.min(...merged.map(x => Date.parse(x.createdAt)))) / 3_600_000 : 0
  return {
    repo,
    prs: prs.length,
    merged: merged.length,
    medianOpenToMergeMin: r1(median(minutes)),
    medianChangedLines: median(merged.map(x => (x.additions ?? 0) + (x.deletions ?? 0))),
    prsWithHumanComments: pct(withHumanFeedback.length, merged.length),
    mergedWithReviewStillRunning: reviewedLabelEarly.length,
    mergedPerHour: span ? r1(merged.length / span) : null,
  }
}

// Numbers only Focus Hour records, from this repo's tasks and event log.
export function focusStats(p) {
  const tasks = listTasks(p)
  const ev = readEvents(p)
  const done = tasks.filter(t => t.status === 'approved')
  const reviewed = tasks.filter(t => t.review)
  const stops = ev.filter(e => e.type === 'detector.stop')
  const labels = ev.filter(e => e.type === 'detector.label')
  const sessions = listDir(join(p.root, '.focus', 'sessions')).filter(f => f.endsWith('.md'))
  const metrics = sessions.map(f => /<!-- focus-metrics (.*) -->/.exec(readText(join(p.root, '.focus', 'sessions', f)))?.[1]).filter(Boolean).map(j => JSON.parse(j))
  return {
    tasks: tasks.length,
    merged: done.length,
    reviewedByAgent: reviewed.length,
    reviewBlockers: reviewed.reduce((s, t) => s + (t.review.blockers?.length ?? 0), 0),
    mergedBeforeReview: done.filter(t => t.mergedBeforeReview).length,
    overrides: ev.filter(e => e.type === 'review.override').length,
    fixRoundsFromComments: ev.filter(e => e.type === 'task.feedback').length,
    lessons: ev.filter(e => e.type === 'lesson.added').length,
    detectorStops: stops.length,
    detectorPrecision: labels.length ? pct(labels.filter(l => l.correct).length, labels.length) : '-',
    escalations: ev.filter(e => e.type === 'task.escalated').length,
    mainBroken: ev.filter(e => e.type === 'smoke.fail').length,
    featuresDone: ev.filter(e => e.type === 'feature.done').length,
    medianFeatureMinutes: median(ev.filter(e => e.type === 'feature.done').map(e => e.minutes)),
    costPerMergedUsd: done.length ? r1(done.reduce((s, t) => s + (t.costUsd ?? 0), 0) / done.length) : null,
    pullsOutsideCheckpoints: metrics.reduce((s, m) => s + (m.pulls ?? 0), 0),
    waitOnAiSec: metrics.reduce((s, m) => s + (m.waitOnAiSec ?? 0), 0),
  }
}

export function renderCompare(rows, focus) {
  const keys = ['prs', 'merged', 'medianOpenToMergeMin', 'medianChangedLines', 'prsWithHumanComments', 'mergedWithReviewStillRunning', 'mergedPerHour']
  const label = { prs: 'PRs', merged: 'merged', medianOpenToMergeMin: 'median open → merge (min)', medianChangedLines: 'median PR size (lines)', prsWithHumanComments: 'PRs you commented on', mergedWithReviewStillRunning: 'merged while review still running', mergedPerHour: 'merged per hour' }
  const out = [`| metric | ${rows.map(r => r.repo).join(' | ')} |`, `|---|${rows.map(() => '---').join('|')}|`]
  for (const k of keys) out.push(`| ${label[k]} | ${rows.map(r => (r.error ? 'error' : r[k] ?? '-')).join(' | ')} |`)
  if (focus) {
    out.push('', '**Focus Hour only (this repo)**', '', '| metric | value |', '|---|---|')
    for (const [k, v] of Object.entries(focus)) out.push(`| ${k} | ${v ?? '-'} |`)
  }
  return out.join('\n')
}
