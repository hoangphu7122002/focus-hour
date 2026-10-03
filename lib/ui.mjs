// `focus ui`: a local web dashboard (open it in VS Code's Simple Browser, beside the chat).
// Serves ui/index.html, GET /api/status, POST /api/act (a fixed list of CLI commands). Listens on 127.0.0.1 only.
// Also does what the mod does between checkpoints: a macOS notification when attention rises, and an early
// checkpoint when it reaches level 3.
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.mjs'
import { notePressureOpen } from './session.mjs'
import { status } from './status.mjs'
import { readText, run } from './util.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'bin', 'focus.mjs')

// Commands a button may run, by their first words.
const ALLOWED = [
  ['start'], ['stop'], ['pull'], ['flow'],
  ['decision', 'confirm'], ['decision', 'reject'], ['decision', 'ok'], ['decision', 'revive'], ['decision', 'redecide'], ['decision', 'edit'], ['decision', 'promote'],
  ['predict'], ['skip'], ['match'], ['approve'], ['drop'], ['rework'], ['resume'], ['label'],
]
export const isAllowed = args => Array.isArray(args) && args.every(a => typeof a === 'string') && ALLOWED.some(pre => pre.every((w, i) => args[i] === w))

function notify(title, text) {
  if (process.platform !== 'darwin') return
  const q = s => JSON.stringify(String(s).slice(0, 200))
  spawnSync('osascript', ['-e', `display notification ${q(text)} with title ${q(title)}`])
}

export function serve(p, { port = 7777, log = console.log } = {}) {
  let lastLevel = 0
  let lastCheckpoint = 0

  // Between checkpoints: notify on level 2, pull a checkpoint early on level 3 (same rules as the mod).
  const watch = () => {
    try {
      const cfg = loadConfig(p)
      const s = status(p, cfg)
      const cp = s.session.active ? s.session.current : 0
      if (cp && cp !== lastCheckpoint) notify('Focus Hour', `👀 Checkpoint #${cp}: open the dashboard`)
      lastCheckpoint = cp
      if (s.session.active && !cp) {
        if (s.attention.autoOpen && notePressureOpen(p, cfg, s.attention.reason)) notify('Focus Hour · early checkpoint', s.attention.reason)
        else if (s.attention.level === 2 && lastLevel < 2) notify('Focus Hour', s.attention.reason)
      }
      lastLevel = s.attention.level
    } catch {}
  }
  const timer = setInterval(watch, 3000)

  const server = createServer((req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' })
      res.end(type === 'application/json' ? JSON.stringify(body) : body)
    }
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) return send(200, readText(join(ROOT, 'ui', 'index.html')), 'text/html')
    if (req.method === 'GET' && req.url === '/graph.js') return send(200, readText(join(ROOT, 'ui', 'graph.js')), 'text/javascript')
    if (req.method === 'GET' && req.url === '/api/status') {
      try {
        return send(200, status(p, loadConfig(p)))
      } catch (e) {
        return send(500, { error: String(e.message ?? e) })
      }
    }
    if (req.method === 'POST' && req.url === '/api/act') {
      let body = ''
      req.on('data', d => (body += d))
      req.on('end', () => {
        let args
        try {
          args = JSON.parse(body).args
        } catch {
          return send(400, { error: 'bad json' })
        }
        if (!isAllowed(args)) return send(403, { error: `not allowed: ${JSON.stringify(args)}` })
        const r = run('node', [CLI, ...args], { cwd: p.root, env: { ...process.env, FOCUS_ROOT: p.root } })
        log(`  ${args.join(' ')} → ${r.code === 0 ? 'ok' : 'error'}`)
        send(200, { ok: r.code === 0, text: (r.stdout || r.stderr).trim() })
      })
      return
    }
    send(404, { error: 'not found' })
  })
  server.on('close', () => clearInterval(timer))
  server.listen(port, '127.0.0.1', () => {
    log(`Focus dashboard: http://127.0.0.1:${port}`)
    log('In VS Code: Cmd+Shift+P → "Simple Browser: Show" → paste the URL, then drag the tab beside the chat.')
  })
  return server
}
