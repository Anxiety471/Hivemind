import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'
import { configSchema, fromConfig } from './config.js'
import type { Progress } from './graph.js'
import type { RunState } from './types.js'
import { pageLines, safeText, selectWorker, type Config } from './tui-state.js'

type Runner = typeof fromConfig
export interface TuiProps { config: Config; configPath: string; initialTask?: string; runner?: Runner }
export function HivemindTui({ config, configPath, initialTask = '', runner = fromConfig }: TuiProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const terminal = stdout as NodeJS.WriteStream
  const workers = config.agents.filter(agent => agent.role === 'worker')
  const harnessIds = Object.keys(config.harnesses)
  const reviewer = config.agents.find(agent => agent.role === 'reviewer')!
  const [workerIndex, setWorkerIndex] = useState(0)
  const [harnessId, setHarnessId] = useState(workers[0]!.harness)
  const [task, setTask] = useState(initialTask)
  const [cursor, setCursor] = useState(Array.from(initialTask).length)
  const [showHistory, setShowHistory] = useState(false)
  const [focus, setFocus] = useState(2)
  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState('Ready')
  const [events, setEvents] = useState<string[]>([])
  const [result, setResult] = useState<RunState | null>(null)
  const [artifact, setArtifact] = useState('Enter a task to start. Each run starts a fresh workflow.')
  const [error, setError] = useState('')
  const [scroll, setScroll] = useState(0)
  const [size, setSize] = useState({ columns: terminal.columns || 80, rows: terminal.rows || 24 })
  const controller = useRef<AbortController | null>(null)
  const busy = useRef(false)
  const mounted = useRef(true)
  const history = useRef<string[]>([])
  const worker = workers[workerIndex]!
  useEffect(() => {
    const resize = () => setSize({ columns: terminal.columns || 80, rows: terminal.rows || 24 })
    stdout.on('resize', resize)
    return () => { stdout.off('resize', resize) }
  }, [stdout])
  useEffect(() => () => { mounted.current = false; controller.current?.abort() }, [])

  async function submit() {
    if (busy.current || !task.trim()) return
    busy.current = true
    const abort = new AbortController()
    controller.current = abort
    setRunning(true); setResult(null); setError(''); setEvents([]); setScroll(0)
    setShowHistory(false)
    setArtifact('Waiting for the worker response…'); setStage('Starting')
    history.current.push(`You: ${safeText(task.trim())}`)
    try {
      const runtime = runner(selectWorker(config, worker.id, harnessId), {
        signal: abort.signal,
        onProgress(progress: Progress) {
          if (!mounted.current) return
          if (progress.phase === 'start') setStage(`${progress.node === 'decide' ? 'Deciding' : progress.node === 'work' ? 'Working' : 'Reviewing'} · ${safeText(progress.message)}`)
          else {
            setEvents(previous => [...previous, `${progress.node} #${progress.attempt}: ${safeText(progress.message)}`])
            if (progress.artifact !== undefined) { setArtifact(progress.artifact); setScroll(0) }
          }
        },
      })
      const finished = await runtime.run(task.trim())
      if (!mounted.current) return
      setResult(finished)
      setStage(abort.signal.aborted ? 'Cancelled' : finished.status)
      setArtifact(finished.artifact || finished.feedback)
      history.current.push(`Hivemind (${abort.signal.aborted ? 'cancelled' : finished.status}): ${safeText(finished.artifact || finished.feedback)}`)
      setTask(''); setCursor(0); setScroll(0)
    } catch (caught) {
      if (!mounted.current) return
      const message = abort.signal.aborted ? 'Run cancelled' : caught instanceof Error ? caught.message : 'Run failed'
      setError(safeText(message)); setStage(abort.signal.aborted ? 'Cancelled' : 'Error')
    } finally {
      busy.current = false
      controller.current = null
      if (mounted.current) setRunning(false)
    }
  }
  const resultRows = Math.max(2, Math.min(12, size.rows - 18))
  const lines = useMemo(() => pageLines(showHistory ? history.current.join('\n\n') || 'No conversation yet.' : artifact, Math.max(10, size.columns - 6)), [showHistory, artifact, result, size.columns])
  const maxScroll = Math.max(0, lines.length - resultRows)
  const offset = Math.min(scroll, maxScroll)
  useInput((input, key) => {
    if (key.ctrl && input === 'c') { controller.current?.abort(); exit(); return }
    if (key.escape) {
      if (busy.current) { controller.current?.abort(); setStage('Cancelling…') }
      else exit()
      return
    }
    if (size.columns < 60 || size.rows < 20) return
    if (key.pageDown) { setScroll(current => Math.min(maxScroll, current + resultRows)); return }
    if (key.pageUp) { setScroll(current => Math.max(0, current - resultRows)); return }
    if (key.ctrl && input === 'y') { setShowHistory(current => !current); setScroll(0); return }
    if (busy.current) return
    if (key.tab) { setFocus(current => (current + (key.shift ? 2 : 1)) % 3); return }
    if (focus === 2) {
      const chars = Array.from(task)
      if (key.return) { void submit(); return }
      if (key.ctrl && input === 'u') { setTask(''); setCursor(0); return }
      if (key.home) { setCursor(0); return }
      if (key.end) { setCursor(chars.length); return }
      if (key.leftArrow) { setCursor(current => Math.max(0, current - 1)); return }
      if (key.rightArrow) { setCursor(current => Math.min(chars.length, current + 1)); return }
      if (key.backspace) {
        if (cursor > 0) { chars.splice(cursor - 1, 1); setTask(chars.join('')); setCursor(cursor - 1) }
        return
      }
      if (key.delete) { chars.splice(cursor, 1); setTask(chars.join('')); return }
      if (!key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
        const inserted = Array.from(safeText(input).replace(/\n/g, ' '))
        chars.splice(cursor, 0, ...inserted); setTask(chars.join('')); setCursor(cursor + inserted.length)
      }
      return
    }
    if (focus !== 2 && (key.leftArrow || key.rightArrow)) {
      const delta = key.leftArrow ? -1 : 1
      if (focus === 0) {
        const next = (workerIndex + delta + workers.length) % workers.length
        setWorkerIndex(next); setHarnessId(workers[next]!.harness)
      } else setHarnessId(harnessIds[(harnessIds.indexOf(harnessId) + delta + harnessIds.length) % harnessIds.length]!)
    }
  })
  const chars = Array.from(task)
  const inputWidth = Math.max(10, size.columns - 12)
  const inputStart = Math.max(0, cursor - inputWidth + 1)
  const beforeCursor = chars.slice(inputStart, cursor).join('')
  const cursorChar = chars[cursor] || ' '
  const afterCursor = chars.slice(cursor + 1, inputStart + inputWidth).join('')
  if (size.columns < 60 || size.rows < 20) return <Text>Resize terminal to at least 60 × 20. Esc / Ctrl+C quits.</Text>
  return <Box flexDirection="column" width={size.columns}>
    <Box justifyContent="space-between"><Text bold color="cyan">HIVEMIND</Text><Text color={running ? 'yellow' : result?.status === 'completed' ? 'green' : 'cyan'} wrap="truncate">{stage}</Text></Box>
    <Text dimColor wrap="truncate">LangGraph · {safeText(configPath)} · max {config.maxAttempts} attempts</Text>
    <Box gap={2}>
      <Text color={focus === 0 ? 'cyan' : undefined}>{focus === 0 ? '› ' : '  '}Worker: {worker.id}</Text>
      <Text color={focus === 1 ? 'cyan' : undefined}>{focus === 1 ? '› ' : '  '}Harness: {harnessId} ({config.harnesses[harnessId]!.type})</Text>
    </Box>
    <Text dimColor wrap="truncate">Reviewer: {reviewer.id} / {reviewer.harness} · Router: {config.router.type}</Text>
    {config.harnesses[harnessId]!.type === 'demo' || config.harnesses[reviewer.harness]!.type === 'demo'
      ? <Text color="yellow">Demo adapter active — responses or reviews are simulated.</Text> : null}
    <Box borderStyle="round" borderColor={focus === 2 ? 'cyan' : 'gray'} paddingX={1}>
      <Text color="cyan">Task › </Text><Text wrap="truncate">{beforeCursor}<Text inverse={focus === 2 && !running}>{cursorChar}</Text>{afterCursor}{!task ? <Text dimColor>Describe the task, then press Enter</Text> : null}</Text>
    </Box>
    <Text bold>Workflow</Text>
    {(events.length ? events.slice(-3) : ['Decide → work → review → repeat or finish']).map((event, index) => <Text key={index} wrap="truncate">{event}</Text>)}
    <Box borderStyle="round" flexDirection="column" paddingX={1} height={resultRows + 2}>
      {lines.slice(offset, offset + resultRows).map((line, index) => <Text key={index} wrap="truncate">{line || ' '}</Text>)}
    </Box>
    {result && result.status !== 'completed' ? <Text color="yellow" wrap="truncate">{safeText(result.feedback || 'Attempt limit reached')}</Text> : null}
    {error ? <Text color="red" wrap="truncate">{error}</Text> : null}
    <Text dimColor wrap="truncate">Tab: field · ←/→: select · Enter: run · PgUp/PgDn: scroll · Ctrl+Y: history</Text>
    <Text dimColor wrap="truncate">{running ? 'Esc: cancel' : 'Esc: quit'} · Ctrl+C: quit · Ctrl+U: clear task · {offset + 1}–{Math.min(lines.length, offset + resultRows)} / {lines.length} lines</Text>
  </Box>
}
export async function launchTui(input: unknown, configPath: string, initialTask?: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The TUI needs an interactive terminal. Use --task for noninteractive runs.')
  const config = configSchema.parse(input)
  fromConfig(config) // Validate agent/harness references before rendering.
  const app = render(<HivemindTui config={config} configPath={configPath} initialTask={initialTask} />, { exitOnCtrlC: false })
  await app.waitUntilExit()
}
