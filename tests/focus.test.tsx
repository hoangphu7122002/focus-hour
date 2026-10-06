import { expect, test } from 'claude-code/testing'

import type { FocusStatus } from '../types'

const STATUS: FocusStatus = {
  root: '/repo',
  config: { language: { chat: 'vi', code: 'en' }, roadmap: null, smokeCommand: null, mainEffort: { ask: 'low', code: 'medium' }, predict: 'optional', paneOutsideCheckpoint: 'collapsed', reviewCap: 2, mode: 'focus', testCommand: 'make test' },
  session: { active: true, id: '2026-10-03-1', mode: 'focus', left: 1_800_000, current: 2, upcoming: 3, inMs: 60_000, inWindow: true, collapsed: false },
  flow: { text: 'baseline ✓ → sweep ▶', derived: false },
  decisions: [
    { id: 'D001', title: 'SLO: 300ms', status: 'active', question: 'SLO?', chosen: '300ms', rejected: ['500ms'], why: 'users complained', depends_on: [], dependents: ['D002'], impact: ['└─ D002 Seqs: 64  [draft]'] },
    { id: 'D002', title: 'Seqs: 64', status: 'draft', question: 'Seqs?', chosen: '64', rejected: ['128'], why: '', depends_on: ['D001'], dependents: [], impact: [] },
  ],
  tasks: [
    {
      id: 'T1', title: 'sweep script', status: 'review', level: 'L2', scope: ['scripts/'], resources: [], based_on: ['D002'], stale: [], staleReason: null,
      prUrl: 'https://github.com/o/r/pull/14', prNumber: 14, costUsd: 0.41, escalations: 0, andon: null,
      checks: { files: ['scripts/a.py'], outOfScope: [], added: 120, removed: 3, testsDelta: 4, mocksAdded: 0, testsPass: true },
      packet: { summary: 'adds sweep', risks: ['not run on GPU'] }, prediction: null, predictionSkipped: false, predictionMatch: null, waits: null, publishError: null,
    },
  ],
  resume: { last: null, needsReview: [], drafts: [{ id: 'D002', title: 'Seqs: 64' }], waiting: [], stopped: [] },
  attention: { level: 1, reason: '1 PR waiting', autoOpen: false },
  requests: [],
  features: { current: null, roadmap: null, list: [] },
  smoke: null,
  lessons: 0,
  workerAlive: true,
}

// A fake repo: the CLI answers from memory and every call is recorded.
function fakeRepo(on: any) {
  const calls: { args: string[]; stdin?: string }[] = []
  on('session.start', ($: unknown, e: unknown) => e)
  on('command.register', () => ({ value: undefined }))
  
  on('ui.open', () => ({ value: { isOpen: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.root', () => ({ value: '/repo' }))
  on('fs.exists', () => ({ value: true }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', ($: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    const args = e.argv.slice(2)
    calls.push({ args, stdin: e.init?.stdin })
    const out = args[0] === 'status' ? JSON.stringify(STATUS) : args[0] === 'decision' && args[1] === 'capture' ? '[{"id":"D003","action":"new"}]' : 'ok'
    return { value: { exitCode: 0, stdout: out, stderr: '' } }
  })
  return calls
}

test('records the answers of a tagged AskUserQuestion and tells the model the draft ids', async ($, on) => {
  const calls = fakeRepo(on)
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: { questions: [], answers: { 'Which engine?': 'SGLang' } } }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true } as never)
  const ran = await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which engine?', header: 'Engine', options: [{ label: 'SGLang', description: '' }, { label: 'vLLM', description: '' }], multiSelect: false }],
    metadata: { source: 'focus@Engine:new' },
  } as never)
  const capture = calls.find(c => c.args[0] === 'decision' && c.args[1] === 'capture')
  expect(capture).toBeDefined()
  expect(JSON.parse(capture!.stdin!).tags).toEqual(['new'])
  expect(JSON.parse(capture!.stdin!).area).toBe('Engine')
  expect(JSON.parse(capture!.stdin!).answers).toEqual({ 'Which engine?': 'SGLang' })
  expect(String((ran as { context?: string[] }).context?.join(' '))).toContain('D003')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane on ${surface}: decisions open with their impact, confirm runs the CLI`, async ($, on) => {
    const calls = fakeRepo(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true } as never)
    const pane = await $.ui.mount({ plugin: 'focus-hour', surface, component: 'Pane', requestId: 'focus-hour', props: { bodyColumns: 100 } as never })
    await pane.press({ key: 'tab-d' })
    expect(await pane.find({ text: /D002 Seqs: 64/ })).toBeDefined()
    await pane.press({ key: 'd-D001' })
    expect(await pane.find({ text: /D002 Seqs: 64 {2}\[draft\]/ })).toBeDefined()
    await pane.press({ key: 'back' })
    await pane.press({ key: 'd-D002' })
    await pane.press({ key: 'ok' })
    expect(calls.some(c => c.args.join(' ') === 'decision confirm D002')).toBe(true)
  })

  test(`pane on ${surface}: a PR waiting asks for a prediction before showing the link`, async ($, on) => {
    const calls = fakeRepo(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true } as never)
    const pane = await $.ui.mount({ plugin: 'focus-hour', surface, component: 'Pane', requestId: 'focus-hour', props: { bodyColumns: 100 } as never })
    await pane.press({ key: 'tab-q' })
    await pane.press({ key: 't-T1' })
    expect(await pane.find({ key: 'pr' })).toBeUndefined()
    await pane.input({ key: 'predict', text: 'adds a sweep script' })
    expect(calls.some(c => c.args[0] === 'predict' && c.args[1] === 'T1')).toBe(true)
  })
}

test('main session effort: a turn asks at low, moves to medium once it edits, and /effort hands control back', async ($, on) => {
  fakeRepo(on)
  const seen: unknown[] = []
  on('turn.start', ($: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($: unknown, e: { turnId: string; index: number; effort?: unknown }) {
    seen.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: { filePath: 'a', oldString: 'x', newString: 'y' } }))
  on('prompt.submit', ($: unknown, e: { text: string }) => ({ text: e.text }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true } as never)
  const step = async (index: number) => {
    const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as never)
    for await (const _ of stream as AsyncIterable<unknown>) { /* drain */ }
  }
  await $.turn.start({ text: 'which engine?', turnId: 't1' } as never)
  await step(0)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.js', old_string: 'x', new_string: 'y' } as never)
  await step(1)
  await $.prompt.submit({ text: '/effort high' } as never)
  await step(2)
  expect(seen).toEqual(['low', 'medium', 'high'])
})
