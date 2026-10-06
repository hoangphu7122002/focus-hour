// The reviewer (pack 2): big PRs get a fresh read-only Claude (opus by default) before they leave draft.
// It reviews the diff against the task's spec, the feature's acceptance criteria and the project's lessons,
// and answers with a JSON verdict. Blockers send the task back to its worker; "ok" marks the PR ready.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { languageRule, lessonsForPrompt } from './guard.mjs'
import { git, readText } from './util.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Why this PR needs a reviewer, or [] when the machine checks are enough.
export function bigReasons(t, cfg) {
  const c = t.checks ?? {}
  const r = cfg.review
  const reasons = []
  if (r.always) reasons.push('every PR is reviewed')
  if ((c.added ?? 0) + (c.removed ?? 0) > r.bigLines) reasons.push(`${(c.added ?? 0) + (c.removed ?? 0)} changed lines`)
  const files = c.files ?? []
  const risky = files.filter(f => r.bigPaths.some(s => f.toLowerCase().includes(s.toLowerCase())))
  if (risky.length) reasons.push(`contract/security paths: ${risky.slice(0, 3).join(', ')}`)
  if (files.some(f => r.uiGlobs.some(g => f.endsWith(g)))) reasons.push('UI change')
  if (c.testsPass === false) reasons.push('tests fail')
  if ((c.mocksAdded ?? 0) > 0) reasons.push('adds mocks')
  if (t.stale?.length) reasons.push('built on a decision that changed')
  return reasons
}

export function reviewPrompt(p, cfg, t, { feature, since } = {}) {
  const range = since ? `${since}..HEAD` : `${git(t.worktree, 'merge-base', cfg.baseBranch, 'HEAD').stdout.trim() || cfg.baseBranch}..HEAD`
  const lessons = lessonsForPrompt(p, cfg, t.scope)
  return [
    `REVIEW PR #${t.prNumber ?? '(local)'} for Focus Hour task ${t.id}: ${t.title}`,
    `Working copy: ${t.worktree} (read only). Diff to review: git diff ${range}${since ? ' (only what changed since your last review)' : ''}.`,
    `Allowed scope of the task: ${t.scope.join(', ') || '(repo)'}. Test command: ${cfg.testCommand}.`,
    t.spec ? `\nTask spec:\n${t.spec}` : '',
    feature ? `\nFeature ${feature.id} · ${feature.name}\nGoal: ${feature.goal}${feature.ac?.length ? `\nAcceptance criteria: ${feature.ac.join(', ')}` : ''}` : '',
    t.packet ? `\nThe worker claims (verify, do not trust): ${JSON.stringify(t.packet)}` : '',
    lessons ? `\nProject lessons (rules from earlier reviews — a violation is a blocker):\n${lessons}` : '',
    languageRule(cfg, 'worker') ? `\n${languageRule(cfg, 'worker')}` : '',
  ].filter(Boolean).join('\n')
}

// Last JSON object in the reviewer's final text.
export function parseVerdict(text) {
  const s = String(text ?? '')
  for (let end = s.lastIndexOf('}'); end > 0; end = s.lastIndexOf('}', end - 1)) {
    for (let start = s.lastIndexOf('{', end); start >= 0; start = s.lastIndexOf('{', start - 1)) {
      try {
        const v = JSON.parse(s.slice(start, end + 1))
        if (v && (v.verdict === 'ok' || v.verdict === 'blocked')) {
          return { verdict: v.verdict, blockers: v.blockers ?? [], nits: v.nits ?? [], lessons: v.lessons ?? [], summary: v.summary ?? '' }
        }
      } catch {}
    }
  }
  return null
}

export function verdictComment(t, v, reasons) {
  const fmt = b => (typeof b === 'string' ? b : `${b.file ? `\`${b.file}${b.line ? `:${b.line}` : ''}\` ` : ''}${b.issue ?? ''}${b.fix ? ` → ${b.fix}` : ''}`)
  return [
    `**Focus Hour review · ${v.verdict === 'ok' ? '✅ no blockers' : '⛔ blocked'}** (why reviewed: ${reasons.join('; ')})`,
    v.summary ? `\n${v.summary}` : '',
    v.blockers.length ? `\n**Blockers** (sent back to the worker)\n${v.blockers.map(b => `- ${fmt(b)}`).join('\n')}` : '',
    v.nits.length ? `\n**Nits** (not blocking)\n${v.nits.slice(0, 5).map(b => `- ${fmt(b)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n')
}

export function runReviewer(p, cfg, t, opts = {}) {
  const r = cfg.review
  const allowed = ['Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', `Bash(${cfg.testCommand})`, `Bash(${cfg.testCommand}:*)`, 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(grep:*)', 'Bash(rg:*)']
  const args = [
    '-p', reviewPrompt(p, cfg, t, opts),
    '--model', r.model, '--effort', r.effort, '--max-turns', String(r.maxTurns),
    '--permission-mode', 'dontAsk', '--allowedTools', allowed.join(','),
    '--output-format', 'json',
    '--append-system-prompt', readText(join(PLUGIN_ROOT, 'prompts', 'reviewer.md')),
  ]
  mkdirSync(p.logs, { recursive: true })
  return new Promise(resolve => {
    const child = spawn(cfg.worker.claudeBin, args, { cwd: t.worktree, env: { ...process.env, FOCUS_REVIEW: t.id }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', e => resolve({ verdict: null, error: String(e) }))
    child.on('close', code => {
      writeFileSync(join(p.logs, `${t.id}-review-${Date.now()}.log`), `exit ${code}\n${out}\n--- stderr\n${err}\n`)
      let json = null
      try {
        json = JSON.parse(out.trim().split('\n').pop())
      } catch {}
      resolve({ verdict: parseVerdict(json?.result ?? out), costUsd: json?.total_cost_usd ?? 0, error: json ? null : (err || `exit ${code}`).slice(0, 300) })
    })
  })
}
