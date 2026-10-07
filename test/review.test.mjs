import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

test('a commit pushed to the task branch by someone else is pulled in before the review round', async () => {
  const { p, cfg, wt, head } = setup({ verdict: 'ok', blockers: [] })
  const origin = join(p.root, 'origin.git')
  git(p.root, 'init', '-q', '--bare', origin)
  git(wt, 'remote', 'add', 'origin', origin)
  git(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/focus/T1')
  const other = join(p.root, 'other')
  git(p.root, 'clone', '-q', '-b', 'focus/T1', origin, other)
  git(other, 'config', 'user.email', 't@t')
  git(other, 'config', 'user.name', 't')
  writeFileSync(join(other, 'a.txt'), 'fixed by the operator\n')
  git(other, 'commit', '-qam', 'operator fix')
  git(other, 'push', '-q', 'origin', 'focus/T1')
  const theirs = git(other, 'rev-parse', 'HEAD').stdout.trim()
  saveTask(p, task(wt, { review: { status: 'pending', reasons: ['x'] } }))
  const t = await reviewTask(p, cfg, 'T1')
  assert.equal(head(), theirs)
  assert.equal(t.review.sha, theirs)
})

test('focus resume starts the fix-round budget over', () => {
  const { p, wt } = setup({ verdict: 'ok' })
  saveTask(p, task(wt, { status: 'stopped', fixRounds: 3, andon: { trigger: 'fix-rounds', reason: 'still blocked after 3 fix rounds' } }))
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'focus.mjs')
  const r = spawnSync(process.execPath, [bin, 'resume', 'T1', 'operator fixed it'], { env: { ...process.env, FOCUS_ROOT: p.root }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const t = getTask(p, 'T1')
  assert.equal(t.status, 'queued')
  assert.equal(t.fixRounds, 0)
})
