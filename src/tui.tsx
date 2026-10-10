import path from 'node:path'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Static, Text, render, useApp, useInput, useStdout, type Key } from 'ink'
import { assertRunnable, formatFor, saveConfig } from './config-file.js'
import { configSchema, fromConfig } from './config.js'
import type { Progress } from './graph.js'
import { applyProject, displayPath, listDirectories, loadRecentProjects, rememberProject, resolveProject } from './projects.js'
import {
  commandLabel, directoryEntries, keyBindings, loopView, matchCommands, pageLines, parseCommand, routerLabel, runSummary, safeText, selectWorker,
  settingsFields, slashCommands, stepSetting, windowStart, type Config, type LoopOutcome, type LoopView, type NodeState, type ParsedCommand, type RunSummary,
} from './tui-state.js'

const MIN_COLUMNS = 40
const PICKER_ROWS = 10
const glyph: Record<NodeState, string> = { idle: '○', active: '◉', done: '●', revise: '↺', failed: '✗' }
const tone: Record<NodeState, string | undefined> = { idle: 'gray', active: 'yellow', done: 'green', revise: 'yellow', failed: 'red' }
function LoopNode({ state, label }: { state: NodeState; label: string }) {
  return <Text color={tone[state]} bold={state === 'active'} dimColor={state === 'idle'}>{glyph[state]} {label}</Text>
}
// Fixed-width diagram: the back-edge columns line up under the decide and review glyphs.
function LoopPanel({ view, maxAttempts, steps }: { view: LoopView; maxAttempts: number; steps: Progress[] }) {
  const edge = (from: NodeState) => <Text color={from === 'done' || from === 'revise' ? 'green' : 'gray'} dimColor={from === 'idle' || from === 'active'}> ──▶ </Text>
  const backColor = view.backEdge === 'active' ? 'yellow' : view.backEdge === 'taken' ? 'magenta' : 'gray'
  const pips = maxAttempts <= 20 ? Array.from({ length: maxAttempts }, (_, index) => index + 1 < view.attempt || (index + 1 === view.attempt && view.work !== 'active') ? '●' : index + 1 === view.attempt ? '◉' : '○').join('') : ''
  // Always three rows (one full lap) so the prompt below does not jump while a run fills the log.
  const log: (Progress | null)[] = steps.filter(step => step.phase === 'end').slice(-3)
  while (log.length < 3) log.push(null)
  return <Box flexDirection="column">
    <Box gap={2}>
      <Text bold>Loop</Text>
      <Text dimColor>attempt {Math.max(1, view.attempt)}/{maxAttempts}</Text>
      {pips ? <Text color="cyan">{pips}</Text> : null}
      {view.laps ? <Text color="magenta">↺ {view.laps} revision{view.laps === 1 ? '' : 's'}</Text> : null}
    </Box>
    <Text wrap="truncate"> <LoopNode state={view.decide} label="decide" />{edge(view.decide)}<LoopNode state={view.work} label="work" />{edge(view.work)}<LoopNode state={view.review} label="review" />{edge(view.review === 'done' ? 'done' : 'idle')}<LoopNode state={view.finish} label={view.finishLabel} /></Text>
    <Text color={backColor} dimColor={view.backEdge === 'idle'} wrap="truncate"> ╰──────◀ revise ────────╯</Text>
    {log.map((step, index) => step
      ? <Text key={index} wrap="truncate"><Text color={tone[step.status === 'blocked' || step.status === 'exhausted' ? 'failed' : 'done']}>{step.status === 'blocked' || step.status === 'exhausted' ? '✗' : '✓'}</Text> <Text bold>{step.node} #{step.attempt}</Text> <Text dimColor>{step.message}</Text></Text>
      : <Text key={index} dimColor wrap="truncate">{index === 0 && !steps.length ? 'Starting the workflow…' : ' '}</Text>)}
  </Box>
}

type Item =
  | { id: number; kind: 'banner'; project: string; configPath: string }
  | { id: number; kind: 'prompt'; text: string }
  | { id: number; kind: 'result'; summary: RunSummary; artifact: string }
  | { id: number; kind: 'notice'; command?: string; text: string; error?: boolean }
  | { id: number; kind: 'help' }
type NewItem = Item extends infer T ? T extends Item ? Omit<T, 'id'> : never : never

function Echo({ text }: { text: string }) {
  return <Text bold wrap="wrap"><Text color="gray">{'> '}</Text>{text}</Text>
}
function HelpTable() {
  const rows: [string, string][] = [
    ...slashCommands.map(command => [commandLabel(command), `${command.description}${command.aliases.length ? ` (alias ${command.aliases.map(alias => `/${alias}`).join(', ')})` : ''}`] as [string, string]),
    ...keyBindings.map(([keys, action]) => [keys, action] as [string, string]),
  ]
  const width = Math.max(...rows.map(([label]) => label.length)) + 2
  return <Box flexDirection="column" paddingLeft={2}>
    <Text bold>Commands</Text>
    {rows.slice(0, slashCommands.length).map(([label, description]) => <Text key={label}><Text color="cyan">{label.padEnd(width)}</Text><Text dimColor>{description}</Text></Text>)}
    <Text bold>Keys</Text>
    {rows.slice(slashCommands.length).map(([label, description]) => <Text key={label}><Text color="cyan">{label.padEnd(width)}</Text><Text dimColor>{description}</Text></Text>)}
  </Box>
}
function TranscriptItem({ item, columns }: { item: Item; columns: number }) {
  if (item.kind === 'banner') {
    return <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} alignSelf="flex-start">
      <Text bold color="cyan">✻ Hivemind</Text>
      <Text>cwd: {safeText(displayPath(item.project))}</Text>
      <Text>config: {safeText(item.configPath)}</Text>
      <Text dimColor>/help for commands · /settings to configure · /cwd to change directory</Text>
    </Box>
  }
  if (item.kind === 'prompt') return <Box marginTop={1}><Echo text={item.text} /></Box>
  if (item.kind === 'help') return <Box marginTop={1} flexDirection="column"><Echo text="/help" /><HelpTable /></Box>
  if (item.kind === 'notice') {
    return <Box marginTop={1} flexDirection="column">
      {item.command ? <Echo text={item.command} /> : null}
      <Text color={item.error ? 'red' : undefined} wrap="wrap"><Text dimColor>{'  ⎿ '}</Text>{item.text}</Text>
    </Box>
  }
  const lines = item.artifact.trim() ? pageLines(item.artifact.trim(), Math.max(10, columns - 4)) : []
  return <Box marginTop={1} flexDirection="column">
    <Text color={item.summary.color} wrap="wrap">{item.summary.text}</Text>
    {lines.map((line, index) => <Text key={index}><Text dimColor>{index === 0 ? '  ⎿ ' : '    '}</Text>{line}</Text>)}
  </Box>
}

interface PickerRow { key: string; label: string; detail?: string; color?: string; section?: string }
function Picker({ title, rows, index, hint }: { title: string; rows: PickerRow[]; index: number; hint: string }) {
  const start = windowStart(rows.length, index, PICKER_ROWS)
  const visible = rows.slice(start, start + PICKER_ROWS)
  return <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
    <Text bold color="cyan" wrap="truncate">{title}</Text>
    {start > 0 ? <Text dimColor>  ↑ {start} more</Text> : null}
    {visible.map((row, offset) => {
      const selected = start + offset === index
      return <Box key={row.key} flexDirection="column">
        {row.section ? <Text dimColor>{row.section}</Text> : null}
        <Text wrap="truncate" color={selected ? 'cyan' : row.color} bold={selected}>{selected ? '› ' : '  '}{row.label}{row.detail ? <Text dimColor> {row.detail}</Text> : null}</Text>
      </Box>
    })}
    {start + PICKER_ROWS < rows.length ? <Text dimColor>  ↓ {rows.length - start - PICKER_ROWS} more</Text> : null}
    <Text dimColor wrap="truncate">{hint}</Text>
  </Box>
}

type Panel =
  | { kind: 'settings' }
  | { kind: 'directory'; browsing: string; subdirs: string[]; recents: string[]; filter: string; index: number }
  | { kind: 'select'; target: 'worker' | 'harness'; index: number }
type Runner = typeof fromConfig
export interface TuiProps { config: Config; configPath: string; initialTask?: string; runner?: Runner; project?: string }
export function HivemindTui({ config: initialConfig, configPath, initialTask = '', runner = fromConfig, project: initialProject }: TuiProps) {
  const { exit } = useApp()
  const { stdout, write } = useStdout()
  const terminal = stdout as NodeJS.WriteStream
  const [config, setConfig] = useState<Config>(initialConfig)
  const [project, setProject] = useState(() => initialProject ?? process.cwd())
  const firstWorker = initialConfig.agents.find(agent => agent.role === 'worker')!
  const [workerId, setWorkerId] = useState(firstWorker.id)
  const [harnessId, setHarnessId] = useState(firstWorker.harness)
  const [transcript, setTranscript] = useState<Item[]>(() => [{ id: 0, kind: 'banner', project, configPath }])
  const [staticKey, setStaticKey] = useState(0)
  const [task, setTask] = useState(initialTask)
  const [cursor, setCursor] = useState(Array.from(initialTask).length)
  const [menuIndex, setMenuIndex] = useState(0)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [draft, setDraft] = useState<Config | null>(null)
  const [settingsIndex, setSettingsIndex] = useState(0)
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [settingsNotice, setSettingsNotice] = useState('')
  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState('Starting')
  const [steps, setSteps] = useState<Progress[]>([])
  const [columns, setColumns] = useState(terminal.columns || 80)
  const controller = useRef<AbortController | null>(null)
  const busy = useRef(false)
  const mounted = useRef(true)
  const nextId = useRef(1)
  // Bumped whenever the directory picker closes or navigates, so a slow listing cannot reopen or overwrite it.
  const pickerToken = useRef(0)
  const workers = config.agents.filter(agent => agent.role === 'worker')
  const harnessIds = Object.keys(config.harnesses)
  const reviewer = config.agents.find(agent => agent.role === 'reviewer')!
  useEffect(() => {
    const resize = () => setColumns(terminal.columns || 80)
    stdout.on('resize', resize)
    return () => { stdout.off('resize', resize) }
  }, [stdout])
  useEffect(() => {
    void rememberProject(project)
    return () => { mounted.current = false; controller.current?.abort() }
  }, [])

  const append = (item: NewItem) => setTranscript(previous => [...previous, { ...item, id: nextId.current++ } as Item])
  const notice = (text: string, command?: string, error = false) => append({ kind: 'notice', text, command, error })
  const editInput = (text: string, at: number) => { setTask(text); setCursor(at); setMenuIndex(0) }
  const interrupt = () => { controller.current?.abort(); setStage('Cancelling…') }
  const quit = () => { controller.current?.abort(); exit() }

  async function runTask(text: string) {
    if (busy.current) return
    busy.current = true
    const abort = new AbortController()
    controller.current = abort
    const runSteps: Progress[] = []
    append({ kind: 'prompt', text: safeText(text) })
    editInput('', 0)
    setRunning(true); setSteps([]); setStage('Starting')
    let result: NewItem
    try {
      const runtime = runner(applyProject(selectWorker(config, workerId, harnessId), project), {
        signal: abort.signal,
        onProgress(progress: Progress) {
          const step = { ...progress, message: safeText(progress.message) }
          runSteps.push(step)
          if (!mounted.current) return
          setSteps(previous => [...previous, step])
          if (progress.phase === 'start' && !abort.signal.aborted) setStage(`${progress.node === 'decide' ? 'Deciding' : progress.node === 'work' ? 'Working' : 'Reviewing'} · ${step.message}`)
        },
      })
      const finished = await runtime.run(text)
      const outcome: LoopOutcome = abort.signal.aborted ? 'cancelled' : finished.status
      result = { kind: 'result', summary: runSummary(outcome, finished.attempts, loopView(runSteps).laps, finished.feedback), artifact: finished.artifact }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Run failed'
      result = { kind: 'result', summary: runSummary(abort.signal.aborted ? 'cancelled' : 'error', 0, loopView(runSteps).laps, abort.signal.aborted ? '' : message), artifact: '' }
    } finally {
      busy.current = false
      controller.current = null
    }
    if (!mounted.current) return
    append(result)
    setRunning(false)
  }

  function selectProject(dir: string, command: string) {
    setProject(dir)
    void rememberProject(dir)
    notice(`Working directory → ${safeText(displayPath(dir))}`, command)
  }
  async function changeDirectory(input: string, command: string) {
    try {
      const dir = await resolveProject(input, project)
      if (mounted.current) selectProject(dir, command)
    } catch (caught) {
      if (mounted.current) notice(safeText(caught instanceof Error ? caught.message : 'Unable to change directory'), command, true)
    }
  }
  async function openDirectoryPicker() {
    const token = ++pickerToken.current
    const [subdirs, recents] = await Promise.all([listDirectories(project), loadRecentProjects()])
    if (!mounted.current || token !== pickerToken.current) return
    setPanel({ kind: 'directory', browsing: project, subdirs, recents, filter: '', index: 0 })
  }
  async function browse(dir: string) {
    const token = ++pickerToken.current
    const subdirs = await listDirectories(dir)
    if (!mounted.current || token !== pickerToken.current) return
    setPanel(current => current?.kind === 'directory' ? { ...current, browsing: dir, subdirs, filter: '', index: 0 } : current)
  }
  function chooseWorker(id: string, command: string) {
    const worker = workers.find(agent => agent.id === id)
    if (!worker) { notice(`Unknown worker "${safeText(id)}" — choose one of ${workers.map(agent => agent.id).join(', ')}`, command, true); return }
    setWorkerId(worker.id); setHarnessId(worker.harness)
    notice(`Worker → ${worker.id} · harness ${worker.harness}`, command)
  }
  function chooseHarness(id: string, command: string) {
    if (!Object.hasOwn(config.harnesses, id)) { notice(`Unknown harness "${safeText(id)}" — choose one of ${harnessIds.join(', ')}`, command, true); return }
    setHarnessId(id)
    notice(`Harness → ${id} (${config.harnesses[id]!.type})`, command)
  }
  function openSelect(target: 'worker' | 'harness') {
    const index = target === 'worker' ? workers.findIndex(agent => agent.id === workerId) : harnessIds.indexOf(harnessId)
    setPanel({ kind: 'select', target, index: Math.max(0, index) })
  }
  function openSettings() {
    setDraft(config); setSettingsIndex(0); setSettingsDirty(false); setSettingsNotice(''); setPanel({ kind: 'settings' })
  }
  function closePanel() {
    pickerToken.current++
    setPanel(null); setDraft(null); setSettingsDirty(false); setSettingsNotice('')
  }
  function clearScreen() {
    // Ink's write() lifts the live frame off, emits the clear, and repaints it; the remounted Static re-emits the banner.
    write('\x1b[2J\x1b[3J\x1b[H')
    setTranscript([{ id: nextId.current++, kind: 'banner', project, configPath }])
    setStaticKey(key => key + 1)
  }
  function runCommand({ name, arg, command }: ParsedCommand) {
    const echo = `/${name}${arg ? ` ${arg}` : ''}`
    if (!command) { notice(`Unknown command /${safeText(name)} — /help lists commands`, safeText(echo), true); return }
    if (command.name === 'help') append({ kind: 'help' })
    else if (command.name === 'settings') openSettings()
    else if (command.name === 'cwd') void (arg ? changeDirectory(arg, safeText(echo)) : openDirectoryPicker())
    else if (command.name === 'worker') arg ? chooseWorker(arg, safeText(echo)) : openSelect('worker')
    else if (command.name === 'harness') arg ? chooseHarness(arg, safeText(echo)) : openSelect('harness')
    else if (command.name === 'clear') clearScreen()
    else if (command.name === 'exit') quit()
  }
  async function saveSettings() {
    if (!draft) return
    if (busy.current) { setSettingsNotice('A run is active; wait for it to finish before saving.'); return }
    try {
      assertRunnable(draft)
      await saveConfig(configPath, draft)
      const worker = draft.agents.find(agent => agent.role === 'worker')!
      setConfig(draft)
      setWorkerId(worker.id)
      setHarnessId(worker.harness)
      setSettingsDirty(false)
      setSettingsNotice('Saved — next run uses the new setup.')
    } catch (caught) {
      setSettingsNotice(`Save failed: ${safeText(caught instanceof Error ? caught.message : 'unknown error')}`)
    }
  }

  const matches = panel ? [] : matchCommands(task)
  const highlighted = matches.length ? menuIndex % matches.length : 0
  const fields = useMemo(() => settingsFields(draft ?? config), [draft, config])
  const view = useMemo(() => loopView(steps), [steps])
  const entries = panel?.kind === 'directory' ? directoryEntries(panel.browsing, panel.subdirs, panel.recents, project, panel.filter) : []
  const options = panel?.kind === 'select'
    ? panel.target === 'worker'
      ? workers.map(agent => ({ id: agent.id, detail: `harness ${agent.harness}`, current: agent.id === workerId }))
      : harnessIds.map(id => ({ id, detail: config.harnesses[id]!.type, current: id === harnessId }))
    : []

  function settingsKeys(input: string, key: Key) {
    // Some terminals (Zed's built-in terminal) swallow Ctrl+S/Ctrl+W before Ink sees them, so every
    // control here also has a plain-key form: s = save, q or Escape = close (discard).
    if (key.ctrl && (input === 's' || input === 'o') || key.escape || input === 'q') { closePanel(); return }
    if (key.ctrl && (input === 'w' || input === 'e') || key.return || input === 's') { void saveSettings(); return }
    if (key.tab) { setSettingsIndex(current => (current + (key.shift ? fields.length - 1 : 1)) % fields.length); return }
    if (key.upArrow) { setSettingsIndex(current => (current - 1 + fields.length) % fields.length); return }
    if (key.downArrow) { setSettingsIndex(current => (current + 1) % fields.length); return }
    if ((key.leftArrow || key.rightArrow) && draft) {
      const next = stepSetting(draft, fields[settingsIndex]!.key, key.leftArrow ? -1 : 1)
      if (next !== draft) { setDraft(next); setSettingsDirty(true) }
    }
  }
  function directoryKeys(state: Extract<Panel, { kind: 'directory' }>, input: string, key: Key) {
    const index = Math.min(state.index, entries.length - 1)
    if (key.escape) { closePanel(); return }
    if (key.upArrow || key.downArrow) { setPanel({ ...state, index: (index + (key.upArrow ? -1 : 1) + entries.length) % entries.length }); return }
    if (key.return) {
      const entry = entries[index]!
      if (entry.kind === 'use') { closePanel(); selectProject(entry.path, '/cwd') } else void browse(entry.path)
      return
    }
    if (key.leftArrow) { if (path.dirname(state.browsing) !== state.browsing) void browse(path.dirname(state.browsing)); return }
    if (key.backspace || key.delete) { setPanel({ ...state, filter: Array.from(state.filter).slice(0, -1).join(''), index: 0 }); return }
    const typed = safeText(input).replace(/\n/g, '')
    if (typed && !key.ctrl && !key.meta && !key.tab) setPanel({ ...state, filter: state.filter + typed, index: 0 })
  }
  function selectKeys(state: Extract<Panel, { kind: 'select' }>, key: Key) {
    if (key.escape) { closePanel(); return }
    if (key.upArrow || key.downArrow) { setPanel({ ...state, index: (state.index + (key.upArrow ? -1 : 1) + options.length) % options.length }); return }
    if (key.return) {
      const id = options[state.index]!.id
      closePanel()
      if (state.target === 'worker') chooseWorker(id, '/worker')
      else chooseHarness(id, '/harness')
    }
  }
  function promptKeys(input: string, key: Key) {
    const chars = Array.from(task)
    if (key.escape) { if (busy.current) interrupt(); else editInput('', 0); return }
    if (key.ctrl && (input === 's' || input === 'o')) { openSettings(); return }
    if (key.ctrl && input === 'd') { if (!task) quit(); return }
    if (matches.length) {
      if (key.upArrow || key.downArrow) { setMenuIndex((highlighted + (key.upArrow ? -1 : 1) + matches.length) % matches.length); return }
      const choice = matches[highlighted]!
      if (key.tab) { const completed = `/${choice.name}${choice.args ? ' ' : ''}`; editInput(completed, Array.from(completed).length); return }
      if (key.return) { const exact = parseCommand(task)?.command; editInput('', 0); runCommand({ name: (exact ?? choice).name, arg: '', command: exact ?? choice }); return }
    }
    if (key.return) {
      const text = task.trim()
      const parsed = parseCommand(text)
      if (parsed) { editInput('', 0); runCommand(parsed) } else if (text && !busy.current) void runTask(text)
      return
    }
    if (key.ctrl && input === 'u') { editInput('', 0); return }
    if (key.home) { setCursor(0); return }
    if (key.end) { setCursor(chars.length); return }
    if (key.leftArrow) { setCursor(current => Math.max(0, current - 1)); return }
    if (key.rightArrow) { setCursor(current => Math.min(chars.length, current + 1)); return }
    if (key.backspace) {
      if (cursor > 0) { chars.splice(cursor - 1, 1); editInput(chars.join(''), cursor - 1) }
      return
    }
    if (key.delete) { chars.splice(cursor, 1); editInput(chars.join(''), cursor); return }
    if (key.tab || key.upArrow || key.downArrow || key.ctrl || key.meta) return
    const inserted = Array.from(safeText(input).replace(/\n/g, ' '))
    if (!inserted.length) return
    chars.splice(cursor, 0, ...inserted); editInput(chars.join(''), cursor + inserted.length)
  }
  useInput((input, key) => {
    if (key.ctrl && input === 'c') { if (busy.current) interrupt(); else quit(); return }
    if (columns < MIN_COLUMNS) return
    if (panel?.kind === 'settings') settingsKeys(input, key)
    else if (panel?.kind === 'directory') directoryKeys(panel, input, key)
    else if (panel?.kind === 'select') selectKeys(panel, key)
    else promptKeys(input, key)
  })

  const workerHarness = config.harnesses[harnessId]
  const demo = workerHarness?.type === 'demo' || config.harnesses[reviewer.harness]?.type === 'demo'
  const chars = Array.from(task)
  const inputWidth = Math.max(10, columns - 7)
  const inputStart = Math.max(0, cursor - inputWidth + 1)
  const transcriptView = <Static key={staticKey} items={transcript}>{item => <TranscriptItem key={item.id} item={item} columns={columns} />}</Static>
  if (columns < MIN_COLUMNS) return <Box flexDirection="column">{transcriptView}<Text wrap="truncate">Widen the terminal to at least {MIN_COLUMNS} columns.</Text></Box>

  let editor: React.ReactNode
  if (panel?.kind === 'settings' && draft) {
    editor = <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between"><Text bold color="cyan">Settings</Text>
        <Text color={settingsDirty ? 'yellow' : 'green'}>{settingsDirty ? '● unsaved changes' : 'saved'}</Text></Box>
      <Text dimColor wrap="truncate">{safeText(configPath)} · {formatFor(configPath)}</Text>
      <Text dimColor wrap="truncate">Router: rule or model:&lt;router agent&gt; · Timeout steps by 1000 ms.</Text>
      {fields.map((field, index) => <Text key={field.key} color={index === settingsIndex ? 'cyan' : undefined} wrap="truncate">
        {index === settingsIndex ? '› ' : '  '}{field.label}: {field.value}</Text>)}
      {settingsNotice ? <Text color={settingsNotice.startsWith('Save failed') ? 'red' : 'green'} wrap="truncate">{settingsNotice}</Text> : null}
      {running ? <Text color="yellow" wrap="truncate">A run is active; saving is paused until it ends.</Text> : null}
      <Text dimColor wrap="truncate">↑/↓ field · ←/→ change · Enter or s save · q or Esc close{settingsDirty ? ' (discards edits)' : ''}</Text>
    </Box>
  } else if (panel?.kind === 'directory') {
    let recentShown = false
    const rows = entries.map((entry): PickerRow => {
      const section = entry.kind === 'recent' && !recentShown ? 'Recent' : undefined
      if (section) recentShown = true
      if (entry.kind === 'use') return { key: 'use', label: `✓ Use ${safeText(displayPath(entry.path))}`, color: 'green' }
      if (entry.kind === 'parent') return { key: 'parent', label: '..' }
      if (entry.kind === 'dir') return { key: `dir:${entry.name}`, label: `${safeText(entry.name)}/` }
      return { key: `recent:${entry.path}`, label: safeText(displayPath(entry.path)), section }
    })
    editor = <Picker title={`Choose a directory · ${safeText(displayPath(panel.browsing))}${panel.filter ? `  filter: ${safeText(panel.filter)}` : ''}`} rows={rows}
      index={Math.min(panel.index, rows.length - 1)} hint="↑/↓ move · Enter open or use · ← parent · type to filter · Esc cancel" />
  } else if (panel?.kind === 'select') {
    editor = <Picker title={panel.target === 'worker' ? 'Choose a worker' : `Choose a harness for ${workerId}`} index={panel.index}
      rows={options.map(option => ({ key: option.id, label: option.id, detail: `${option.detail}${option.current ? ' · current' : ''}` }))} hint="↑/↓ move · Enter select · Esc cancel" />
  } else {
    editor = <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan" bold>{'> '}</Text>
      <Text wrap="truncate">{chars.slice(inputStart, cursor).join('')}<Text inverse>{chars[cursor] || ' '}</Text>{chars.slice(cursor + 1, inputStart + inputWidth).join('')}{!task ? <Text dimColor>Describe a task · / for commands</Text> : null}</Text>
    </Box>
  }
  const labelWidth = Math.max(0, ...matches.map(command => commandLabel(command).length)) + 2
  return <Box flexDirection="column">
    {transcriptView}
    <Box flexDirection="column" width={columns} marginTop={1}>
      {running ? <Box flexDirection="column" marginBottom={1}>
        <LoopPanel view={view} maxAttempts={config.maxAttempts} steps={steps} />
        <Text wrap="truncate"><Text color="yellow">◉ {stage}</Text><Text dimColor>  esc to interrupt</Text></Text>
      </Box> : null}
      {editor}
      {matches.length ? <Box flexDirection="column" paddingX={2}>
        {matches.map((command, index) => <Text key={command.name} wrap="truncate">
          <Text color={index === highlighted ? 'cyan' : undefined} bold={index === highlighted}>{commandLabel(command).padEnd(labelWidth)}</Text>
          <Text color={index === highlighted ? 'cyan' : undefined} dimColor={index !== highlighted}>{command.description}{command.aliases.length ? ` · /${command.aliases.join(', /')}` : ''}</Text>
        </Text>)}
      </Box> : null}
      <Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate"><Text color="cyan">{safeText(displayPath(project))}</Text><Text dimColor> · </Text>{workerId} → {harnessId}<Text dimColor> · </Text>review: {reviewer.id}<Text dimColor> · </Text>router: {routerLabel(config.router)}{demo ? <><Text dimColor> · </Text><Text color="yellow">demo</Text></> : null}</Text>
        </Box>
        <Box flexShrink={0} marginLeft={2}><Text dimColor>{safeText(path.basename(configPath))}</Text></Box>
      </Box>
    </Box>
  </Box>
}
export async function launchTui(input: unknown, configPath: string, initialTask?: string, project?: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The TUI needs an interactive terminal. Use --task for noninteractive runs.')
  const config = configSchema.parse(input)
  fromConfig(config) // Validate agent/harness references before rendering.
  const app = render(<HivemindTui config={config} configPath={configPath} initialTask={initialTask} project={project} />, { exitOnCtrlC: false })
  await app.waitUntilExit()
}
