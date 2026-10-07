import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../lib/config.mjs'
import { getTask, saveTask } from '../lib/tasks.mjs'
import { git, paths, writeJson } from '../lib/util.mjs'
import { reviewTask } from '../lib/worker.mjs'

// A repo whose "claude" is a script answering a fixed reviewer verdict.
function setup(verdict) {
  const root = mkdtempSync(join(tmpdir(), 'focus-review-'))
  const fake = join(root, 'fake-claude.sh')
  writeFileSync(fake, `#!/bin/sh\necho '${JSON.stringify({ result: JSON.stringify(verdict), session_id: 's1', total_cost_usd: 0 })}'\n`)
  chmodSync(fake, 0o755)
  const p = paths(root)
  writeJson(p.config, { worker: { claudeBin: fake } })
  const wt = join(root, 'wt')
  git(root, 'init', '-q', wt)
  git(wt, 'config', 'user.email', 't@t')
  git(wt, 'config', 'user.name', 't')
  writeFileSync(join(wt, 'a.txt'), '1\n')
  git(wt, 'add', '-A')
  git(wt, 'commit', '-q', '-m', 'one')
  return { p, cfg: loadConfig(p), wt, head: () => git(wt, 'rev-parse', 'HEAD').stdout.trim() }
}

const task = (wt, extra) => ({ id: 'T1', title: 't', scope: ['a.txt'], resources: [], based_on: [], status: 'review', worktree: wt, attempts: [], ...extra })

test('a fix round that changed nothing goes to the human after the first round, not back to the worker', async () => {
  const blockers = [{ file: 'stale.txt', issue: 'stale file must be deleted' }]
  const { p, cfg, wt, head } = setup({ verdict: 'blocked', blockers: [{ file: 'stale.txt', issue: 'still there' }] })
  saveTask(p, task(wt, { fixRounds: 1, review: { status: 'pending', reasons: ['x'], sha: head(), since: head(), blockers } }))
  const t = await reviewTask(p, cfg, 'T1')
  assert.equal(t.status, 'stopped')
  assert.equal(t.andon.trigger, 'fix-stuck')
  assert.equal(getTask(p, 'T1').fixRounds, 1)
})

test('the same blockers after a real change also go to the human; new blockers go back to the worker', async () => {
  const blockers = [{ file: 'a.txt', issue: 'Wrong value' }]
  let s = setup({ verdict: 'blocked', blockers: [{ file: 'a.txt', issue: 'wrong  value' }] })
  const prev = s.head()
  writeFileSync(join(s.wt, 'a.txt'), '2\n')
  git(s.wt, 'commit', '-qam', 'two')
  saveTask(s.p, task(s.wt, { fixRounds: 1, review: { status: 'pending', reasons: ['x'], sha: prev, since: prev, blockers } }))
  assert.equal((await reviewTask(s.p, s.cfg, 'T1')).status, 'stopped')

  s = setup({ verdict: 'blocked', blockers: [{ file: 'a.txt', issue: 'another problem' }] })
  const prev2 = s.head()
  writeFileSync(join(s.wt, 'a.txt'), '2\n')
  git(s.wt, 'commit', '-qam', 'two')
  saveTask(s.p, task(s.wt, { fixRounds: 1, review: { status: 'pending', reasons: ['x'], sha: prev2, since: prev2, blockers } }))
  const t = await reviewTask(s.p, s.cfg, 'T1')
  assert.equal(t.status, 'queued')
  assert.equal(t.fixRounds, 2)
})
