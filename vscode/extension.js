// Focus Hour for VS Code / Cursor: a docked "Focus map" view that shows the `focus ui` dashboard.
// It starts `focus ui` (dashboard + workers) for the open repo, reveals the view at checkpoints,
// and mirrors the headline in the status bar. All logic stays in the focus CLI.
const vscode = require('vscode')
const { spawn } = require('child_process')
const { existsSync, readdirSync } = require('fs')
const { homedir } = require('os')
const { join } = require('path')

let server = null // { proc, port, root }
let poll = null
let statusItem = null
let view = null
let last = { checkpoint: 0, early: false, level: 0 }

const cfg = () => vscode.workspace.getConfiguration('focusHour')
const expand = p => p.replace(/^~(?=\/|$)/, homedir())

// The focus CLI: the configured path, else the newest installed copy of the Claude Code plugin.
function findCli() {
  const configured = cfg().get('cliPath')
  if (configured && existsSync(expand(configured))) return expand(configured)
  const cache = join(homedir(), '.claude', 'plugins', 'cache')
  const found = []
  for (const market of safeList(cache)) {
    for (const version of safeList(join(cache, market, 'focus-hour'))) {
      const cli = join(cache, market, 'focus-hour', version, 'bin', 'focus.mjs')
      if (existsSync(cli)) found.push({ cli, version })
    }
  }
  const num = v => v.split('.').map(n => Number(n) || 0)
  found.sort((a, b) => { const x = num(a.version), y = num(b.version); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0 })
  return found[0]?.cli ?? null
}

function safeList(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function repoRoot() {
  const f = vscode.workspace.workspaceFolders?.find(w => existsSync(join(w.uri.fsPath, '.focus', 'config.json')))
  return f?.uri.fsPath ?? null
}

async function getStatus(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

// A dashboard for this repo: reuse one already serving it, else start one on the first free port.
async function ensureServer(root) {
  if (server && server.root === root) return server.port
  const base = cfg().get('port')
  for (let port = base; port < base + 20; port++) {
    const s = await getStatus(port)
    if (s && s.root === root) {
      server = { proc: null, port, root }
      return port
    }
    if (s) continue // another repo's dashboard
    const cli = findCli()
    if (!cli) {
      vscode.window.showErrorMessage('Focus Hour: CLI not found. Install the plugin (claude plugin install focus-hour@focus-hour) or set focusHour.cliPath.')
      return null
    }
    // GUI apps on macOS often start without the shell's PATH: add the usual places for node, claude, git, gh.
    const PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), '/usr/bin', '/bin'].filter(Boolean).join(':')
    // The editor's own runtime runs the CLI when no node is around (ELECTRON_RUN_AS_NODE).
    const node = cfg().get('nodePath') || 'node'
    const env = { ...process.env, PATH, FOCUS_ROOT: root }
    let proc = spawn(node, [cli, 'ui', '--port', String(port)], { cwd: root, env })
    await new Promise(r => { proc.once('spawn', r); proc.once('error', r) })
    if (proc.exitCode !== null || proc.pid === undefined) {
      proc = spawn(process.execPath, [cli, 'ui', '--port', String(port)], { cwd: root, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } })
    }
    const out = vscode.window.createOutputChannel('Focus Hour')
    proc.stdout.on('data', d => out.append(String(d)))
    proc.stderr.on('data', d => out.append(String(d)))
    proc.on('exit', code => {
      out.appendLine(`focus ui exited (${code})`)
      if (server?.proc === proc) server = null
    })
    server = { proc, port, root }
    for (let i = 0; i < 20 && !(await getStatus(port)); i++) await new Promise(r => setTimeout(r, 250))
    return port
  }
  vscode.window.showErrorMessage('Focus Hour: no free port for the dashboard.')
  return null
}

function stopServer() {
  if (server?.proc) server.proc.kill()
  server = null
}

function frameHtml(webview, port) {
  const url = `http://127.0.0.1:${port}/?embed=1`
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:${port}; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100vh;background:transparent;overflow:hidden}</style></head>
<body><iframe src="${url}"></iframe>
<script>
  const vscode = acquireVsCodeApi()
  // The dashboard asks us to open PR links outside the webview.
  window.addEventListener('message', e => { if (e.data && e.data.type === 'focus-open' && /^https?:/.test(e.data.url)) vscode.postMessage(e.data) })
</script></body></html>`
}

function emptyHtml(text) {
  return `<!doctype html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px">${text}</body></html>`
}

async function render(webview) {
  webview.options = { enableScripts: true }
  const root = repoRoot()
  if (!root) {
    webview.html = emptyHtml('No <code>.focus/config.json</code> in this workspace. Run <code>focus init</code> in the repo, then reload.')
    return
  }
  const port = await ensureServer(root)
  webview.html = port ? frameHtml(webview, port) : emptyHtml('Focus Hour dashboard did not start. See Output → Focus Hour.')
}

function onMessage(msg) {
  if (msg?.type === 'focus-open') vscode.env.openExternal(vscode.Uri.parse(msg.url))
}

const ICON = ['$(circle-outline)', '$(circle-filled)', '$(warning)', '$(error)']

async function tick() {
  if (!server) return
  const s = await getStatus(server.port)
  if (!s) return
  const c = s.session
  const a = s.attention
  if (!c.active) statusItem.text = '$(target) Focus: not started'
  else if (c.overtime) statusItem.text = "$(target) Focus: time's up"
  else if (c.current || c.pulledEarly) statusItem.text = `$(eye) Focus: ${c.pulledEarly ? 'early checkpoint' : `checkpoint #${c.current}`}`
  else statusItem.text = `${ICON[a.level]} Focus ${fmt(c.left)} · #${c.upcoming} in ${fmt(c.inMs)}`
  statusItem.tooltip = a.reason || 'Focus Hour'
  statusItem.backgroundColor = a.level === 3 ? new vscode.ThemeColor('statusBarItem.errorBackground') : a.level === 2 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
  statusItem.show()

  const cp = c.active ? c.current : 0
  const early = Boolean(c.pulledEarly)
  if (cfg().get('revealOnCheckpoint') && ((cp && cp !== last.checkpoint) || (early && !last.early))) {
    vscode.commands.executeCommand('focusHour.map.focus')
    vscode.window.showInformationMessage(early ? `Focus Hour · early checkpoint: ${a.reason}` : `Focus Hour · checkpoint #${cp}: time to review`)
  } else if (c.active && a.level === 2 && last.level < 2) {
    vscode.window.showWarningMessage(`Focus Hour: ${a.reason}`)
  }
  last = { checkpoint: cp, early, level: a.level }
}

function fmt(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  statusItem.command = 'focusHour.map.focus'
  context.subscriptions.push(statusItem)

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('focusHour.map', {
      resolveWebviewView(v) {
        view = v
        v.webview.onDidReceiveMessage(onMessage)
        render(v.webview)
      },
    }, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('focusHour.open', () => {
      const panel = vscode.window.createWebviewPanel('focusHour.panel', 'Focus map', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true })
      panel.webview.onDidReceiveMessage(onMessage)
      render(panel.webview)
    }),
    vscode.commands.registerCommand('focusHour.restart', async () => {
      stopServer()
      if (view) await render(view.webview)
      else await ensureServer(repoRoot())
    }),
  )

  const root = repoRoot()
  if (root && cfg().get('autoStart')) ensureServer(root)
  poll = setInterval(tick, 3000)
  context.subscriptions.push({ dispose: () => clearInterval(poll) })
}

function deactivate() {
  stopServer()
}

module.exports = { activate, deactivate }
