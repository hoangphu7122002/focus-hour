import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { detectBach, findStack, prTeamActive, stackLease } from '../lib/bach.mjs'
import { DEFAULTS, loadConfig, merge } from '../lib/config.mjs'
import { agents } from '../lib/status.mjs'
import { addTask, getTask, updateTask } from '../lib/tasks.mjs'
import { git, paths, writeJson } from '../lib/util.mjs'
import { reviewTask, runTests } from '../lib/worker.mjs'

const tmp = name => mkdtempSync(join(tmpdir(), `focus-${name}-`))
const exe = (file, body) => { writeFileSync(file, body); chmodSync(file, 0o755); return file }

test('a bach-scoped repo: init picks up its roadmap, review lessons and stack slots', () => {
  const root = tmp('bach')
  mkdirSync(join(root, 'scope', '2026-10-01-old'), { recursive: true })
  mkdirSync(join(root, 'scope', '2026-10-05-blog'), { recursive: true })
  writeFileSync(join(root, 'scope', '2026-10-01-old', 'roadmap.md'), '# old')
  writeFileSync(join(root, 'scope', '2026-10-05-blog', 'roadmap.md'), '## F1 · x\n- Status: ⬜\n')
  mkdirSync(join(root, '.claude', 'pr-team'), { recursive: true })
  writeFileSync(join(root, '.claude', 'pr-team', 'review-lessons.md'), '- [backend] rule — PR #1\n')
  writeFileSync(join(root, 'stack.toml'), '[limits]\nslots = 6\nheavy = 2\n')
  assert.deepEqual(detectBach(root), { roadmap: 'scope/2026-10-05-blog/roadmap.md', lessonsFile: '.claude/pr-team/review-lessons.md', slots: { stack: 'auto', count: 5 } })
  assert.deepEqual(detectBach(tmp('plain')), {})
  mkdirSync(join(root, 'scripts'))
  exe(join(root, 'scripts', 'stack'), '#!/bin/sh\n')
  assert.equal(findStack(root), join(root, 'scripts', 'stack')) // the repo's own stack wins
})

test('one executor per repo: a running pr-team is seen, a shut-down one (lead only) is not', () => {
  const teams = tmp('teams')
  const root = '/work/blog'
  mkdirSync(join(teams, 'session-1'))
  writeJson(join(teams, 'session-1', 'config.json'), { members: [{ name: 'team-lead', cwd: root }] })
  assert.equal(prTeamActive(root, teams), null)
  writeJson(join(teams, 'session-1', 'config.json'), { members: [{ name: 'team-lead', cwd: root }, { name: 'builder-1', cwd: root }, { name: 'pr-watcher', cwd: root }] })
  assert.deepEqual(prTeamActive(root, teams), { team: 'session-1', members: ['builder-1', 'pr-watcher'] })
  assert.equal(prTeamActive('/work/other', teams), null)
})

test('stack slots: the lease env comes from .env.slot and tests run through `stack run --db test`', () => {
  const wt = tmp('wt')
  const log = join(wt, 'calls')
  const stack = exe(join(tmp('bin'), 'stack'), `#!/bin/sh
echo "$@" >> ${log}
case "$1" in
  lease) printf 'STACK_SLOT=2\\nAPI_PORT=8202\\nDATABASE_URL=postgresql://x/app_s2\\n' > .env.slot; echo "slot 2: API_PORT=8202";;
  run) shift; while [ "$1" != "--" ]; do shift; done; shift; exec "$@";;
esac`)
  const r = stackLease(stack, wt, 'T3')
  assert.equal(r.slot, 2)
  assert.equal(r.env.API_PORT, '8202')
  assert.equal(r.env.STACK, stack)
  const cfg = merge(DEFAULTS, { testCommand: 'test "$API_PORT" = 8202' })
  assert.equal(runTests(cfg, wt, { ...r, stack }).pass, true)
  assert.match(readFileSync(log, 'utf8'), /lease T3\nrun --db test --db dev --ports --heavy -- sh -c/)
})

// ---------- on-demand reviewers ----------

function reviewRepo(verdicts) {
  const root = tmp('review')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  writeFileSync(join(root, 'a.txt'), 'a\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  const p = paths(root)
  const calls = join(root, '.focus', 'calls.jsonl')
  // A fake `claude`: records its arguments, answers the next verdict, and can commit mid-review.
  const bin = exe(join(tmp('bin'), 'claude'), `#!/usr/bin/env node
const fs = require('fs'); const { execSync } = require('child_process')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n')
const n = fs.readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n').length
const v = ${JSON.stringify(verdicts)}[n - 1]
if (v.commit) execSync('echo more >> a.txt && git commit -qam more')
console.log(JSON.stringify({ result: JSON.stringify(v.verdict), session_id: 'rev-' + n, total_cost_usd: 0.1 }))`)
  writeJson(p.config, { worker: { claudeBin: bin }, testCommand: 'true' })
  const cfg = loadConfig(p)
  const t = addTask(p, cfg, { title: 'posts api', scope: 'backend/' })
  updateTask(p, t.id, x => Object.assign(x, { status: 'review', worktree: root, prNumber: null, publishedAt: 1, review: { status: 'pending', reasons: ['UI change'] } }))
  const args = () => readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  return { p, cfg, id: t.id, args }
}

const blocked = { verdict: 'blocked', summary: 'not atomic', blockers: [{ file: 'cache.py', issue: 'not atomic' }], lessons: ['[backend/] atomic writes'] }
const ok = { verdict: 'ok', summary: 'fine', blockers: [] }

test('a blocked review sends the task back; the re-check resumes the same reviewer on the fix diff only', async () => {
  const { p, cfg, id, args } = reviewRepo([{ verdict: blocked }, { verdict: ok }])
  let t = await reviewTask(p, cfg, id)
  assert.equal(t.status, 'queued')
  assert.equal(t.fixRounds, 1)
  assert.equal(t.review.sessionId, 'rev-1')
  assert.equal(t.review.reviewer, `reviewer-${id}`)
  const sha = t.review.sha
  // The fix is published again: pending, since the reviewed sha.
  updateTask(p, id, x => Object.assign(x, { status: 'review', review: { ...x.review, status: 'pending', since: sha } }))
  t = await reviewTask(p, cfg, id)
  assert.equal(t.review.status, 'ok')
  const second = args()[1]
  assert.equal(second[second.indexOf('--resume') + 1], 'rev-1')
  assert.match(second[second.indexOf('-p') + 1], new RegExp(`Re-check ONLY git diff ${sha}..HEAD`))
  assert.ok(!args()[0].includes('--resume'))
})

test('a verdict is never pinned to a newer commit than the one reviewed', async () => {
  const { p, cfg, id } = reviewRepo([{ verdict: ok, commit: true }, { verdict: ok }])
  const before = git(p.root, 'rev-parse', 'HEAD').stdout.trim()
  let t = await reviewTask(p, cfg, id)
  assert.equal(t.review.status, 'pending') // looked at an old head: look again
  assert.equal(t.review.since, before)
  t = await reviewTask(p, cfg, id)
  assert.equal(t.review.status, 'ok')
  assert.equal(t.review.sha, git(p.root, 'rev-parse', 'HEAD').stdout.trim())
})

test('the map lists the agents alive: builders per running task, reviewers per PR under review', () => {
  const p = paths(tmp('agents'))
  writeJson(p.config, {})
  const cfg = loadConfig(p)
  const a = addTask(p, cfg, { title: 'a', scope: 'a/', level: 'L2' })
  const b = addTask(p, cfg, { title: 'b', scope: 'b/' })
  updateTask(p, a.id, x => Object.assign(x, { status: 'running', startedAt: 1 }))
  updateTask(p, b.id, x => Object.assign(x, { status: 'review', prNumber: 7, review: { status: 'running', sessionId: 's', startedAt: 2 } }))
  writeJson(join(p.state, 'slots.json'), { 1: { task: a.id }, 2: { task: 'reviewer-pr7' } })
  assert.deepEqual(agents(p, cfg).map(x => [x.name, x.model, x.slot, x.rework]), [[`builder-${a.id}`, 'sonnet', 1, false], ['reviewer-pr7', 'opus', 2, true]])
  assert.equal(getTask(p, b.id).status, 'review')
})
