// The whole picture the pane and the web UI draw from: one JSON, computed from the files.
import * as D from './decisions.mjs'
import * as S from './session.mjs'
import { blockedReason, listTasks } from './tasks.mjs'
import { dirtyFiles } from './worker.mjs'
import { readText } from './util.mjs'

export function status(p, c) {
  const cp = S.checkpointState(p, c)
  const tasks = listTasks(p)
  const ds = D.listDecisions(p, c)
  const dirty = dirtyFiles(p)
  return {
    root: p.root,
    initialized: true,
    config: { predict: c.predict, paneOutsideCheckpoint: c.paneOutsideCheckpoint, reviewCap: c.wip.reviewCap, mode: c.mode, testCommand: c.testCommand },
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
      waits: t.status === 'queued' ? blockedReason(t, { tasks, cfg: c, dirtyFiles: dirty }) : null,
    })),
    resume: S.resumeCard(p, c),
    attention: S.attention(p, c, { tasks, decisions: ds, dirtyFiles: dirty }),
    requests: D.takeRequests(p),
    workerAlive: workerAlive(p),
  }
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

