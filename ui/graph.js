// Layout of the Focus map: decisions and tasks as a left-to-right flow, one lane per feature area.
// Pure (no DOM), so it runs in the browser and under node --test.
//
// Columns are the longest path from a root (a decision is right of everything it builds on);
// lanes are areas; inside a lane a column stacks its nodes, ordered by where their parents sit.

export const SIZE = { w: 236, h: 66, taskH: 48, gapX: 52, gapY: 12, laneHead: 30, lanePad: 10, pad: 16 }
export const UNSORTED = 'Unsorted'

export function buildGraph(decisions, tasks) {
  const nodes = new Map()
  for (const d of decisions) if (d.status !== 'rejected') nodes.set(d.id, { id: d.id, kind: 'decision', area: d.area || UNSORTED, data: d })
  for (const t of tasks) nodes.set(t.id, { id: t.id, kind: 'task', area: t.area || UNSORTED, data: t })
  const edges = []
  for (const d of decisions) {
    if (!nodes.has(d.id)) continue
    for (const dep of d.depends_on ?? []) if (nodes.has(dep) && dep !== d.id) edges.push({ from: dep, to: d.id, kind: 'dep' })
    if (d.status === 'superseded' && d.superseded_by && nodes.has(d.superseded_by)) edges.push({ from: d.id, to: d.superseded_by, kind: 'replaced' })
  }
  for (const t of tasks) for (const b of t.based_on ?? []) if (nodes.has(b)) edges.push({ from: b, to: t.id, kind: 'task' })
  return { nodes, edges }
}

// Longest path from a root; a cycle (which a hand-edited file could make) is cut where it closes.
export function depths(nodes, edges) {
  const parents = new Map([...nodes.keys()].map(id => [id, []]))
  for (const e of edges) parents.get(e.to).push(e.from)
  const depth = new Map()
  const visiting = new Set()
  const visit = id => {
    if (depth.has(id)) return depth.get(id)
    if (visiting.has(id)) return -1
    visiting.add(id)
    const ps = parents.get(id).map(visit).filter(x => x >= 0)
    visiting.delete(id)
    const d = ps.length ? Math.max(...ps) + 1 : 0
    depth.set(id, d)
    return d
  }
  for (const id of nodes.keys()) visit(id)
  return depth
}

const idNum = id => Number(String(id).slice(1)) || 0

export function layout(decisions, tasks, size = SIZE) {
  const { nodes, edges } = buildGraph(decisions, tasks)
  const depth = depths(nodes, edges)
  const parents = new Map([...nodes.keys()].map(id => [id, []]))
  for (const e of edges) parents.get(e.to).push(e.from)

  // Lanes in the order their first decision was made; unsorted last.
  const laneNames = [...new Set([...nodes.values()].sort((a, b) => (a.kind === b.kind ? idNum(a.id) - idNum(b.id) : a.kind === 'decision' ? -1 : 1)).map(n => n.area))]
  laneNames.sort((a, b) => (a === UNSORTED) - (b === UNSORTED))

  const maxCol = Math.max(0, ...depth.values())
  const row = new Map()
  const lanes = []
  const placed = []
  let y = size.pad
  for (const name of laneNames) {
    const inLane = [...nodes.values()].filter(n => n.area === name)
    let rows = 0
    for (let c = 0; c <= maxCol; c++) {
      // Barycenter: sit near the parents already placed, so arrows cross less.
      const col = inLane.filter(n => depth.get(n.id) === c)
      const key = n => {
        const ps = parents.get(n.id).filter(p => row.has(p) && nodes.get(p).area === name).map(p => row.get(p))
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity
      }
      col.sort((a, b) => key(a) - key(b) || (a.kind === b.kind ? idNum(a.id) - idNum(b.id) : a.kind === 'decision' ? -1 : 1))
      col.forEach((n, i) => row.set(n.id, i))
      rows = Math.max(rows, col.length)
    }
    const top = y + size.laneHead
    const h = size.laneHead + rows * (size.h + size.gapY) - size.gapY + size.lanePad * 2
    for (const n of inLane) {
      const isTask = n.kind === 'task'
      const nh = isTask ? size.taskH : size.h
      placed.push({
        ...n,
        x: size.pad + depth.get(n.id) * (size.w + size.gapX),
        y: top + size.lanePad + row.get(n.id) * (size.h + size.gapY) + (size.h - nh) / 2,
        w: size.w,
        h: nh,
        col: depth.get(n.id),
      })
    }
    lanes.push({ name, y, h })
    y += h + size.gapY
  }

  const at = new Map(placed.map(n => [n.id, n]))
  const routed = edges.map(e => {
    const a = at.get(e.from)
    const b = at.get(e.to)
    const x1 = a.x + a.w
    const y1 = a.y + a.h / 2
    const x2 = b.x
    const y2 = b.y + b.h / 2
    const bend = Math.max(24, (x2 - x1) / 2)
    return { ...e, path: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}` }
  })
  return {
    width: size.pad * 2 + (maxCol + 1) * size.w + maxCol * size.gapX,
    height: y - size.gapY + size.pad,
    lanes,
    nodes: placed,
    edges: routed,
  }
}

// Everything a node builds on (up) and everything it affects (down). A "replaced by" link is history,
// not a dependency, so impact does not flow through it.
export function related(allEdges, id) {
  const edges = allEdges.filter(e => e.kind !== 'replaced')
  const walk = (start, next) => {
    const seen = new Set()
    const stack = [start]
    while (stack.length) {
      const cur = stack.pop()
      for (const n of next(cur)) if (!seen.has(n) && n !== start) seen.add(n) && stack.push(n)
    }
    return seen
  }
  return {
    up: walk(id, cur => edges.filter(e => e.to === cur).map(e => e.from)),
    down: walk(id, cur => edges.filter(e => e.from === cur).map(e => e.to)),
  }
}

// Text in at most `maxLines` lines of `px` width (SVG does not wrap); the last line ends in … when cut.
export function wrap(text, px, maxLines = 2, glyph = 7) {
  const max = Math.max(4, Math.floor(px / glyph))
  const words = String(text ?? '').split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (next.length <= max) cur = next
    else {
      if (cur) lines.push(cur)
      cur = w.length > max ? w.slice(0, max) : w
    }
  }
  if (cur) lines.push(cur)
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = fit(`${kept[maxLines - 1]} ${lines[maxLines]}`, px, glyph)
  return kept
}

// Text that fits a node: SVG does not wrap, so cut by an average glyph width.
export function fit(text, px, glyph = 7.2) {
  const max = Math.max(4, Math.floor(px / glyph))
  const s = String(text ?? '')
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…'
}
