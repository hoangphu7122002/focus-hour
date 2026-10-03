// Focus Hour mod: the dashboard pane + one-line band, decision capture from AskUserQuestion,
// the system-prompt section that teaches the main session the workflow, and the turn-wait metric.
// All state and logic live in the `focus` CLI (bin/focus.mjs); this module only draws and relays.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FocusDecision, FocusStatus, FocusTask, FocusView } from '../types'

const PANE = 'focus-hour'
const status = atom({ plugin: 'focus-hour', key: 'status' } as const, null)
const view = atom({ plugin: 'focus-hour', key: 'view' } as const, { tab: 'session', selected: null, revealQueue: false, message: null })

const ICON: Record<string, string> = { paused: '⏸', queued: '⚪', running: '🟢', stopped: '🔥', ready: '🟣', review: '🔵', approved: '✅', dropped: '❌' }
const LEVEL_COLOR: Record<number, string | undefined> = { 0: undefined, 1: 'cyan', 2: 'yellow', 3: 'red' }
const DMARK: Record<string, string> = { active: '●', draft: '✎', 'dead': '⚠', superseded: '○', rejected: '✗' }

const fmt = (ms = 0) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Fire-and-forget work must never leave an unhandled rejection.
const bg = (p: Promise<unknown>) => void p.catch(() => undefined)

// Module state: reset on reload, rebuilt by session.start.
const m = { root: '', cliPath: '', enabled: false, isWorker: false, lastJson: '', lastCheckpoint: 0, lastLevel: 0, turnStartedAt: 0 }

async function cli($: EngineInterface, args: string[], stdin?: string) {
  const r = await $.process.run(['node', m.cliPath, ...args], { cwd: m.root, stdin, timeoutMs: 60_000 })
  return { ok: r.exitCode === 0, text: (r.stdout || r.stderr).trim() }
}

async function refresh($: EngineInterface) {
  if (!m.enabled) return
  const r = await cli($, ['status', '--json'])
  if (!r.ok || r.text === m.lastJson) return
  m.lastJson = r.text
  const s = JSON.parse(r.text) as FocusStatus
  await update($, status, () => s)
  const cp = s.session.active ? s.session.current ?? 0 : 0
  if (cp > 0 && cp !== m.lastCheckpoint) {
    const waiting = s.tasks.filter(t => t.status === 'review' || t.status === 'stopped').length
    const drafts = s.decisions.filter(d => d.status === 'draft' || d.status === 'dead').length
    $.ui.toast(`👀 Checkpoint #${cp}: ${waiting} task(s) and ${drafts} decision(s) need you`, { timeoutMs: 8000 })
    const tab: FocusView['tab'] = waiting ? 'queue' : 'decisions'
    await update($, view, v => ({ ...v, tab, selected: null }))
    $.ui.open({ id: PANE, title: 'Focus' }).catch(() => undefined)
  }
  m.lastCheckpoint = cp
  // Pressure between checkpoints (attention.mode = hybrid): toast at level 2, pull a checkpoint early at 3.
  const a = s.attention
  if (s.session.active && !cp) {
    if (a.autoOpen) {
      await cli($, ['attention', a.reason])
      $.ui.toast(`🔴 Early checkpoint: ${a.reason}`, { timeoutMs: 8000 })
      await update($, view, (v): FocusView => ({ ...v, tab: 'queue', selected: null, revealQueue: true }))
      $.ui.open({ id: PANE, title: 'Focus' }).catch(() => undefined)
      m.lastJson = ''
    } else if (a.level === 2 && m.lastLevel < 2) {
      $.ui.toast(`🟡 ${a.reason}`, { timeoutMs: 6000 })
    }
  }
  m.lastLevel = a.level
  // Requests from the dashboard ("Re-decide"): run them as a prompt in this session once it is idle.
  for (const req of s.requests ?? []) {
    if (req.type !== 'prompt') continue
    await cli($, ['request', 'done', req.id])
    await $.prompt.submit({ text: req.text, asUser: true })
    m.lastJson = ''
  }
}

// Run a CLI command from a button, show its answer, redraw.
async function act($: EngineInterface, args: string[], then?: Partial<FocusView>) {
  const r = await cli($, args)
  await update($, view, v => ({ ...v, ...then, message: (r.text.split('\n')[0] ?? '').slice(0, 160) }))
  m.lastJson = ''
  await refresh($)
}

async function revealQueue($: EngineInterface) {
  await cli($, ['pull', 'queue'])
  await update($, view, x => ({ ...x, revealQueue: true }))
}

function go($: EngineInterface, patch: Partial<FocusView>) {
  bg(update($, view, x => ({ ...x, message: null, ...patch })))
}

function openPane($: EngineInterface) {
  $.ui.open({ id: PANE, title: 'Focus', focus: true }).catch(() => undefined)
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    m.isWorker = Boolean(await $.env.get('FOCUS_TASK'))
    if (m.isWorker) return started
    m.root = await $.session.root()
    m.cliPath = `${$.plugin.root}/bin/focus.mjs`
    m.enabled = await $.fs.exists(`${m.root}/.focus/config.json`)
    await $.command.register({ name: 'focus', description: 'Focus Hour: open the dashboard, or run a focus command (/focus start 60, /focus stop, /focus init)', argumentHint: '[init|start N|stop|report|…]' })
    if (m.enabled) {
      await refresh($)
      $.clock.every(3000, () => bg(refresh($)))
      const s = await read($, status)
      const hasNews = s && (s.resume.needsReview.length || s.resume.drafts.length || s.resume.waiting.length || s.resume.stopped.length || s.resume.last)
      if (hasNews) $.ui.open({ id: PANE, title: 'Focus' }).catch(() => undefined)
    }
    return started
  })

  on('command.run', { command: 'focus' }, async ($, e) => {
    const args = e.args.trim()
    if (!args) {
      if (!m.enabled) return { text: 'Focus Hour is not set up in this repo. Run: /focus init' }
      await refresh($)
      await $.ui.open({ id: PANE, title: 'Focus', focus: true })
      return { text: 'Focus dashboard opened.' }
    }
    const r = await cli($, args.match(/"[^"]*"|\S+/g)!.map(a => a.replace(/^"|"$/g, '')))
    if (args.startsWith('init')) {
      m.enabled = await $.fs.exists(`${m.root}/.focus/config.json`)
      if (m.enabled) $.clock.every(3000, () => bg(refresh($)))
    }
    m.lastJson = ''
    await refresh($)
    if (args.startsWith('start') && r.ok) openPane($)
    return { text: r.text || '(no output)' }
  })

  // Teach the main session the workflow (only where Focus Hour is set up).
  on('prompt.compose', async ($, e, next) => {
    const res = await next(e)
    if (!m.enabled || m.isWorker) return res
    const text = [
      '# Focus Hour',
      `This repo uses Focus Hour. The CLI is \`${m.cliPath}\` (run it with node, or as \`focus\` when it is on PATH); its state is in .focus/ and decisions in docs/decisions/.`,
      '- Decisions: when the user must choose, ask with AskUserQuestion in batches of up to 4 independent questions, recommended option first.',
      '  Tag each question in metadata.source as `focus@<feature area>:<tag>,…` in order: `new`, `new:<slug>` (questions forming one decision), `D012` (revisiting it), or `-` (not a decision).',
      '  The feature area is a short, stable name of the part of the product the batch is about (e.g. "Batching", "Trace replay"); reuse existing areas (`focus decision list` shows them) instead of inventing near-duplicates.',
      '  After the answer, Focus Hour reports the draft ids it recorded: fill each with `focus decision edit <id> --why "<plain-language reason>" --depends <ids it builds on> [--area "<feature area>"]`.',
      '  depends_on is what makes the Focus map: list every earlier decision this one would have to be revisited for if it changed.',
      '  If the user states a decision in free text, offer a yes/no AskUserQuestion to record it.',
      '- Flow: when a step of the work completes or the plan changes, run `focus flow "<done ✓ → current ▶ → next>"` (one line).',
      '- Side work (tests, docs, scripts, verification) that the user wants in the background: use the focus-task skill; never do it yourself in parallel.',
      '- Do not report on background tasks unless asked: the user reviews them at checkpoints in the Focus pane.',
    ].join('\n')
    return { ...res, sections: [...res.sections, { id: 'focus-hour:workflow', text, scope: 'session' as const }] }
  })

  // Record decisions from the user's own answers.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const ran = await next(e)
    if (!m.enabled || m.isWorker || ran.deny !== undefined || ran.isError) return ran
    const answers = (ran.result as { answers?: Record<string, string> } | undefined)?.answers
    if (!answers) return ran
    const source = e.metadata?.source ?? ''
    // metadata.source: `focus:<tags>` or `focus@<feature area>:<tags>`
    const tagged = /^focus(?:@([^:]+))?:(.*)$/.exec(source)
    const tags = tagged ? tagged[2]!.split(',').map(s => s.trim()) : undefined
    const area = tagged?.[1]?.trim()
    const s = await read($, status)
    bg(cli($, ['event', 'ask', '--questions', String(e.questions.length), ...(tags ? ['--tagged'] : [])]))
    const r = await cli($, ['decision', 'capture'], JSON.stringify({ questions: e.questions, answers, tags, area, session: s?.session.id }))
    if (!r.ok) return ran
    const res = JSON.parse(r.text) as { id: string; action: string; of?: string; kind?: string }[]
    const made = res.filter(x => x.action === 'new' || x.action === 'supersedes')
    if (!res.length) return ran
    m.lastJson = ''
    bg(refresh($))
    const impact = res.filter(x => x.action === 'impact').map(x => x.id)
    const note = [
      made.length ? `Focus Hour recorded draft decision(s): ${made.map(x => (x.of ? `${x.id} (supersedes ${x.of})` : x.id)).join(', ')}. Fill each with \`focus decision edit <id> --why "…" --depends …\`.` : '',
      impact.length ? `Affected by the change (now needs review / stale): ${impact.join(', ')}. Tell the user in one line.` : '',
    ].filter(Boolean).join(' ')
    return note ? { ...ran, context: [...(ran.context ?? []), note] } : ran
  })

  // Seconds the human waits on the main session (metric ⑦).
  on('prompt.submit', async ($, e, next) => {
    m.turnStartedAt = await $.clock.now()
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (m.enabled && !m.isWorker && e.agentId === undefined && m.turnStartedAt) bg(cli($, ['event', 'turn', '--ms', String(e.durationMs)]))
    return next(e)
  })

  // ---------- drawing ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, status)
    if (!m.enabled || m.isWorker || !s || e.props.hasSurvey || s.config.paneOutsideCheckpoint === 'hidden') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1}>
        <Text dimColor={!s.session.current && s.attention.level === 0} color={LEVEL_COLOR[s.attention.level]} wrap="truncate">{headline(s)}{s.attention.level >= 2 ? ` · ${s.attention.reason}` : ''}</Text>
        <Button key="open" plain label="open" onPress={() => openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text: MText } = $.ui.resolve(e)
      return <MText>Open the Focus pane in the terminal or desktop app.</MText>
    }
    const { Box, Text, Button, Input, Link } = $.ui.resolve(e)
    const s = await read($, status)
    const v = await read($, view)
    if (!m.enabled || !s) return <Text dimColor>Focus Hour is not set up here. Type /focus init</Text>
    const go = (patch: Partial<FocusView>) => () => bg(update($, view, x => ({ ...x, message: null, ...patch })))
    const drafts = s.decisions.filter(d => d.status === 'draft').length
    const review = s.decisions.filter(d => d.status === 'dead').length
    const waiting = s.tasks.filter(t => t.status === 'review' || t.status === 'stopped').length

    const header = (
      <Box flexDirection="column">
        <Text bold color={LEVEL_COLOR[s.attention.level]} wrap="truncate">{headline(s)}</Text>
        {s.attention.level >= 1 && !s.session.current ? <Text color={LEVEL_COLOR[s.attention.level]} wrap="truncate">{['', '●', '▲', '■'][s.attention.level]} {s.attention.reason}</Text> : null}
        <Box flexDirection="row" gap={1}>
          <Button key="tab-s" hotkey="s" label="Session" variant={v.tab === 'session' ? 'primary' : undefined} onPress={go({ tab: 'session', selected: null })} />
          <Button key="tab-d" hotkey="d" label={`Decisions${drafts ? ` ✎${drafts}` : ''}${review ? ` ⚠${review}` : ''}`} variant={v.tab === 'decisions' ? 'primary' : undefined} onPress={go({ tab: 'decisions', selected: null })} />
          <Button key="tab-q" hotkey="q" label={`Queue${waiting ? ` 🔵${waiting}` : ''}`} variant={v.tab === 'queue' ? 'primary' : undefined} onPress={go({ tab: 'queue', selected: null })} />
          {s.session.active
            ? <Button key="stop" label="Stop hour" onPress={() => bg(act($, ['stop']))} />
            : <Button key="start" label={`Start ${s.config.mode === 'observe' ? 'observe' : 'hour'}`} onPress={() => bg(act($, ['start']))} />}
        </Box>
        {v.message ? <Text dimColor wrap="truncate">{v.message}</Text> : null}
        {!s.workerAlive && s.tasks.some(t => t.status === 'queued') ? <Text color="yellow">No worker running: start `focus worker` in a terminal.</Text> : null}
      </Box>
    )

    let body
    if (v.tab === 'session') body = sessionView(s)
    else if (v.tab === 'decisions') {
      const d = s.decisions.find(x => x.id === v.selected)
      body = d ? decisionDetail(d) : decisionList(s.decisions)
    } else {
      const gated = s.session.collapsed && !v.revealQueue
      const t = s.tasks.find(x => x.id === v.selected)
      body = gated ? (
        <Box flexDirection="column">
          <Text dimColor>Queue is quiet until checkpoint #{s.session.upcoming} in {fmt(s.session.inMs)}. Keep building the core.</Text>
          <Button key="reveal" label="Show anyway (counts as a pull)" onPress={() => bg(revealQueue($))} />
        </Box>
      ) : t ? taskDetail(t) : taskList(s.tasks)
    }
    return <Box flexDirection="column" gap={1}>{header}{body}</Box>

    function sessionView(st: FocusStatus) {
      const r = st.resume
      return (
        <Box flexDirection="column">
          <Text bold>Flow{st.flow.derived ? ' (derived)' : ''}</Text>
          <Text>{st.flow.text}</Text>
          {r.last?.resumeFrom ? <Text dimColor>Last hour ({r.last.id}) stopped at: {r.last.resumeFrom}</Text> : null}
          {r.needsReview.map(d => <Button key={`rv-${d.id}`} plain label={`⚠ ${d.id} ${d.title ?? ''} — ${d.reason ?? ''}`} onPress={go({ tab: 'decisions', selected: d.id })} />)}
          {r.drafts.length ? <Button key="rv-drafts" plain label={`✎ ${r.drafts.length} draft decision(s) to confirm`} onPress={go({ tab: 'decisions', selected: null })} /> : null}
          {r.waiting.map(t => <Button key={`rv-${t.id}`} plain label={`🔵 ${t.id} ${t.title}${t.stale ? ' ⚠stale' : ''}`} onPress={go({ tab: 'queue', selected: t.id })} />)}
          {r.stopped.map(t => <Button key={`rv-${t.id}`} plain label={`🔥 ${t.id} ${t.title} (${t.trigger})`} onPress={go({ tab: 'queue', selected: t.id })} />)}
        </Box>
      )
    }

    function decisionList(ds: FocusDecision[]) {
      const shown = ds.filter(d => d.status !== 'superseded' && d.status !== 'rejected')
      if (!shown.length) return <Text dimColor>No decisions yet. They are recorded from your AskUserQuestion answers.</Text>
      const order = (d: FocusDecision) => (d.status === 'dead' ? 0 : d.status === 'draft' ? 1 : 2)
      return (
        <Box flexDirection="column">
          {[...shown].sort((a, b) => order(a) - order(b) || b.id.localeCompare(a.id)).map(d => (
            <Button key={`d-${d.id}`} plain label={`${DMARK[d.status] ?? '?'} ${d.id} ${d.title ?? ''}${d.dependents.length ? ` · affects ${d.dependents.length}` : ''}`} onPress={go({ selected: d.id })} />
          ))}
        </Box>
      )
    }

    function decisionDetail(d: FocusDecision) {
      return (
        <Box flexDirection="column">
          <Text bold>{DMARK[d.status]} {d.id} · {d.title} [{d.status}]</Text>
          {d.review_reason ? <Text color="yellow">⚠ {d.review_reason}</Text> : null}
          <Text>Q: {d.question ?? '-'}</Text>
          <Text>Chose: {d.chosen ?? '-'}   Rejected: {d.rejected.join(', ') || '-'}</Text>
          <Text>Why: {d.why || '(not filled yet)'}</Text>
          <Text dimColor>Builds on: {d.depends_on.join(', ') || '-'}{d.supersedes ? ` · replaces ${d.supersedes}` : ''}{d.evidence ? ` · evidence ${d.evidence}` : ''}</Text>
          <Text dimColor>If this changes, it affects:</Text>
          {(d.impact.length ? d.impact : ['(nothing)']).map((l, i) => <Text key={`i-${i}`} dimColor>  {l}</Text>)}
          <Box flexDirection="row" gap={1}>
            {d.status === 'draft' ? <Button key="ok" hotkey="y" variant="primary" label="✓ Confirm" onPress={() => bg(act($, ['decision', 'confirm', d.id], { selected: null }))} /> : null}
            {d.status === 'draft' ? <Button key="no" hotkey="n" label="✗ Reject" onPress={() => bg(act($, ['decision', 'reject', d.id], { selected: null }))} /> : null}
            {d.status === 'dead' ? <Button key="rv" hotkey="y" variant="primary" label="Still holds" onPress={() => bg(act($, ['decision', 'revive', d.id], { selected: null }))} /> : null}
            {d.status === 'dead' ? <Button key="rd" hotkey="r" label="Re-decide" onPress={() => bg(act($, ['decision', 'redecide', d.id], { selected: null }))} /> : null}
            {d.status === 'active' && !d.adr ? <Button key="adr" label="Promote to ADR" onPress={() => bg(act($, ['decision', 'promote', d.id]))} /> : null}
            <Button key="back" hotkey="b" label="Back" onPress={go({ selected: null })} />
          </Box>
          {d.status === 'draft' || d.status === 'dead'
            ? <Input key="why" placeholder="Why, in your words (Enter saves)" onSubmit={(value: string) => bg(act($, ['decision', 'edit', d.id, '--why', value]))} />
            : null}
        </Box>
      )
    }

    function taskList(ts: FocusTask[]) {
      const shown = ts.filter(t => t.status !== 'approved' && t.status !== 'dropped')
      if (!shown.length) return <Text dimColor>No tasks. Give side work to a worker with the focus-task skill.</Text>
      const order: Record<string, number> = { stopped: 0, review: 1, ready: 2, running: 3, queued: 4 }
      return (
        <Box flexDirection="column">
          {[...shown].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)).map(t => (
            <Button key={`t-${t.id}`} plain onPress={go({ selected: t.id })}
              label={`${ICON[t.status] ?? '?'} ${t.id} ${t.level} ${t.title}${t.stale.length ? ' ⚠stale' : ''}${t.prNumber ? ` · PR #${t.prNumber}` : ''}${t.status === 'queued' && t.waits ? ` · waits: ${t.waits}` : ''}${t.status === 'stopped' ? ` · ${t.andon?.trigger}` : ''}`} />
          ))}
        </Box>
      )
    }

    function taskDetail(t: FocusTask) {
      const c = t.checks
      const ok = (b: boolean) => (b ? '✅' : '⚠ ')
      const needsPredict = t.status === 'review' && s!.config.predict !== 'off' && !t.prediction && !t.predictionSkipped
      const back = <Button key="back" hotkey="b" label="Back" onPress={go({ selected: null })} />
      if (t.status === 'stopped') {
        return (
          <Box flexDirection="column">
            <Text bold>🔥 {t.id} · {t.title}</Text>
            <Text color="red">{t.andon?.trigger}: {t.andon?.reason}</Text>
            <Input key="resume" placeholder="Resume with an instruction (Enter)" onSubmit={(value: string) => bg(act($, ['resume', t.id, value], { selected: null }))} />
            <Box flexDirection="row" gap={1}>
              <Button key="lt" label="Stop was right" onPress={() => bg(act($, ['label', t.id, 'true']))} />
              <Button key="lf" label="False alarm" onPress={() => bg(act($, ['label', t.id, 'false']))} />
              <Button key="drop" label="Drop" onPress={() => bg(act($, ['drop', t.id], { selected: null }))} />
              {back}
            </Box>
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Text bold>{ICON[t.status]} {t.id} · {t.title} · {t.level}{t.escalations ? ' (escalated)' : ''} · ${t.costUsd.toFixed(2)}</Text>
          {t.stale.length ? <Text color="yellow">⚠ stale: {t.staleReason}</Text> : null}
          {c ? (
            <Box flexDirection="column">
              <Text>{ok(!c.outOfScope.length)} scope {t.scope.join(', ')}{c.outOfScope.length ? ` (outside: ${c.outOfScope.join(', ')})` : ''}</Text>
              <Text>{ok(c.testsDelta >= 0)} tests {c.testsDelta >= 0 ? '+' : ''}{c.testsDelta} · {ok(!c.mocksAdded)} mocks +{c.mocksAdded} · {ok(c.testsPass)} {s!.config.testCommand} {c.testsPass ? 'passed' : 'FAILED'}</Text>
              <Text dimColor>+{c.added} / -{c.removed} in {c.files.length} file(s)</Text>
            </Box>
          ) : <Text dimColor>{t.status === 'queued' ? `waiting: ${t.waits ?? 'next tick'}` : 'working…'}</Text>}
          {t.packet ? <Text dimColor>Agent says: {t.packet.summary}{t.packet.risks?.length ? ` · risks: ${t.packet.risks.join('; ')}` : ''}</Text> : null}
          {needsPredict ? (
            <Box flexDirection="column">
              <Input key="predict" placeholder="Predict the diff in one line, then Enter" onSubmit={(value: string) => bg(act($, ['predict', t.id, value]))} />
              {s!.config.predict === 'optional' ? <Button key="skip" label="Skip prediction (counted)" onPress={() => bg(act($, ['skip', t.id]))} /> : null}
            </Box>
          ) : null}
          {t.status === 'review' && !needsPredict ? (
            <Box flexDirection="column">
              {t.prediction ? <Text dimColor>You predicted: {t.prediction}</Text> : null}
              {t.prUrl ? <Link key="pr" href={t.prUrl} label={`Open PR #${t.prNumber} ↗`} /> : <Text dimColor>Local branch focus/{t.id}{t.publishError ? ` (${t.publishError})` : ''} — `focus show {t.id} --diff`</Text>}
              <Box flexDirection="row" gap={1}>
                {t.prediction && t.predictionMatch === null ? <Button key="my" label="Prediction ✓" onPress={() => bg(act($, ['match', t.id, 'yes']))} /> : null}
                {t.prediction && t.predictionMatch === null ? <Button key="mn" label="Prediction ✗" onPress={() => bg(act($, ['match', t.id, 'no']))} /> : null}
                <Button key="approve" hotkey="a" variant="primary" label={t.prNumber ? 'Approve & merge' : 'Approve'} onPress={() => bg(act($, ['approve', t.id], { selected: null }))} />
                <Button key="drop" label="Drop" onPress={() => bg(act($, ['drop', t.id], { selected: null }))} />
              </Box>
              <Input key="rework" placeholder="Rework: what to change (Enter)" onSubmit={(value: string) => bg(act($, ['rework', t.id, value], { selected: null }))} />
            </Box>
          ) : null}
          {back}
        </Box>
      )
    }
  })
}

function headline(s: FocusStatus) {
  const n = (st: string) => s.tasks.filter(t => t.status === st).length
  const drafts = s.decisions.filter(d => d.status === 'draft').length
  const review = s.decisions.filter(d => d.status === 'dead').length
  const counts = `🔵${n('review')} 🔥${n('stopped')} 🟢${n('running')} ⚪${n('queued')} · ✎${drafts} ⚠${review}`
  const c = s.session
  if (!c.active) return `Focus · not started · ${counts}`
  if (c.overtime) return `Focus · ⏹ time's up · ${counts}`
  const head = c.pulledEarly ? '👀 EARLY CHECKPOINT' : c.current ? `👀 CHECKPOINT #${c.current}` : `⏱ ${fmt(c.left)} · 👀 #${c.upcoming} in ${fmt(c.inMs)}`
  return `Focus · ${head}${c.mode === 'observe' ? ' · observe' : ''} · ${counts}`
}
