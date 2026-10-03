import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UNSORTED, fit, layout, related, wrap } from '../ui/graph.js'

const D = (id, area, depends_on = [], extra = {}) => ({ id, title: `title ${id}`, area, status: 'active', depends_on, ...extra })
const T = (id, based_on, extra = {}) => ({ id, title: `task ${id}`, status: 'running', based_on, ...extra })

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const sample = () => [
  D('D001', 'batching'),
  D('D002', 'batching', ['D001']),
  D('D003', 'batching', ['D002']),
  D('D004', 'batching', ['D002']),
  D('D005', 'div()'),
  D('D006', 'div()', ['D005', 'D001']),
  D('D007', 'div()', ['D006'], { status: 'superseded', superseded_by: 'D008' }),
  D('D008', 'div()', ['D006'], { status: 'draft', supersedes: 'D007' }),
  D('D009', undefined),
  D('D010', 'div()', [], { status: 'rejected' }),
]

test('every arrow points right: a node sits right of what it builds on', () => {
  const g = layout(sample(), [T('T1', ['D003']), T('T2', ['D006', 'D002'])])
  const at = new Map(g.nodes.map(n => [n.id, n]))
  for (const e of g.edges) assert.ok(at.get(e.from).x + at.get(e.from).w < at.get(e.to).x, `${e.from} → ${e.to}`)
})

test('no two nodes overlap and every node sits inside its lane', () => {
  const many = Array.from({ length: 30 }, (_, i) => D(`D${100 + i}`, ['a', 'b', 'c'][i % 3], i > 2 ? [`D${100 + i - 3}`] : []))
  const g = layout([...sample(), ...many], [T('T1', ['D003']), T('T2', []), T('T3', ['D105'])])
  for (let i = 0; i < g.nodes.length; i++) for (let j = i + 1; j < g.nodes.length; j++) assert.ok(!overlaps(g.nodes[i], g.nodes[j]), `${g.nodes[i].id} overlaps ${g.nodes[j].id}`)
  for (const n of g.nodes) {
    const lane = g.lanes.find(l => l.name === n.area)
    assert.ok(n.y >= lane.y && n.y + n.h <= lane.y + lane.h, `${n.id} outside lane ${lane.name}`)
    assert.ok(n.x + n.w <= g.width && n.y + n.h <= g.height)
  }
})

test('lanes follow areas in the order they appeared; unsorted last; rejected hidden', () => {
  const g = layout(sample(), [T('T2', [])])
  assert.deepEqual(g.lanes.map(l => l.name), ['batching', 'div()', UNSORTED])
  assert.ok(!g.nodes.some(n => n.id === 'D010'))
  assert.equal(g.nodes.find(n => n.id === 'T2').area, UNSORTED)
})

test('a replaced decision points to its replacement; tasks hang off their decisions', () => {
  const g = layout(sample(), [T('T1', ['D003'])])
  assert.ok(g.edges.some(e => e.from === 'D007' && e.to === 'D008' && e.kind === 'replaced'))
  assert.ok(g.edges.some(e => e.from === 'D003' && e.to === 'T1' && e.kind === 'task'))
})

test('impact: what a node builds on and what it affects, across lanes', () => {
  const g = layout(sample(), [T('T1', ['D003'])])
  const r = related(g.edges, 'D002')
  assert.deepEqual([...r.up].sort(), ['D001'])
  assert.deepEqual([...r.down].sort(), ['D003', 'D004', 'T1'])
  assert.ok(related(g.edges, 'D001').down.has('D006')) // crosses into the div() lane
})

test('a cycle in hand-edited files still lays out', () => {
  const g = layout([D('D1', 'x', ['D2']), D('D2', 'x', ['D1'])], [])
  assert.equal(g.nodes.length, 2)
  assert.ok(Number.isFinite(g.width) && Number.isFinite(g.height))
})

test('empty graph and text fitting', () => {
  const g = layout([], [])
  assert.equal(g.nodes.length, 0)
  assert.equal(fit('short', 100), 'short')
  assert.ok(fit('a very long decision title that will not fit', 100).endsWith('…'))
  assert.ok(fit('a very long decision title that will not fit', 100).length <= 13)
})

test('impact does not flow through "replaced by": the old decision is history', () => {
  const g = layout(sample(), [])
  assert.ok(!related(g.edges, 'D008').up.has('D007'))
  assert.ok(!related(g.edges, 'D007').down.has('D008'))
})

test('titles wrap into two lines and end in … when cut', () => {
  assert.deepEqual(wrap('max-num-seqs = 64', 200), ['max-num-seqs = 64'])
  const two = wrap('p95 TTFT under 300ms for the internal assistant workload at peak hours', 120)
  assert.equal(two.length, 2)
  assert.ok(two[1].endsWith('…'))
  for (const l of two) assert.ok(l.length <= Math.floor(120 / 7))
  assert.ok(wrap('averyveryveryverylongwordwithoutspaces', 70).every(l => l.length <= 10))
})
