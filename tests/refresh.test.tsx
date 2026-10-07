import { expect, mock, test } from 'claude-code/testing'

import type { FocusStatus } from '../types'

const base = (left: number): FocusStatus => ({
  root: '/repo',
  config: { language: { chat: null, code: 'en' }, roadmap: null, smokeCommand: null, mainEffort: null, predict: 'optional', paneOutsideCheckpoint: 'collapsed', reviewCap: 2, mode: 'focus', testCommand: 'make test' },
  session: { active: true, id: 's', mode: 'focus', left, current: 0, upcoming: 1, inMs: 60_000, inWindow: false, collapsed: true },
  flow: { text: '', derived: true },
  decisions: [],
  tasks: [],
  resume: { last: null, needsReview: [], drafts: [], waiting: [], stopped: [] },
  attention: { level: 0, reason: '', autoOpen: false },
  requests: [],
  features: { current: null, roadmap: null, list: [] },
  smoke: null,
  lessons: 0,
  workerAlive: true,
} as never)

function world(on: any, opts: { configAt?: () => boolean } = {}) {
  const w = { left: 3_000_000, statusCalls: 0, configured: true }
  on('session.start', ($: unknown, e: unknown) => e)
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isOpen: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.root', () => ({ value: '/repo' }))
  on('fs.exists', () => ({ value: w.configured }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', ($: unknown, e: { argv: string[] }) => {
    if (e.argv[2] === 'status') w.statusCalls++
    return { value: { exitCode: 0, stdout: e.argv[2] === 'status' ? JSON.stringify(base(w.left)) : 'ok', stderr: '' } }
  })
  return w
}

const mountPane = ($: any) => $.ui.mount({ plugin: 'focus-hour', surface: 'terminal', component: 'Pane', requestId: 'focus-hour', props: { bodyColumns: 100 } as never })

test('the pane refreshes on its own every few seconds, without /focus', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true } as never)
  const pane = await mountPane($)
  expect(await pane.find({ text: /50:00/ })).toBeDefined()
  w.left = 2_000_000
  await clock.advance(3000)
  expect(await pane.find({ text: /33:20/ })).toBeDefined()
})

test('set up after the session started (focus init from a shell): the pane still starts refreshing by itself', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.configured = false
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true } as never)
  expect(w.statusCalls).toBe(0)
  w.configured = true
  await clock.advance(3000)
  const pane = await mountPane($)
  expect(await pane.find({ text: /50:00/ })).toBeDefined()
  w.left = 2_000_000
  await clock.advance(3000)
  expect(await pane.find({ text: /33:20/ })).toBeDefined()
})

