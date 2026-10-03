// Shared helpers: repo paths, JSON state, the event log, frontmatter, git/process calls.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const now = () => Date.now()
export const iso = (ms = now()) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

export function die(msg, code = 1) {
  console.error(msg)
  process.exit(code)
}

// ---------- paths ----------

export function findRoot(cwd = process.cwd()) {
  if (process.env.FOCUS_ROOT) return process.env.FOCUS_ROOT
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return cwd
  }
}

export function paths(root) {
  const focus = join(root, '.focus')
  const state = join(focus, 'state')
  return {
    root,
    focus,
    config: join(focus, 'config.json'),
    sessions: join(focus, 'sessions'),
    state,
    session: join(state, 'session.json'),
    events: join(state, 'events.jsonl'),
    flow: join(state, 'flow.md'),
    tasks: join(state, 'tasks'),
    inbox: join(state, 'inbox'),
    packets: join(state, 'packets'),
    // Outside the repo, so a worker never confuses its copy with the main checkout.
    worktrees: process.env.FOCUS_WORKTREES ?? join(homedir(), '.focus-hour', 'worktrees', `${basename(root)}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`),
    logs: join(state, 'logs'),
    workerPid: join(state, 'worker.pid'),
  }
}

// ---------- files ----------

export function readJson(file, fallback) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// Write via a temp file + rename so a concurrent reader never sees half a file.
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

export function readText(file, fallback = '') {
  return existsSync(file) ? readFileSync(file, 'utf8') : fallback
}

export function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

export const listDir = dir => (existsSync(dir) ? readdirSync(dir) : [])

// ---------- event log (the trial's raw data) ----------

export function logEvent(p, type, data = {}) {
  mkdirSync(p.state, { recursive: true })
  const session = readJson(p.session, null)
  const row = { t: now(), type, session: session?.active ? session.id : null, ...data }
  appendFileSync(p.events, JSON.stringify(row) + '\n')
  return row
}

export function readEvents(p) {
  return readText(p.events)
    .split('\n')
    .filter(Boolean)
    .map(l => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// ---------- frontmatter (the YAML subset the decision files use) ----------

const SAFE = /^[A-Za-z0-9_][A-Za-z0-9 _.,\-\/:×=+()%<>≥≤~#@]*$/

function fmtScalar(v) {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const s = String(v)
  return SAFE.test(s) && !s.endsWith(' ') && !/^(true|false|null|\d+(\.\d+)?)$/.test(s) && !s.includes(', ') ? s : JSON.stringify(s)
}

function fmtValue(v) {
  if (Array.isArray(v)) return `[${v.map(x => (SAFE.test(String(x)) && !String(x).includes(',') ? String(x) : JSON.stringify(String(x)))).join(', ')}]`
  return fmtScalar(v)
}

function splitItems(inner) {
  const items = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '"' && inner[i - 1] !== '\\') quoted = !quoted
    if (c === ',' && !quoted) {
      items.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur.trim() !== '') items.push(cur)
  return items.map(s => s.trim()).filter(s => s !== '')
}

function parseScalar(raw) {
  const s = raw.trim()
  if (s === '') return null
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s)
    } catch {
      return s.slice(1, -1)
    }
  }
  return s
}

function parseValue(raw) {
  const s = raw.trim()
  if (s.startsWith('[') && s.endsWith(']')) return splitItems(s.slice(1, -1)).map(parseScalar)
  return parseScalar(s)
}

export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return { data: {}, body: text }
  const data = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):(.*)$/.exec(line)
    if (kv) data[kv[1]] = parseValue(kv[2])
  }
  return { data, body: m[2].replace(/^\n/, '') }
}

export function stringifyFrontmatter(data, body = '') {
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${fmtValue(v)}`.trimEnd())
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`
}

// ---------- processes ----------

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') }
}

export const git = (cwd, ...args) => run('git', args, { cwd })

export function readStdin() {
  try {
    const text = readFileSync(0, 'utf8')
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const asList = v => (Array.isArray(v) ? v : v === null || v === undefined || v === '' ? [] : String(v).split(',').map(s => s.trim()).filter(Boolean))
