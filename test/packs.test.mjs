import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULTS, detectAllowedTools, loadConfig, merge } from '../lib/config.mjs'
import * as D from '../lib/decisions.mjs'
import { INFRA, checkPre, emptyRun } from '../lib/detectors.mjs'
import * as F from '../lib/features.mjs'
import { MARKER, feedbackNote, newFeedback } from '../lib/github.mjs'
import * as G from '../lib/guard.mjs'
import { bigReasons, parseVerdict, verdictComment } from '../lib/review.mjs'
import { lease, release, slotEnv } from '../lib/slots.mjs'
import { addTask, blockedReason, getTask, saveTask } from '../lib/tasks.mjs'
import { paths, readText, writeJson } from '../lib/util.mjs'

function repo(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'focus-packs-'))
  const p = paths(root)
  writeJson(p.config, config)
  return { p, cfg: loadConfig(p), root }
}

const ROADMAP = `# Roadmap

## F1 · Seed CLI
Status: ✅
Goal: seed demo data from the command line
AC: AC-1, AC-2

## F2 · Posts API
Status: ⬜
Depends on: F1
AC: AC-3

## F3 · Post page
Status: ⬜
Depends on: F2
Goal: render a post with markdown
`

// ---------- pack 1: features ----------

test('roadmap: bach-style sections parse into features with status, deps, AC and goal', () => {
  const r = F.parseRoadmap(ROADMAP)
  assert.deepEqual(r.map(f => [f.id, f.name, f.done]), [['F1', 'Seed CLI', true], ['F2', 'Posts API', false], ['F3', 'Post page', false]])
  assert.deepEqual(r[1].depends, ['F1'])
  assert.deepEqual(r[0].ac, ['AC-1', 'AC-2'])
  assert.equal(r[2].goal, 'render a post with markdown')
  assert.equal(F.nextReady(r).id, 'F2')
})

test('a task after another waits until that one is merged; a dropped dependency says so', () => {
  const cfg = merge(DEFAULTS, {})
  const T = (id, status, extra = {}) => ({ id, status, scope: [`${id}/`], resources: [], based_on: [], ...extra })
  const tasks = [T('T1', 'review'), T('T2', 'queued', { blockedBy: ['T1'] }), T('T3', 'dropped'), T('T4', 'queued', { blockedBy: ['T3'] })]
  assert.equal(blockedReason(tasks[1], { tasks, cfg }), 'after T1')
  assert.match(blockedReason(tasks[3], { tasks, cfg }), /dropped/)
  tasks[0].status = 'approved'
  assert.equal(blockedReason(tasks[1], { tasks, cfg }), null)
})

test('finishing a feature ticks the roadmap and queues the plan of the next ready feature', () => {
  const { p, cfg, root } = repo({ roadmap: 'roadmap.md' })
  writeFileSync(join(root, 'roadmap.md'), ROADMAP)
  F.startFeature(p, cfg, 'F2')
  const a = addTask(p, cfg, { title: 'posts model', scope: 'backend/', feature: 'F2' })
  const b = addTask(p, cfg, { title: 'posts api', scope: 'backend/api/', feature: 'F2', after: a.id })
  assert.equal(getTask(p, b.id).area, 'F2')
  assert.deepEqual(F.advance(p, cfg), [])
  saveTask(p, { ...getTask(p, a.id), status: 'approved' })
  saveTask(p, { ...getTask(p, b.id), status: 'approved' })
  assert.deepEqual(F.advance(p, cfg), ['F2'])
  assert.match(readText(join(root, 'roadmap.md')), /## F2 · Posts API\nStatus: ✅/)
  const req = D.takeRequests(p)
  assert.equal(req.length, 1)
  assert.match(req[0].text, /focus-plan skill to plan the next feature: roadmap.md#F3/)
  assert.deepEqual(F.advance(p, cfg), []) // only once
})

// ---------- pack 2: review loop ----------

test('big PRs: size, risky paths, UI, failing tests, mocks, stale decisions', () => {
  const cfg = merge(DEFAULTS, {})
  const t = c => ({ checks: { files: ['backend/x.py'], added: 20, removed: 2, testsPass: true, mocksAdded: 0, ...c }, stale: [] })
  assert.deepEqual(bigReasons(t({}), cfg), [])
  assert.match(bigReasons(t({ added: 400 }), cfg).join(), /changed lines/)
  assert.match(bigReasons(t({ files: ['backend/migrations/001.py'] }), cfg).join(), /contract/)
  assert.match(bigReasons(t({ files: ['frontend/Post.tsx'] }), cfg).join(), /UI/)
  assert.match(bigReasons(t({ testsPass: false }), cfg).join(), /tests fail/)
  assert.deepEqual(bigReasons(t({}), merge(cfg, { review: { always: true } })), ['every PR is reviewed'])
})

test('the reviewer verdict is the last JSON object of its answer', () => {
  const text = 'I looked at {the diff}.\n```json\n{"verdict":"blocked","summary":"save() is not atomic","blockers":[{"file":"cache.py","line":12,"issue":"not atomic","fix":"write tmp then rename"}],"nits":["rename x"],"lessons":["[backend/] writes to shared files are atomic"]}\n```'
  const v = parseVerdict(text)
  assert.equal(v.verdict, 'blocked')
  assert.equal(v.blockers[0].file, 'cache.py')
  assert.equal(v.lessons.length, 1)
  assert.equal(parseVerdict('no json here'), null)
  assert.match(verdictComment({}, v, ['UI change']), /⛔ blocked[\s\S]*cache.py:12/)
})

test('PR feedback: only new human comments, never Focus Hour\'s own, bots or bare approvals', () => {
  const cfg = merge(DEFAULTS, {})
  const snap = { items: [
    { id: 'i:1', kind: 'inline', who: 'me', assoc: 'OWNER', body: 'domain in a separate file', path: 'backend/x.py', line: 3 },
    { id: 'c:2', kind: 'comment', who: 'me', assoc: 'OWNER', body: `**Focus Hour review** ok ${MARKER}` },
    { id: 'c:3', kind: 'comment', who: 'dependabot[bot]', assoc: 'NONE', body: 'bump' },
    { id: 'r:4', kind: 'review', who: 'me', assoc: 'OWNER', state: 'APPROVED', body: '' },
    { id: 'c:5', kind: 'comment', who: 'stranger', assoc: 'NONE', body: 'please add X' },
    { id: 'c:6', kind: 'comment', who: 'me', assoc: 'OWNER', body: 'clearer docstring' },
  ] }
  const fresh = newFeedback({ seenFeedback: ['c:6'] }, snap, cfg)
  assert.deepEqual(fresh.map(i => i.id), ['i:1'])
  assert.match(feedbackNote(7, fresh), /backend\/x.py:3: domain in a separate file/)
})

// ---------- pack 3: guardrails ----------

test('lessons: added once, scoped to the task, read back for prompts', () => {
  const { p, cfg } = repo()
  assert.equal(G.addLesson(p, cfg, { scope: 'backend/', rule: 'keep domain logic out of controllers', source: 'PR #13' }), true)
  assert.equal(G.addLesson(p, cfg, { scope: 'backend/', rule: 'Keep domain logic out of controllers' }), false)
  G.addLesson(p, cfg, { scope: 'frontend/', rule: 'use data-testid for selectors' })
  G.addLesson(p, cfg, { rule: 'docstrings explain why, not what' })
  const forBackend = G.lessonsForPrompt(p, cfg, ['backend/api/'])
  assert.match(forBackend, /controllers/)
  assert.match(forBackend, /docstrings/)
  assert.doesNotMatch(forBackend, /data-testid/)
})

test('language rule: chat for the main session, code for everyone', () => {
  const cfg = merge(DEFAULTS, { language: { chat: 'vi', code: 'en' } })
  assert.equal(G.languageRule(cfg, 'main'), 'Talk to the user in Vietnamese. Write code, comments, commit messages, PR titles and bodies, and docs in English.')
  assert.doesNotMatch(G.languageRule(cfg, 'worker'), /Vietnamese/)
})

test('permission presets follow the project type', () => {
  const root = mkdtempSync(join(tmpdir(), 'focus-kind-'))
  writeFileSync(join(root, 'package.json'), '{}')
  writeFileSync(join(root, 'pyproject.toml'), '')
  writeFileSync(join(root, 'Makefile'), 'check:\n')
  const tools = detectAllowedTools(root)
  for (const t of ['Bash(npm run:*)', 'Bash(uv run:*)', 'Bash(make check:*)', 'Bash(npx playwright:*)']) assert.ok(tools.includes(t), t)
  assert.ok(!tools.some(t => /docker|make up|make dev/.test(t)))
})

// ---------- pack 4: slots, infra guard, screenshots ----------

test('slots: one per running task, ports offset by slot, freed when the task stops', () => {
  const { p } = repo()
  const cfg = merge(DEFAULTS, { slots: { count: 2, ports: { API_PORT: 8200 }, env: { DB_NAME: 'app_s{slot}' } } })
  assert.deepEqual(slotEnv(cfg, 2), { FOCUS_SLOT: '2', API_PORT: '8202', DB_NAME: 'app_s2' })
  const a = lease(p, cfg, 'T1')
  const b = lease(p, cfg, 'T2')
  assert.deepEqual([a.slot, b.slot], [1, 2])
  assert.equal(lease(p, cfg, 'T3'), null)
  assert.equal(lease(p, cfg, 'T1').slot, 1) // same task keeps its slot
  release(p, 'T1')
  assert.equal(lease(p, cfg, 'T3').slot, 1)
  assert.equal(lease(p, cfg, 'T4', id => id !== 'T2').slot, 2) // a dead task's slot is reclaimed
})

test('infra guard stops workers from touching shared containers; screenshots may be written outside scope', () => {
  const cfg = merge(DEFAULTS, {})
  for (const c of ['docker compose up -d', 'make dev', 'sudo docker ps', 'echo x; make down']) assert.ok(INFRA.test(c), c)
  for (const c of ['make check', 'npm test', 'grep docker README.md', 'git commit -m "docker docs"']) assert.ok(!INFRA.test(c), c)
  const base = { run: emptyRun(), task: { scope: ['frontend/'] }, cfg, worktree: '/w', readFile: () => '' }
  assert.match(checkPre({ ...base, tool: 'Bash', input: { command: 'docker compose down' } }).deny, /\[infra\]/)
  assert.equal(checkPre({ ...base, tool: 'Write', input: { file_path: '/w/.focus-shots/post.png', content: 'x' } }).deny, undefined)
  assert.match(checkPre({ ...base, tool: 'Write', input: { file_path: '/w/backend/x.py', content: 'x' } }).deny, /\[scope\]/)
})

test('doctor names what a new project is missing', () => {
  const { p, cfg } = repo()
  const rows = G.doctor(p, cfg, { quick: true })
  assert.equal(rows[0].level, 'bad') // not a git repo yet
})
