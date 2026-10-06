// .focus/config.json: every key optional, merged over these defaults.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, readText, writeJson, writeText } from './util.mjs'

import { detectBach } from './bach.mjs'

export const DEFAULTS = {
  focusMinutes: 60,
  checkpoints: [20, 40, 52],
  checkpointWindowMinutes: 3,
  // hybrid: fixed checkpoints are the latest you look; pressure (work waiting on you) can pull one earlier.
  // fixed: checkpoints only. Levels: 0 quiet · 1 something waits · 2 toast (waited > waitWarnMinutes or review queue full)
  // · 3 auto-open (a worker is blocked on you, or a task stopped), at most once per minGapMinutes.
  attention: { mode: 'hybrid', waitWarnMinutes: 10, minGapMinutes: 10, readyWarn: 2 },
  // Main session effort during a focus hour: each turn starts at `ask`; once it edits code, `code`. null: hands off.
  mainEffort: { ask: 'low', code: 'medium' },
  paneOutsideCheckpoint: 'collapsed',
  // reviewCap: PRs open and waiting for you. readyBuffer: finished-but-unpublished tasks allowed (null = no limit).
  wip: { running: 3, reviewCap: 2, readyBuffer: null },
  resources: {},
  levels: {
    L1: { model: 'haiku', effort: 'low', maxTurns: 30 },
    L2: { model: 'sonnet', effort: 'medium', maxTurns: 60 },
    L3: { model: 'opus', effort: 'high', maxTurns: 80 },
  },
  escalate: { max: 1, on: ['loop', 'budget', 'tests-failing'] },
  detectors: { lineBudget: 300, callBudget: 60, repeatLimit: 3 },
  predict: 'optional',
  mode: 'focus',
  testCommand: 'npm test',
  baseBranch: 'main',
  decisionsDir: 'docs/decisions',
  adrDir: 'docs/ADR',
  captureUntagged: true,
  worker: { allowedTools: [], maxBudgetUsd: 3, claudeBin: 'claude' },

  // Languages: what Claude speaks to you in, and what code, commits, PRs and docs are written in. null: no rule.
  language: { chat: null, code: 'en' },

  // Features (pack 1): the roadmap the plan skill reads features from; finishing one queues the plan of the next.
  roadmap: null, // e.g. "scope/2026-10-05-x/roadmap.md"
  autoAdvance: true,

  // Review (pack 2): a reviewer for big PRs, opened as drafts until it finishes; comments on a PR become rework.
  review: {
    model: 'opus', effort: 'medium', maxTurns: 40,
    bigLines: 300, // a PR over this many changed lines is big
    bigPaths: ['migrations/', 'schema', 'api/', 'openapi', 'auth', 'security'], // any changed path containing one is big
    uiGlobs: ['.tsx', '.jsx', '.vue', '.svelte', '.css', '.scss', '.html'], // file endings that make a PR a UI change
    always: false, // review every PR, not only big ones
    maxParallel: 3, // reviewers alive at once (bach's max_reviewers)
    maxFixRounds: 3, // after this many rework rounds on one PR, it waits for you
  },
  watch: { intervalSeconds: 60, trusted: ['OWNER', 'MEMBER', 'COLLABORATOR'] },

  // Guardrails (pack 3): run on a fresh copy of the base branch after every merge; red if main is broken.
  smokeCommand: null, // e.g. "make check" or "npm ci && npm test && npm run build"
  lessonsFile: '.focus/lessons.md',

  // Environment slots (pack 4): each running task gets slot N with its own ports and env, so parallel workers do
  // not collide. {slot} is replaced by N. setup/teardown run in the task's worktree.
  worktreeSetup: null, // run once in each new task worktree, e.g. "npm ci --prefix frontend && uv sync --directory backend"
  slots: null, // e.g. { "count": 4, "ports": { "API_PORT": 8200, "WEB_PORT": 5300 }, "env": { "DB_NAME": "app_s{slot}" }, "setup": "make db-slot SLOT={slot}" }
  infraGuard: true, // workers may not run docker / compose / make up|down|dev (safety stop)
  screenshots: { enabled: true, dir: '.focus-shots' }, // PNGs a worker leaves there are embedded in the PR body
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v)

export function merge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = isObj(base?.[k]) && isObj(v) ? merge(base[k], v) : v
  return out
}

export function loadConfig(p) {
  return merge(DEFAULTS, readJson(p.config, {}))
}

export const levelNames = cfg => Object.keys(cfg.levels).sort()

export function nextLevel(cfg, level) {
  const names = levelNames(cfg)
  const i = names.indexOf(level)
  return i >= 0 && i < names.length - 1 ? names[i + 1] : null
}

// Checkpoints are written for a 60-minute hour and scale with focusMinutes.
export const checkpointMinutes = (cfg, minutes) => cfg.checkpoints.map(c => (c / 60) * minutes)

export function detectTestCommand(root) {
  const has = f => existsSync(join(root, f))
  const make = has('Makefile') ? readText(join(root, 'Makefile')) : ''
  if (/^test:/m.test(make)) return 'make test'
  if (/^check:/m.test(make)) return 'make check'
  if (has('package.json')) {
    const pkg = readJson(join(root, 'package.json'), {})
    if (pkg.scripts?.test) return 'npm test'
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.cfg')) return has('uv.lock') ? 'uv run pytest' : 'pytest'
  if (has('go.mod')) return 'go test ./...'
  if (has('Cargo.toml')) return 'cargo test'
  return 'npm test'
}

// Commands a worker needs for this kind of project, so it never stalls on a permission (bach: 85% of teammate Bash
// calls missed the allowlist). Infra commands stay blocked by the infra guard whatever is listed here.
export function detectAllowedTools(root) {
  // A monorepo keeps its stacks one level down (backend/pyproject.toml, frontend/package.json).
  let subs = []
  try { subs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !/^[._]|^node_modules$/.test(d.name)).map(d => d.name) } catch {}
  const has = f => existsSync(join(root, f)) || subs.some(s => existsSync(join(root, s, f)))
  const out = []
  if (has('package.json')) out.push('Bash(npm run:*)', 'Bash(npm test:*)', 'Bash(npx vitest run:*)', 'Bash(npm ci)', 'Bash(npm install)', 'Bash(npx tsc:*)', 'Bash(npx vitest:*)', 'Bash(npx eslint:*)', 'Bash(npx playwright:*)', 'Bash(node:*)')
  if (has('pnpm-lock.yaml')) out.push('Bash(pnpm:*)')
  if (has('yarn.lock')) out.push('Bash(yarn:*)')
  if (has('pyproject.toml') || has('requirements.txt')) out.push('Bash(uv run:*)', 'Bash(uv sync)', 'Bash(pytest:*)', 'Bash(python -m pytest:*)', 'Bash(ruff:*)', 'Bash(mypy:*)')
  if (has('Makefile')) out.push('Bash(make check:*)', 'Bash(make test:*)', 'Bash(make lint:*)', 'Bash(make gen:*)', 'Bash(make build:*)')
  if (has('go.mod')) out.push('Bash(go test:*)', 'Bash(go build:*)', 'Bash(go vet:*)')
  if (has('Cargo.toml')) out.push('Bash(cargo test:*)', 'Bash(cargo build:*)', 'Bash(cargo clippy:*)')
  if (subs.some(s => ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'].some(f => existsSync(join(root, s, f))))) out.push('Bash(cd:*)', 'Bash(npm --prefix:*)')
  return [...new Set(out)]
}

// A fresh worktree has no node_modules or .venv: install from the lockfiles, at the root and one level down.
export function detectWorktreeSetup(root) {
  let dirs = ['.']
  try { dirs = dirs.concat(readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !/^[._]|^node_modules$/.test(d.name)).map(d => d.name)) } catch {}
  const steps = []
  for (const d of dirs) {
    const at = f => existsSync(join(root, d, f))
    if (at('package-lock.json')) steps.push(d === '.' ? 'npm ci --silent' : `npm ci --silent --prefix ${d}`)
    else if (at('pnpm-lock.yaml')) steps.push(d === '.' ? 'pnpm i --frozen-lockfile' : `pnpm i --frozen-lockfile --dir ${d}`)
    else if (at('yarn.lock')) steps.push(d === '.' ? 'yarn --frozen-lockfile' : `yarn --frozen-lockfile --cwd ${d}`)
    if (at('uv.lock')) steps.push(d === '.' ? 'uv sync -q' : `uv sync -q --directory ${d}`)
  }
  return steps.length ? steps.join(' && ') : null
}

export function detectBaseBranch(root, git) {
  const r = git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  if (r.code === 0) return r.stdout.trim().replace(/^origin\//, '')
  const cur = git(root, 'branch', '--show-current')
  return cur.stdout.trim() || 'main'
}

const GITIGNORE_LINES = ['.focus/state/']

export function init(p, git) {
  const created = !existsSync(p.config)
  if (created) {
    writeJson(p.config, {
      testCommand: detectTestCommand(p.root),
      baseBranch: detectBaseBranch(p.root, git),
      language: { chat: null, code: 'en' },
      smokeCommand: null,
      roadmap: null,
      resources: {},
      worker: { allowedTools: detectAllowedTools(p.root) },
      worktreeSetup: detectWorktreeSetup(p.root),
      ...detectBach(p.root), // a bach-scoped repo: its roadmap, review lessons and stack.toml slots
    })
  }
  const gi = join(p.root, '.gitignore')
  const text = readText(gi)
  const missing = GITIGNORE_LINES.filter(l => !text.split('\n').includes(l))
  if (missing.length) writeText(gi, text + (text && !text.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n')
  return { created, config: loadConfig(p) }
}
