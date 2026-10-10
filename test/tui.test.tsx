import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import React from 'react'
import { render } from 'ink-testing-library'
import { loadConfig } from '../src/config-file.js'
import { HivemindTui, type TuiProps } from '../src/tui.js'
import { configSchema, fromConfig } from '../src/config.js'
import { createHivemind, type Progress } from '../src/graph.js'
import { DemoHarness, HarnessRegistry } from '../src/harnesses.js'
import { displayPath } from '../src/projects.js'
import { RuleRouter } from '../src/routers.js'
import { directoryEntries, loopView, matchCommands, pageLines, parseCommand, runSummary, safeText, selectWorker, windowStart } from '../src/tui-state.js'

// Keep recents written by the TUI out of the real home directory.
const stateDir = mkdtempSync(join(tmpdir(), 'hivemind-tui-state-'))
process.env.HIVEMIND_STATE_DIR = stateDir
test.after(() => rm(stateDir, { recursive: true, force: true }))

const config = configSchema.parse({ harnesses: { demo: { type: 'demo' }, alternate: { type: 'demo' } },
  agents: [{ id: 'writer', role: 'worker', harness: 'demo' }, { id: 'second', role: 'worker', harness: 'alternate' }, { id: 'reviewer', role: 'reviewer', harness: 'demo' }], router: { type: 'rule' } })
const PROMPT = 'Describe a task'
const SETTINGS = 'Timeout steps by 1000 ms'
async function waitFor(check: () => boolean) {
  const end = Date.now() + 3000
  while (!check()) {
    if (Date.now() > end) throw new Error('UI did not reach expected state')
    await delay(15)
  }
}
// The slice of an ink-testing-library instance these helpers use (the library does not export its instance type).
interface App { stdin: { write(data: string): void }; frames: string[]; lastFrame(): string | undefined }
const frame = (app: App) => app.lastFrame() ?? ''
const statusLine = (app: App) => frame(app).trimEnd().split('\n').at(-1)!
async function waitText(app: App, text: string) { await waitFor(() => frame(app).includes(text)) }
async function command(app: App, text: string) {
  app.stdin.write(text)
  await waitText(app, text)
  app.stdin.write('\r')
}

test('TUI runs a task and leaves the prompt, artifact, and completed summary in the transcript', async () => {
  const app = render(<HivemindTui config={config} configPath="demo.json" project="/work/site" />)
  try {
    await waitText(app, PROMPT)
    assert.match(frame(app), /✻ Hivemind/)
    assert.match(frame(app), /cwd: \/work\/site/)
    assert.match(frame(app), /config: demo\.json/)
    assert.match(statusLine(app), /^\/work\/site · writer → demo · review: reviewer · router: rule · demo\s+demo\.json$/)
    app.stdin.write('Write a project introduction')
    await waitText(app, 'Write a project introduction')
    app.stdin.write('\r')
    await waitText(app, '● completed')
    const output = frame(app)
    assert.match(output, /> Write a project introduction/)
    assert.match(output, /● completed · 2 attempts · 1 revision/)
    assert.match(output, /⎿ Revised draft for: Write a project introduction/)
    assert.match(output, new RegExp(PROMPT))
  } finally { app.unmount(); app.cleanup() }
})
test('TUI slash menu filters by prefix and Enter runs the highlighted command', async () => {
  const app = render(<HivemindTui config={config} configPath="demo.json" />)
  try {
    await waitText(app, PROMPT)
    app.stdin.write('/se')
    await waitText(app, 'Edit router, limits')
    assert.doesNotMatch(frame(app), /Choose the worker/)
    assert.doesNotMatch(frame(app), /List commands/)
    app.stdin.write('\r')
    await waitText(app, SETTINGS)
    assert.match(frame(app), /› Router: rule/)
  } finally { app.unmount(); app.cleanup() }
})
test('TUI slash menu moves with arrows, completes with Tab, and Esc clears it', async () => {
  const app = render(<HivemindTui config={config} configPath="demo.json" />)
  try {
    await waitText(app, PROMPT)
    app.stdin.write('/')
    await waitText(app, 'List commands')
    app.stdin.write('\x1b[B') // help → settings
    await delay(20)
    app.stdin.write('\t')
    await waitFor(() => !frame(app).includes('List commands'))
    assert.match(frame(app), /> \/settings/)
    app.stdin.write('\x1b') // Esc closes the menu and clears the prompt
    await waitText(app, PROMPT)
    assert.doesNotMatch(frame(app), /Edit router, limits/)
    app.stdin.write('/hel')
    await waitText(app, 'List commands')
    app.stdin.write('\r')
    await waitText(app, 'Keys')
    assert.match(frame(app), /\/cwd \[path\]\s+Change the project directory/)
    assert.match(frame(app), /Ctrl\+D\s+Exit from an empty prompt/)
  } finally { app.unmount(); app.cleanup() }
})
test('TUI /worker and /harness change what the runner receives', async () => {
  let selected: unknown
  const runner: TuiProps['runner'] = (input, controls) => { selected = input; return fromConfig(input, controls) }
  const app = render(<HivemindTui config={config} configPath="demo.json" runner={runner} />)
  try {
    await waitText(app, PROMPT)
    await command(app, '/worker second')
    await waitText(app, 'Worker → second')
    assert.match(statusLine(app), /second → alternate/)
    await command(app, '/harness demo')
    await waitText(app, 'Harness → demo')
    assert.match(statusLine(app), /second → demo/)
    await command(app, '/worker nobody')
    await waitText(app, 'Unknown worker "nobody"')
    app.stdin.write('Test selection')
    await waitText(app, 'Test selection')
    app.stdin.write('\r')
    await waitText(app, '● completed')
    const parsed = configSchema.parse(selected)
    assert.deepEqual(parsed.agents.filter(a => a.role === 'worker').map(a => [a.id, a.harness]), [['second', 'demo']])
    assert.equal(config.agents[0]!.harness, 'demo')
  } finally { app.unmount(); app.cleanup() }
})
test('TUI /worker without an argument opens a picker', async () => {
  const app = render(<HivemindTui config={config} configPath="demo.json" />)
  try {
    await waitText(app, PROMPT)
    await command(app, '/worker')
    await waitText(app, 'Choose a worker')
    assert.match(frame(app), /› writer harness demo · current/)
    app.stdin.write('\x1b[B')
    await waitText(app, '› second')
    app.stdin.write('\r')
    await waitText(app, 'Worker → second')
    assert.match(statusLine(app), /second → alternate/)
  } finally { app.unmount(); app.cleanup() }
})
test('TUI /cwd <dir> moves the status line and points filesystem harnesses at the project', async () => {
  const project = await mkdtemp(join(tmpdir(), 'hm-'))
  const withCommand = configSchema.parse({ harnesses: { demo: { type: 'demo' }, shell: { type: 'command', command: 'false' }, nested: { type: 'command', command: 'false', cwd: 'sub' } },
    agents: [{ id: 'writer', role: 'worker', harness: 'shell' }, { id: 'reviewer', role: 'reviewer', harness: 'demo' }], router: { type: 'rule' } })
  let selected: TuiProps['config'] | undefined
  // Record the config the TUI would run, but execute the demo setup instead of spawning the command harness.
  const runner: TuiProps['runner'] = (input, controls) => { selected = configSchema.parse(input); return fromConfig(config, controls) }
  const app = render(<HivemindTui config={withCommand} configPath="hivemind.json" runner={runner} />)
  try {
    await waitText(app, PROMPT)
    await command(app, `/cwd ${project}`)
    await waitText(app, `Working directory → ${displayPath(project)}`)
    assert.ok(statusLine(app).startsWith(displayPath(project)))
    await command(app, '/cwd ./does-not-exist')
    await waitText(app, `Not a directory: ${join(project, 'does-not-exist')}`)
    app.stdin.write('Build it')
    await waitText(app, 'Build it')
    app.stdin.write('\r')
    await waitText(app, '● completed')
    assert.deepEqual(selected!.harnesses.shell, { type: 'command', command: 'false', args: [], cwd: project, maxOutputBytes: 1_048_576 })
    assert.deepEqual(selected!.harnesses.nested, { type: 'command', command: 'false', args: [], cwd: join(project, 'sub'), maxOutputBytes: 1_048_576 })
    assert.deepEqual(selected!.harnesses.demo, { type: 'demo' })
    assert.equal('cwd' in withCommand.harnesses.shell!, false) // the loaded config is never mutated
  } finally { app.unmount(); app.cleanup(); await rm(project, { recursive: true, force: true }) }
})
test('TUI /cwd without an argument browses directories and Use selects one', async () => {
  const project = await mkdtemp(join(tmpdir(), 'hm-'))
  mkdirSync(join(project, 'alpha')); mkdirSync(join(project, 'beta')); mkdirSync(join(project, '.hidden'))
  const app = render(<HivemindTui config={config} configPath="demo.json" project={project} />)
  try {
    await waitText(app, PROMPT)
    await command(app, '/cwd')
    await waitText(app, 'Choose a directory')
    assert.match(frame(app), new RegExp(`› ✓ Use ${displayPath(project)}`))
    assert.match(frame(app), /alpha\//)
    assert.doesNotMatch(frame(app), /\.hidden/)
    app.stdin.write('bet') // typing filters subdirectories
    await waitFor(() => !frame(app).includes('alpha/'))
    assert.match(frame(app), /beta\//)
    for (let index = 0; index < 3; index++) { app.stdin.write('\x7f'); await delay(20) }
    await waitText(app, 'alpha/')
    app.stdin.write('\x1b[B') // ..
    await delay(20)
    app.stdin.write('\x1b[B') // alpha
    await waitText(app, '› alpha/')
    app.stdin.write('\r') // descend
    await waitText(app, `Choose a directory · ${displayPath(join(project, 'alpha'))}`)
    app.stdin.write('\r') // ✓ Use
    await waitText(app, `Working directory → ${displayPath(join(project, 'alpha'))}`)
    assert.ok(statusLine(app).startsWith(displayPath(join(project, 'alpha'))))
    assert.doesNotMatch(frame(app), /Choose a directory/)
  } finally { app.unmount(); app.cleanup(); await rm(project, { recursive: true, force: true }) }
})
test('TUI reports unknown slash commands', async () => {
  const app = render(<HivemindTui config={config} configPath="demo.json" />)
  try {
    await waitText(app, PROMPT)
    await command(app, '/foo')
    await waitText(app, 'Unknown command /foo — /help lists commands')
  } finally { app.unmount(); app.cleanup() }
})
test('TUI /clear clears the screen and keeps only the banner', async () => {
  const app = render(<HivemindTui config={config} configPath="demo.json" />)
  try {
    await waitText(app, PROMPT)
    await command(app, '/foo')
    await waitText(app, 'Unknown command')
    await command(app, '/clear')
    await waitFor(() => app.frames.some(output => output.includes('\x1b[2J\x1b[3J\x1b[H')))
    await waitText(app, PROMPT)
  } finally { app.unmount(); app.cleanup() }
})
test('TUI Escape interrupts an active harness and stays open for another task', async () => {
  let aborted = false
  const runner: TuiProps['runner'] = (input, controls) => {
    const parsed = configSchema.parse(input)
    return createHivemind({ ...controls, agents: parsed.agents, router: new RuleRouter(), timeoutMs: 5000,
      harnesses: new HarnessRegistry().register('demo', { run(request, signal) {
        if (request.agent.role === 'reviewer') return new DemoHarness().run(request)
        signal.addEventListener('abort', () => { aborted = true }, { once: true })
        return new Promise<string>(() => {}) // never settles; only the abort ends it (tsconfig lib predates Promise.withResolvers)
      } }).register('alternate', new DemoHarness()),
    })
  }
  const app = render(<HivemindTui config={config} configPath="demo.json" initialTask="Wait for cancellation" runner={runner} />)
  try {
    await waitText(app, 'Wait for cancellation')
    app.stdin.write('\r')
    await waitText(app, '◉ Working · writer via demo')
    assert.match(frame(app), /esc to interrupt/)
    assert.match(frame(app), /decide ──▶/)
    app.stdin.write('\r') // Enter is ignored while a run is active
    app.stdin.write('\x1b')
    await waitText(app, '● cancelled')
    assert.equal(aborted, true)
    assert.doesNotMatch(frame(app), /esc to interrupt/)
    app.stdin.write('\x1b') // Escape when idle never exits
    await delay(30)
    app.stdin.write('Next task')
    await waitText(app, 'Next task')
  } finally { app.unmount(); app.cleanup() }
})
test('progress observers receive ordered live start/end updates without changing graph history', async () => {
  const updates: Progress[] = []
  const result = await fromConfig(config, { onProgress: update => updates.push(update) }).run('Write')
  assert.equal(result.status, 'completed')
  assert.deepEqual(updates.slice(0, 4).map(u => `${u.node}:${u.phase}`), ['decide:start', 'decide:end', 'work:start', 'work:end'])
  assert.equal(updates.filter(u => u.phase === 'end').length, result.events.length)
  assert.ok(updates.some(u => u.artifact?.includes('Revised draft')))
})
async function tempConfig(source = config): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'hivemind-tui-'))
  const path = join(dir, 'hivemind.json')
  await writeFile(path, JSON.stringify(source, null, 2))
  return { dir, path }
}
test('TUI settings panel opens with Ctrl+S and shows the current router and limits', async () => {
  const { dir, path } = await tempConfig()
  const app = render(<HivemindTui config={config} configPath={path} />)
  try {
    await waitText(app, PROMPT)
    app.stdin.write('\x13') // Ctrl+S
    await waitText(app, SETTINGS)
    const output = frame(app)
    assert.match(output, /› Router: rule/)
    assert.match(output, /Max attempts: 3/)
    assert.match(output, /Timeout \(ms\): 120000/)
    assert.doesNotMatch(output, new RegExp(PROMPT)) // the panel replaces the prompt box
    assert.equal(JSON.parse(await readFile(path, 'utf8')).maxAttempts, 3)
  } finally { app.unmount(); app.cleanup(); await rm(dir, { recursive: true, force: true }) }
})
test('TUI settings Ctrl+W persists the edited value to the config file', async () => {
  const { dir, path } = await tempConfig()
  const app = render(<HivemindTui config={config} configPath={path} />)
  try {
    await waitText(app, PROMPT)
    await command(app, '/settings')
    await waitText(app, SETTINGS)
    app.stdin.write('\x1b[B') // ↓ to max attempts
    await delay(20)
    app.stdin.write('\x1b[C') // → 4
    await waitText(app, 'Max attempts: 4')
    assert.match(frame(app), /unsaved changes/)
    app.stdin.write('\x17') // Ctrl+W
    await waitText(app, 'Saved')
    assert.equal((await loadConfig(path)).maxAttempts, 4)
    assert.match(frame(app), /saved/)
  } finally { app.unmount(); app.cleanup(); await rm(dir, { recursive: true, force: true }) }
})
test('TUI settings panel and save also respond to Ctrl+O and Ctrl+E', async () => {
  // Some terminals swallow Ctrl+S/Ctrl+W (flow control), so the aliases must work identically.
  const { dir, path } = await tempConfig()
  const app = render(<HivemindTui config={config} configPath={path} />)
  try {
    await waitText(app, PROMPT)
    app.stdin.write('\x0f') // Ctrl+O
    await waitText(app, SETTINGS)
    app.stdin.write('\x1b[B') // ↓ to max attempts
    await delay(20)
    app.stdin.write('\x1b[C') // → 4
    await waitText(app, 'Max attempts: 4')
    app.stdin.write('\x05') // Ctrl+E
    await waitText(app, 'Saved')
    assert.equal((await loadConfig(path)).maxAttempts, 4)
    app.stdin.write('\x0f') // Ctrl+O closes it too
    await waitText(app, PROMPT)
  } finally { app.unmount(); app.cleanup(); await rm(dir, { recursive: true, force: true }) }
})
test('TUI opens and saves settings with plain keys, for terminals that swallow Ctrl+S', async () => {
  // Zed's built-in terminal does not deliver Ctrl+S, so `/config` (alias of /settings) + typing s must work end to end.
  const { dir, path } = await tempConfig()
  const app = render(<HivemindTui config={config} configPath={path} />)
  try {
    await waitText(app, PROMPT)
    await command(app, '/config')
    await waitText(app, SETTINGS)
    app.stdin.write('\x1b[B') // ↓ to max attempts
    await delay(20)
    app.stdin.write('\x1b[C') // → 4
    await waitText(app, 'Max attempts: 4')
    app.stdin.write('s') // plain key save
    await waitText(app, 'Saved')
    assert.equal((await loadConfig(path)).maxAttempts, 4)
    app.stdin.write('q') // plain key close
    await waitText(app, PROMPT)
  } finally { app.unmount(); app.cleanup(); await rm(dir, { recursive: true, force: true }) }
})
test('TUI settings Escape closes the panel without touching the config file', async () => {
  const { dir, path } = await tempConfig()
  const app = render(<HivemindTui config={config} configPath={path} />)
  try {
    await waitText(app, PROMPT)
    app.stdin.write('\x13')
    await waitText(app, SETTINGS)
    app.stdin.write('\x1b[B')
    await delay(20)
    app.stdin.write('\x1b[C')
    await waitText(app, 'Max attempts: 4')
    app.stdin.write('\x1b') // Escape discards
    await waitText(app, PROMPT)
    assert.equal((await loadConfig(path)).maxAttempts, 3)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).maxAttempts, 3)
  } finally { app.unmount(); app.cleanup(); await rm(dir, { recursive: true, force: true }) }
})
test('TUI submits later tasks against the saved setup', async () => {
  const started: TuiProps['config'][] = []
  const runner: TuiProps['runner'] = (input, controls) => {
    const parsed = configSchema.parse(input)
    started.push(parsed)
    return fromConfig(parsed, controls)
  }
  const { dir, path } = await tempConfig()
  const app = render(<HivemindTui config={config} configPath={path} runner={runner} />)
  try {
    await waitText(app, PROMPT)
    app.stdin.write('\x13') // Ctrl+S
    await waitText(app, SETTINGS)
    app.stdin.write('\x1b[B') // ↓ max attempts
    await delay(20)
    app.stdin.write('\x1b[C')
    await waitText(app, 'Max attempts: 4')
    app.stdin.write('\x1b[B') // ↓ timeout
    await delay(20)
    app.stdin.write('\x1b[B') // ↓ writer harness
    await delay(20)
    app.stdin.write('\x1b[C') // demo -> alternate
    await waitText(app, 'writer · worker harness: alternate')
    app.stdin.write('\x1b[B') // ↓ second worker
    await delay(20)
    app.stdin.write('\x1b[B') // ↓ reviewer
    await delay(20)
    app.stdin.write('\x1b[C') // demo -> alternate
    await waitText(app, 'reviewer · reviewer harness: alternate')
    app.stdin.write('\x17') // Ctrl+W
    await waitText(app, 'Saved')
    app.stdin.write('\x1b') // close panel
    await waitText(app, PROMPT)
    assert.match(statusLine(app), /writer → alternate/)
    app.stdin.write('Run with the saved worker harness')
    await waitText(app, 'Run with the saved worker harness')
    app.stdin.write('\r')
    await waitText(app, '● completed')
    assert.equal(started.length, 1)
    assert.equal(started[0]!.agents.find(agent => agent.id === 'writer')!.harness, 'alternate')
    assert.equal(started[0]!.maxAttempts, 4)
    assert.equal(started[0]!.agents.find(agent => agent.role === 'reviewer')!.harness, 'alternate')
    const reloaded = await loadConfig(path)
    assert.equal(reloaded.agents.find(agent => agent.id === 'writer')!.harness, 'alternate')
    assert.equal(reloaded.agents.find(agent => agent.role === 'reviewer')!.harness, 'alternate')
    assert.equal(reloaded.maxAttempts, 4)
  } finally { app.unmount(); app.cleanup(); await rm(dir, { recursive: true, force: true }) }
})
test('TUI settings switches the router between rule and a router agent', async () => {
  const routed = configSchema.parse({ harnesses: { demo: { type: 'demo' }, alternate: { type: 'demo' } },
    agents: [{ id: 'writer', role: 'worker', harness: 'demo' }, { id: 'reviewer', role: 'reviewer', harness: 'demo' },
      { id: 'planner', role: 'router', harness: 'demo' }], router: { type: 'rule' } })
  const { dir, path } = await tempConfig(routed)
  const app = render(<HivemindTui config={routed} configPath={path} />)
  try {
    await waitText(app, PROMPT)
    app.stdin.write('\x13') // Ctrl+S
    await waitText(app, SETTINGS)
    assert.match(frame(app), /Router: rule/)
    app.stdin.write('\x1b[C') // → model:planner
    await waitText(app, 'Router: model:planner')
    app.stdin.write('\x17') // Ctrl+W
    await waitText(app, 'Saved')
    assert.deepEqual((await loadConfig(path)).router, { type: 'model', agent: 'planner' })
    app.stdin.write('q')
    await waitText(app, PROMPT)
    assert.match(statusLine(app), /router: model:planner/)
  } finally { app.unmount(); app.cleanup(); await rm(dir, { recursive: true, force: true }) }
})
test('TUI settings refuses to save a setup that fails assertRunnable', async () => {
  const twice = configSchema.parse({ harnesses: { demo: { type: 'demo' } },
    agents: [{ id: 'writer', role: 'worker', harness: 'demo' }, { id: 'first', role: 'reviewer', harness: 'demo' },
      { id: 'second', role: 'reviewer', harness: 'demo' }], router: { type: 'rule' } })
  const { dir, path } = await tempConfig(twice)
  const app = render(<HivemindTui config={twice} configPath={path} />)
  try {
    await waitText(app, PROMPT)
    app.stdin.write('\x13')
    await waitText(app, SETTINGS)
    app.stdin.write('\x17') // Ctrl+W with no edits still validates the draft
    await waitText(app, 'Save failed')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).agents, twice.agents)
  } finally { app.unmount(); app.cleanup(); await rm(dir, { recursive: true, force: true }) }
})
test('TUI settings surfaces a save failure and leaves the file untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hivemind-tui-'))
  const path = join(dir, 'readonly.json')
  await writeFile(path, JSON.stringify(config, null, 2))
  const app = render(<HivemindTui config={config} configPath={path} />)
  try {
    await waitText(app, PROMPT)
    app.stdin.write('\x13')
    await waitText(app, SETTINGS)
    await chmod(dir, 0o500)
    app.stdin.write('\x1b[B')
    await delay(20)
    app.stdin.write('\x1b[C')
    await waitText(app, 'Max attempts: 4')
    app.stdin.write('\x17') // Ctrl+W
    await waitText(app, 'Save failed')
    await chmod(dir, 0o700)
    assert.equal((await loadConfig(path)).maxAttempts, 3)
    // The panel stays open with the edit retained in memory, never crashing.
    assert.match(frame(app), /Max attempts: 4/)
  } finally { app.unmount(); app.cleanup(); await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true }) }
})
test('selection validates IDs and terminal text removes escape sequences', () => {
  assert.throws(() => selectWorker(config, 'missing', 'demo'))
  assert.throws(() => selectWorker(config, 'writer', 'missing'))
  assert.equal(safeText('\x1b[31mhello\x1b[0m\x1b]52;c;payload\x07'), 'hello')
  assert.deepEqual(pageLines('123456\nend', 3), ['123', '456', 'end'])
})
test('slash command matching, parsing, and run summaries', () => {
  assert.deepEqual(matchCommands('/se').map(c => c.name), ['settings'])
  assert.deepEqual(matchCommands('/con').map(c => c.name), ['settings']) // alias /config
  assert.equal(matchCommands('/').length, 7)
  assert.deepEqual(matchCommands('/cwd here'), []) // an argument closes the menu
  assert.deepEqual(matchCommands('task'), [])
  assert.equal(parseCommand('plain task'), null)
  assert.deepEqual(parseCommand('  /DIR  ~/code  '), { name: 'dir', arg: '~/code', command: matchCommands('/cwd')[0] })
  assert.equal(parseCommand('/foo bar')!.command, undefined)
  assert.equal(parseCommand('/quit')!.command!.name, 'exit')
  assert.deepEqual(runSummary('completed', 2, 1, 'ignored'), { text: '● completed · 2 attempts · 1 revision', color: 'green' })
  assert.deepEqual(runSummary('blocked', 1, 0, 'Need\nmore info'), { text: '● blocked · 1 attempt · Need more info', color: 'red' })
  assert.equal(runSummary('cancelled', 0, 0).color, 'yellow')
  assert.equal(windowStart(30, 0, 10), 0)
  assert.equal(windowStart(30, 15, 10), 10)
  assert.equal(windowStart(30, 29, 10), 20)
  assert.equal(windowStart(4, 3, 10), 0)
})
test('directory picker entries list use, parent, filtered subdirectories, then recents', () => {
  const entries = directoryEntries('/a/b', ['docs', 'src'], ['/a/b', '/x'], '/a/b', 'SR')
  assert.deepEqual(entries.map(entry => [entry.kind, entry.path]), [['use', '/a/b'], ['parent', '/a'], ['dir', '/a/b/src'], ['recent', '/x']])
  assert.deepEqual(directoryEntries('/', [], [], '/').map(entry => entry.kind), ['use'])
})
test('loop view resets work/review on each revise lap and settles on the run outcome', async () => {
  const updates: Progress[] = []
  await fromConfig(config, { onProgress: update => updates.push(update) }).run('Loop view')
  const reviewEnd = updates.findIndex(u => u.node === 'review' && u.phase === 'end')
  assert.equal(loopView(updates.slice(0, reviewEnd + 1)).review, 'revise')
  const secondLap = loopView(updates.slice(0, reviewEnd + 2))
  assert.deepEqual([secondLap.decide, secondLap.work, secondLap.review, secondLap.backEdge, secondLap.laps], ['active', 'idle', 'idle', 'active', 1])
  const done = loopView(updates, 'completed')
  assert.deepEqual([done.review, done.finish, done.finishLabel, done.attempt], ['done', 'done', 'completed', 2])
  const cancelled = loopView(updates.slice(0, reviewEnd + 4), 'cancelled')
  assert.deepEqual([cancelled.work, cancelled.finish, cancelled.finishLabel], ['failed', 'failed', 'cancelled'])
})
