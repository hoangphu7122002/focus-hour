import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { loadConfig } from '../lib/config.mjs'
import { addTask, getTask } from '../lib/tasks.mjs'
import { git, paths, writeJson } from '../lib/util.mjs'
import { runTask } from '../lib/worker.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'focus.mjs')
const tmp = name => mkdtempSync(join(tmpdir(), `focus-base-${name}-`))
const ident = dir => { git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't') }

// origin (bare) ← the operator's clone (`root`, main checked out) and a second clone standing in for GitHub merges.
// After setup, origin/main has one more commit than the operator's local main.
function repos({ writes = true } = {}) {
  const dir = tmp('repo')
  const origin = join(dir, 'origin.git')
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  const root = join(dir, 'root')
  git(dir, 'clone', '-q', origin, root)
  ident(root)
  git(root, 'checkout', '-q', '-b', 'main')
  writeFileSync(join(root, 'a.txt'), '1\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'one')
  git(root, 'push', '-q', 'origin', 'main')
  const gh = join(dir, 'gh')
  git(dir, 'clone', '-q', origin, gh)
  ident(gh)
  writeFileSync(join(gh, 'merged.txt'), 'merged on GitHub\n')
  git(gh, 'add', '-A')
  git(gh, 'commit', '-qm', 'merged PR')
  git(gh, 'push', '-q', 'origin', 'main')
  // A fake `claude`: writes a file in its worktree (or nothing) and ends with a final message.
  const bin = join(dir, 'claude')
  writeFileSync(bin, `#!/bin/sh\n${writes ? 'echo work > work.txt\n' : ''}echo '{"result":"The prerequisite module is missing, nothing to build on.","session_id":"s1","total_cost_usd":0}'\n`)
  chmodSync(bin, 0o755)
  process.env.FOCUS_WORKTREES = join(dir, 'worktrees')
  const p = paths(root)
  writeJson(p.config, { worker: { claudeBin: bin }, testCommand: 'true', baseBranch: 'main', autoSyncBase: false })
  writeFileSync(join(root, '.git', 'info', 'exclude'), '.focus/\n')
  const cfg = loadConfig(p)
  const t = addTask(p, cfg, { title: 'work', scope: 'work.txt' })
  return { p, cfg, root, gh, origin, id: t.id, originHead: () => git(gh, 'rev-parse', 'HEAD').stdout.trim() }
}

test('a task branch starts from the fresh origin/<base>, not the stale local base; the diff is measured against it', async () => {
  const { p, cfg, id } = repos()
  const t = await runTask(p, cfg, id)
  assert.ok(existsSync(join(t.worktree, 'merged.txt')), 'the task worktree has the commit merged on GitHub')
  assert.deepEqual(t.checks.files, ['work.txt'])
})

test('a reused worktree without commits of its own is moved onto the fresh base', async () => {
  const { p, cfg, root, id, originHead } = repos()
  const wt = join(p.worktrees, id)
  git(root, 'worktree', 'add', '-q', '-b', `focus/${id}`, wt, 'main') // started earlier, on the stale local main
  const t = await runTask(p, cfg, id)
  assert.equal(git(wt, 'rev-parse', 'HEAD~1').stdout.trim(), originHead())
  assert.deepEqual(t.checks.files, ['work.txt'])
  assert.equal(getTask(p, id).status, 'ready')
})

test('a run that changed nothing stops (no-changes) instead of going to review, and show gives the reason', async () => {
  const { p, cfg, id } = repos({ writes: false })
  const t = await runTask(p, cfg, id)
  assert.equal(t.status, 'stopped')
  assert.equal(t.andon.trigger, 'no-changes')
  assert.match(t.andon.reason, /prerequisite module is missing/)
  const show = spawnSync(process.execPath, [CLI, 'show', id], { cwd: p.root, env: { ...process.env, FOCUS_ROOT: p.root }, encoding: 'utf8' })
  assert.match(show.stdout, /no-changes/)
  assert.match(show.stdout, /Worker's last message:\n  The prerequisite module is missing/)
})
