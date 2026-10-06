// The whole picture the pane and the web UI draw from: one JSON, computed from the files.
import * as D from './decisions.mjs'
import * as S from './session.mjs'
import { blockedReason, listTasks } from './tasks.mjs'
import { dirtyFiles } from './worker.mjs'
import { featureStatus } from './features.mjs'
import { readLessons, smokeFile } from './guard.mjs'
import { join } from 'node:path'
import { readJson, readText } from './util.mjs'

export function status(p, c) {
  const cp = S.checkpointState(p, c)
  const tasks = listTasks(p)
  const ds = D.listDecisions(p, c)
  const dirty = dirtyFiles(p)
  return {
    root: p.root,
    initialized: true,
    config: { language: c.language ?? null, roadmap: c.roadmap ?? null, smokeCommand: c.smokeCommand ?? null, mainEffort: c.mainEffort ?? null, predict: c.predict, paneOutsideCheckpoint: c.paneOutsideCheckpoint, reviewCap: c.wip.reviewCap, mode: c.mode, testCommand: c.testCommand },
    session: cp,
    flow: S.getFlow(p, c),
    decisions: ds.map(d => ({
      ...d,
      dependents: D.dependents(ds, d.id).map(x => x.id),
      impact: D.impactTree(ds, d.id).length ? D.renderTree(D.impactTree(ds, d.id), '') : [],
    })),
    tasks: tasks.map(t => ({
      id: t.id, title: t.title, area: t.area ?? ds.find(d => t.based_on.includes(d.id) && d.area)?.area ?? null, status: t.status, level: t.level, scope: t.scope, resources: t.resources, based_on: t.based_on,
      stale: t.stale ?? [], staleReason: t.staleReason ?? null, prUrl: t.prUrl ?? null, prNumber: t.prNumber ?? null,
      costUsd: t.costUsd ?? 0, escalations: t.escalations, andon: t.andon ?? null, checks: t.checks ?? null, packet: t.packet ?? null,
      prediction: t.prediction ?? null, predictionSkipped: !!t.predictionSkipped, predictionMatch: t.predictionMatch ?? null,
      startedAt: t.startedAt ?? null, doneAt: t.doneAt ?? null, publishError: t.publishError ?? null,
      feature: t.feature ?? null, blockedBy: t.blockedBy ?? [], fixRounds: t.fixRounds ?? 0, screenshots: t.screenshots ?? [], mergedBeforeReview: !!t.mergedBeforeReview,
      review: t.review ? { status: t.review.status, reasons: t.review.reasons ?? [], blockers: t.review.blockers ?? [], nits: t.review.nits ?? [], summary: t.review.summary ?? '' } : null,
      waits: t.status === 'queued' ? blockedReason(t, { tasks, cfg: c, dirtyFiles: dirty }) : null,
    })),
    resume: S.resumeCard(p, c),
    attention: S.attention(p, c, { tasks, decisions: ds, dirtyFiles: dirty }),
    requests: D.takeRequests(p),
    features: featureStatus(p, c),
    smoke: readJson(smokeFile(p), null),
    lessons: readLessons(p, c).split('\n').filter(l => l.startsWith('- [')).length,
    agents: agents(p, c, tasks),
    workerAlive: workerAlive(p),
  }
}

// The agents alive right now, named like bach's team: one builder per running task, one reviewer per big PR
// under review. Both are spawned on demand and exit when their job is done.
export function agents(p, c, tasks = listTasks(p)) {
  const slots = readJson(join(p.state, 'slots.json'), {})
  const slotOf = owner => Number(Object.entries(slots).find(([, l]) => l.task === owner)?.[0]) || null
  return [
    ...tasks.filter(t => t.status === 'running').map(t => ({ role: 'builder', name: `builder-${t.id}`, task: t.id, model: c.levels[t.level]?.model ?? t.level, since: t.startedAt ?? null, slot: slotOf(t.id), rework: !!t.sessionId })),
    ...tasks.filter(t => t.status === 'review' && t.review?.status === 'running').map(t => {
      const name = `reviewer-${t.prNumber ? `pr${t.prNumber}` : t.id}`
      return { role: 'reviewer', name, task: t.id, model: c.review.model, since: t.review.startedAt ?? null, slot: slotOf(name), rework: !!t.review.sessionId }
    }),
  ]
}

export function workerAlive(p) {
  try {
    const pid = Number(readText(p.workerPid).trim())
    if (!pid) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

