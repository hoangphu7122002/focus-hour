// GitHub side of a task's PR (pack 2): read state, comments and reviews; tell human feedback from Focus Hour's own
// comments (same account, so by a marker); draft ↔ ready; post replies.
import { run } from './util.mjs'

export const MARKER = '<!-- focus-hour -->'

const gh = (p, args) => run('gh', args, { cwd: p.root })
const json = (p, args) => {
  const r = gh(p, args)
  if (r.code !== 0) return null
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

export function repoSlug(p) {
  return json(p, ['repo', 'view', '--json', 'nameWithOwner'])?.nameWithOwner ?? null
}

// Everything the watcher needs about one PR, in one shape.
export function prSnapshot(p, n, slug = repoSlug(p)) {
  const pr = json(p, ['pr', 'view', String(n), '--json', 'state,isDraft,mergedAt,closedAt,headRefOid,url,reviewDecision,comments,reviews'])
  if (!pr) return null
  const inline = slug ? json(p, ['api', `repos/${slug}/pulls/${n}/comments`, '--paginate']) ?? [] : []
  const items = [
    ...(pr.comments ?? []).map(c => ({ id: `c:${c.id}`, kind: 'comment', who: c.author?.login, assoc: c.authorAssociation, body: c.body ?? '', at: c.createdAt })),
    ...(pr.reviews ?? []).filter(r => (r.body ?? '').trim() || r.state === 'CHANGES_REQUESTED').map(r => ({ id: `r:${r.id}`, kind: 'review', who: r.author?.login, assoc: r.authorAssociation, state: r.state, body: r.body ?? '', at: r.submittedAt })),
    ...inline.map(c => ({ id: `i:${c.id}`, kind: 'inline', who: c.user?.login, assoc: c.author_association, body: c.body ?? '', path: c.path, line: c.line ?? c.original_line, at: c.created_at, inReplyTo: c.in_reply_to_id })),
  ]
  return { state: pr.state, isDraft: pr.isDraft, mergedAt: pr.mergedAt, headSha: pr.headRefOid, url: pr.url, decision: pr.reviewDecision, items }
}

// Human feedback not handled yet: trusted authors, not written by Focus Hour, not a bare approval.
export function newFeedback(task, snap, cfg) {
  const seen = new Set(task.seenFeedback ?? [])
  const trusted = new Set(cfg.watch.trusted)
  return snap.items.filter(i =>
    !seen.has(i.id) &&
    !String(i.body).includes(MARKER) &&
    (trusted.has(i.assoc) || !i.assoc) &&
    !/\[bot\]$/.test(i.who ?? '') &&
    (i.body.trim() || i.state === 'CHANGES_REQUESTED') &&
    !(i.kind === 'review' && i.state === 'APPROVED' && !i.body.trim()),
  )
}

export function feedbackNote(prNumber, items) {
  return [
    `Review comments on PR #${prNumber} (from the human):`,
    ...items.map(i => `- ${i.path ? `${i.path}${i.line ? `:${i.line}` : ''}: ` : ''}${i.body.replace(/\s+/g, ' ').trim()}`),
    'Address every comment within your scope. In the packet, add "replies": one line per comment saying what you changed,',
    'and "lessons": a rule for future work if a comment generalises (e.g. "[backend/] keep domain logic out of controllers").',
  ].join('\n')
}

export const comment = (p, n, body) => gh(p, ['pr', 'comment', String(n), '--body', `${body}\n\n${MARKER}`]).code === 0
export const markReady = (p, n) => gh(p, ['pr', 'ready', String(n)]).code === 0
export const markDraft = (p, n) => gh(p, ['pr', 'ready', String(n), '--undo']).code === 0
