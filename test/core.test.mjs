import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULTS, loadConfig, merge, nextLevel } from '../lib/config.mjs'
import * as D from '../lib/decisions.mjs'
import { checkFail, checkPre, emptyRun } from '../lib/detectors.mjs'
import * as S from '../lib/session.mjs'
import { addTask, blockedReason, getTask, pickRunnable, saveTask } from '../lib/tasks.mjs'
import { prBody } from '../lib/worker.mjs'
import { parseFrontmatter, paths, readText, stringifyFrontmatter, writeJson } from '../lib/util.mjs'

function repo(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'focus-'))
  const p = paths(root)
  writeJson(p.config, config)
  return { p, cfg: loadConfig(p) }
}

const ask = (qs, answers, tags) => ({
  questions: qs.map(([question, header, options]) => ({ question, header, options: options.map(label => ({ label, description: '' })), multiSelect: false })),
  answers,
  tags,
})

test('frontmatter round-trips lists, quotes and empties', () => {
  const data = { id: 'D001', title: 'max-num-seqs = 64, on 1×L4', depends_on: [], rejected: ['32', 'a, b'], chosen: '64', note: 'x: "y"' }
  const back = parseFrontmatter(stringifyFrontmatter(data, 'Why: because'))
  assert.equal(back.data.title, data.title)
  assert.deepEqual(back.data.rejected, ['32', 'a, b'])
  assert.deepEqual(back.data.depends_on, [])
  assert.equal(back.data.chosen, '64')
  assert.equal(back.data.note, 'x: "y"')
  assert.equal(back.body.trim(), 'Why: because')
})

test('config merges deeply and levels escalate in order', () => {
  const c = merge(DEFAULTS, { wip: { reviewCap: 1 }, resources: { gpu: 1 } })
  assert.equal(c.wip.running, 3)
  assert.equal(c.wip.reviewCap, 1)
  assert.equal(nextLevel(c, 'L1'), 'L2')
  assert.equal(nextLevel(c, 'L3'), null)
})

test('capture: one question = one draft decision with chosen and rejected', () => {
  const { p, cfg } = repo()
  const res = D.capture(p, cfg, ask([['Which engine?', 'Engine', ['SGLang', 'vLLM']]], { 'Which engine?': 'SGLang' }, ['new']))
  assert.deepEqual(res, [{ id: 'D001', action: 'new' }])
  const d = D.readDecision(p, cfg, 'D001')
  assert.equal(d.status, 'draft')
  assert.equal(d.chosen, 'SGLang')
  assert.deepEqual(d.rejected, ['vLLM'])
})

test('capture: shared slug groups questions; "-" and unanswered are skipped', () => {
  const { p, cfg } = repo()
  const res = D.capture(
    p, cfg,
    ask(
      [['Engine?', 'Engine', ['A', 'B']], ['Version?', 'Version', ['1', '2']], ['Clarify?', 'C', ['x', 'y']], ['Unanswered?', 'U', ['p', 'q']]],
      { 'Engine?': 'A', 'Version?': '2', 'Clarify?': 'x' },
      ['new:engine', 'new:engine', '-', 'new'],
    ),
  )
  assert.equal(res.length, 1)
  const d = D.readDecision(p, cfg, res[0].id)
  assert.equal(d.chosen, 'Engine: A; Version: 2')
  assert.deepEqual(d.rejected, ['B', '1'])
})

test('changing a decision kills its branch; "still holds" revives a node onto the new decision', () => {
  const { p, cfg } = repo()
  D.capture(p, cfg, ask([['SLO?', 'SLO', ['500ms', '300ms']]], { 'SLO?': '500ms' }, ['new']))
  D.capture(p, cfg, ask([['Seqs?', 'Seqs', ['64', '128']]], { 'Seqs?': '64' }, ['new']))
  D.capture(p, cfg, ask([['GPUs?', 'GPUs', ['1', '2']]], { 'GPUs?': '1' }, ['new']))
  D.edit(p, cfg, 'D002', { depends: 'D001' })
  D.edit(p, cfg, 'D003', { depends: 'D002' })
  for (const id of ['D001', 'D002', 'D003']) D.setStatus(p, cfg, id, 'active', 'test')
  const c = { ...cfg, resources: {} }
  const running = addTask(p, c, { title: 'sweep', scope: 'scripts/', basedOn: 'D003' })
  saveTask(p, { ...getTask(p, running.id), status: 'running' })
  const queued = addTask(p, c, { title: 'plot', scope: 'notebooks/', basedOn: 'D002' })

  const same = D.capture(p, cfg, ask([['SLO?', 'SLO', ['500ms', '300ms']]], { 'SLO?': '500ms' }, ['D001']))
  assert.equal(same[0].action, 'reaffirmed')

  const res = D.capture(p, cfg, ask([['SLO?', 'SLO', ['500ms', '300ms']]], { 'SLO?': '300ms' }, ['D001']))
  assert.equal(res[0].action, 'supersedes')
  assert.equal(D.readDecision(p, cfg, 'D001').status, 'superseded')
  assert.equal(D.readDecision(p, cfg, 'D001').superseded_by, 'D004')
  assert.equal(D.readDecision(p, cfg, 'D004').supersedes, 'D001')
  // the whole branch is dead and stays attached to the old decision
  assert.equal(D.readDecision(p, cfg, 'D002').status, 'dead')
  assert.equal(D.readDecision(p, cfg, 'D003').status, 'dead')
  assert.deepEqual(D.readDecision(p, cfg, 'D002').depends_on, ['D001'])
  assert.equal(D.readDecision(p, cfg, 'D004').why, '')
  // a running task is told, a queued one waits
  assert.deepEqual(getTask(p, running.id).stale, ['D003'])
  assert.equal(getTask(p, running.id).status, 'running')
  assert.match(readText(join(p.inbox, `${running.id}.md`)), /D001 changed: 500ms → 300ms/)
  assert.equal(getTask(p, queued.id).status, 'paused')

  // "still holds": D002 comes back, now built on D004; its task runs again; D003 is still dead
  D.revive(p, cfg, 'D002')
  assert.equal(D.readDecision(p, cfg, 'D002').status, 'active')
  assert.deepEqual(D.readDecision(p, cfg, 'D002').depends_on, ['D004'])
  assert.equal(D.impactTree(D.listDecisions(p, cfg), 'D004')[0].d.id, 'D002')
  assert.equal(getTask(p, queued.id).status, 'queued')
  assert.equal(D.readDecision(p, cfg, 'D003').status, 'dead')

  // "re-decide": a request the mod turns into a prompt
  D.requestRedecide(p, cfg, 'D003')
  const reqs = D.takeRequests(p)
  assert.equal(reqs.length, 1)
  assert.match(reqs[0].text, /re-decide D003/)
  D.doneRequest(p, reqs[0].id)
  assert.equal(D.takeRequests(p).length, 0)
})

test('impact tree is transitive and cycle-safe', () => {
  const all = [
    { id: 'D1', depends_on: [], status: 'active' },
    { id: 'D2', depends_on: ['D1', 'D3'], status: 'active' },
    { id: 'D3', depends_on: ['D2'], status: 'active' },
  ]
  const tree = D.impactTree(all, 'D1')
  assert.equal(tree[0].d.id, 'D2')
  assert.equal(tree[0].children[0].d.id, 'D3')
  assert.equal(tree[0].children[0].children.length, 0)
})

test('scheduler: running cap, resources, scope lock, dirty files, review cap', () => {
  const cfg = merge(DEFAULTS, { resources: { gpu: 1 }, wip: { running: 2, reviewCap: 2 } })
  const T = (id, status, scope, resources = []) => ({ id, status, scope, resources, based_on: [] })
  const tasks = [T('T1', 'running', ['src/a/'], ['gpu']), T('T2', 'queued', ['docs/'], ['gpu']), T('T3', 'queued', ['src/a/x/']), T('T4', 'queued', ['tests/']), T('T5', 'queued', ['notes/'])]
  assert.match(blockedReason(tasks[1], { tasks, cfg }), /gpu busy/)
  assert.match(blockedReason(tasks[2], { tasks, cfg }), /scope locked by T1/)
  assert.match(blockedReason(tasks[3], { tasks, cfg, dirtyFiles: ['tests/test_x.py'] }), /you are editing/)
  assert.deepEqual(pickRunnable({ tasks, cfg }), ['T4'])
  const full = [...tasks, T('T6', 'review', ['z/']), T('T7', 'ready', ['y/'])]
  assert.match(blockedReason(tasks[4], { tasks: full.filter(t => t.id !== 'T1'), cfg }), /review queue full/)
  assert.equal(blockedReason(tasks[4], { tasks: full.filter(t => t.id !== 'T1'), cfg: { ...cfg, mode: 'observe' } }), null)
})

test('detectors: scope, tests removed, irreversible, diff size, budget, loop', () => {
  const cfg = merge(DEFAULTS, { detectors: { lineBudget: 5, callBudget: 3, repeatLimit: 2 } })
  const task = { scope: ['tests/'] }
  const base = { run: emptyRun(), task, cfg, worktree: '/w', packetPath: '/pk/T1.json', readFile: () => '' }
  assert.match(checkPre({ ...base, tool: 'Edit', input: { file_path: '/w/src/x.py', old_string: 'a', new_string: 'b' } }).deny, /\[scope\]/)
  assert.equal(checkPre({ ...base, tool: 'Write', input: { file_path: '/pk/T1.json', content: '{}' } }).deny, undefined)
  assert.match(checkPre({ ...base, tool: 'Edit', input: { file_path: '/w/tests/test_a.py', old_string: 'def test_a():\n  pass', new_string: '' } }).deny, /tests-removed/)
  // a test file the worker created itself is its own draft: reworking its tests is not removing existing ones
  const own = { ...base, isNewFile: rel => rel === 'tests/ttl.test.mjs' }
  assert.equal(checkPre({ ...own, tool: 'Edit', input: { file_path: '/w/tests/ttl.test.mjs', old_string: "test('x', () => {})", new_string: "test.todo('x')" } }).deny, undefined)
  assert.match(checkPre({ ...base, tool: 'Bash', input: { command: 'git push origin main' } }).deny, /irreversible/)
  assert.match(checkPre({ ...base, tool: 'Write', input: { file_path: '/w/tests/a.txt', content: '1\n2\n3\n4\n5\n6' } }).deny, /diff-size/)
  let run = emptyRun()
  for (let i = 0; i < 3; i++) run = checkPre({ ...base, run, tool: 'Read', input: {} }).run
  const over = checkPre({ ...base, run, tool: 'Read', input: {} })
  assert.match(over.deny, /budget/)
  assert.equal(over.run.andon.class, 'technical')
  let f = checkFail({ run: emptyRun(), cfg, tool: 'Bash', input: { command: 'make test' } }).run
  f = checkFail({ run: f, cfg, tool: 'Bash', input: { command: 'make test' } }).run
  assert.equal(f.andon.trigger, 'loop')
})

test('checkpoints scale with the hour and collapse between them', () => {
  const { p, cfg } = repo()
  const s = S.start(p, cfg, { minutes: 30 })
  const at = m => s.startedAt + m * 60_000
  assert.equal(S.checkpointState(p, cfg, at(5)).collapsed, true)
  assert.equal(S.checkpointState(p, cfg, at(5)).upcoming, 1)
  assert.equal(S.checkpointState(p, cfg, at(10.5)).current, 1) // 20/60 × 30 = 10
  assert.equal(S.checkpointState(p, cfg, at(10.5)).collapsed, false)
  assert.equal(S.checkpointState(p, cfg, at(31)).overtime, true)
})

test('digest carries metrics the report can read back', () => {
  const { p, cfg } = repo()
  S.start(p, cfg, { minutes: 60, difficulty: 3 })
  D.capture(p, cfg, ask([['A?', 'A', ['x', 'y']], ['B?', 'B', ['x', 'y']]], { 'A?': 'x', 'B?': 'y' }, ['new', 'new']))
  S.setFlow(p, 'step 1 ✓ → step 2 ▶')
  const { file, metrics } = S.stop(p, cfg)
  assert.equal(metrics.decisions, 2)
  assert.match(readText(file), /Resume from:\*\* step 1 ✓ → step 2 ▶/)
  const r = S.report(p)
  assert.equal(r.n.focus, 1)
  assert.equal(S.resumeCard(p, cfg).drafts.length, 2)
})

test('PR body separates machine checks from agent claims and flags stale', () => {
  const t = {
    id: 'T3', title: 'x', level: 'L2', startLevel: 'L1', escalations: 1, scope: ['scripts/'], based_on: ['D012'], costUsd: 0.41,
    stale: ['D012'], staleReason: 'D012 changed: 64 → 32',
    checks: { files: ['scripts/a.py'], outOfScope: [], added: 120, removed: 3, testsDelta: 4, mocksAdded: 1, testsPass: true },
    packet: { summary: 'adds sweep', decisions: [], risks: ['not run on GPU'], out_of_scope: [] },
  }
  const body = prBody(t, DEFAULTS)
  assert.ok(body.indexOf('## Machine checks') < body.indexOf('## Agent claims'))
  assert.match(body, /⚠️ mocks added: 1/)
  assert.match(body, /escalated from L1/)
  assert.match(body, /stale.*64 → 32/)
})

test('attention rises with what waits on you and pulls a checkpoint early, once per gap', () => {
  const { p, cfg } = repo({ wip: { running: 3, reviewCap: 2 } })
  const s = S.start(p, cfg, { minutes: 60 })
  const at = m => s.startedAt + m * 60_000
  const T = (id, status, extra = {}) => ({ id, status, scope: [`${id}/`], resources: [], based_on: [], ...extra })
  const none = S.attention(p, cfg, { tasks: [], decisions: [] }, at(5))
  assert.equal(none.level, 0)
  const one = S.attention(p, cfg, { tasks: [T('T1', 'review', { publishedAt: at(4) })], decisions: [] }, at(5))
  assert.equal(one.level, 1)
  const old = S.attention(p, cfg, { tasks: [T('T1', 'review', { publishedAt: at(1) })], decisions: [] }, at(13))
  assert.equal(old.level, 2)
  const blocked = [T('T1', 'review', { publishedAt: at(4) }), T('T2', 'review', { publishedAt: at(4) }), T('T3', 'queued')]
  const hot = S.attention(p, cfg, { tasks: blocked, decisions: [] }, at(6))
  assert.equal(hot.level, 3)
  assert.equal(hot.autoOpen, true)
  S.notePressureOpen(p, cfg, hot.reason, at(6))
  assert.equal(S.checkpointState(p, cfg, at(7)).pulledEarly, true)
  assert.equal(S.checkpointState(p, cfg, at(7)).collapsed, false)
  assert.equal(S.attention(p, cfg, { tasks: blocked, decisions: [] }, at(12)).autoOpen, false) // within the 10-min gap
  assert.equal(S.attention(p, cfg, { tasks: blocked, decisions: [] }, at(17)).autoOpen, true)
  assert.equal(S.attention(p, merge(cfg, { attention: { mode: 'fixed' } }), { tasks: blocked, decisions: [] }, at(17)).autoOpen, false)
})

test('dashboard only runs the review/decision commands it lists', async () => {
  const { isAllowed } = await import('../lib/ui.mjs')
  assert.equal(isAllowed(['decision', 'confirm', 'D001']), true)
  assert.equal(isAllowed(['approve', 'T1']), true)
  assert.equal(isAllowed(['worker']), false)
  assert.equal(isAllowed(['decision', 'capture']), false)
  assert.equal(isAllowed(['hook', 'pre']), false)
  assert.equal(isAllowed('approve T1'), false)
})

test('overwriting a global counts as a mock', async () => {
  const { MOCK, count } = await import('../lib/detectors.mjs')
  assert.equal(count(MOCK, 'Date.now = () => fakeTime'), 1)
  assert.equal(count(MOCK, 'const t = Date.now()'), 0)
  assert.equal(count(MOCK, 'if (process.env.CI === "1") x()'), 0)
  assert.equal(count(MOCK, 'globalThis.fetch = fakeFetch'), 1)
})
