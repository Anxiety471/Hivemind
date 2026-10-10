import path from 'node:path'
import stringWidth from 'string-width'
import type { z } from 'zod'
import { withAgentHarness, withLimits, withRouter } from './config-file.js'
import { configSchema } from './config.js'
import type { Progress } from './graph.js'
import type { RunState } from './types.js'
export type Config = z.infer<typeof configSchema>

export interface SettingField { key: string; label: string; value: string }

export function routerLabel(router: Config['router']): string {
  return router.type === 'model' ? `model:${router.agent}` : 'rule'
}
// The editable setup rows shown by the Settings overlay. Static shape: only values change as the draft is edited.
export function settingsFields(config: Config): SettingField[] {
  return [
    { key: 'router', label: 'Router', value: routerLabel(config.router) },
    { key: 'maxAttempts', label: 'Max attempts', value: String(config.maxAttempts) },
    { key: 'timeoutMs', label: 'Timeout (ms)', value: String(config.timeoutMs) },
    ...config.agents.map(agent => ({ key: `agent:${agent.id}`, label: `${agent.id} · ${agent.role} harness`, value: agent.harness })),
  ]
}
function routerOptions(config: Config): Config['router'][] {
  return [{ type: 'rule' }, ...config.agents.filter(agent => agent.role === 'router').map(agent => ({ type: 'model' as const, agent: agent.id }))]
}
function sameRouter(left: Config['router'], right: Config['router']): boolean {
  return left.type === 'rule' && right.type === 'rule'
    || left.type === 'model' && right.type === 'model' && left.agent === right.agent
}
// Cycle one setting with Left/Right. Returns the input config unchanged when the step is a no-op; unknown keys throw.
export function stepSetting(config: Config, key: string, delta: number): Config {
  if (key === 'router') {
    const options = routerOptions(config)
    const index = options.findIndex(option => sameRouter(option, config.router))
    const next = options[(index + delta + options.length) % options.length]!
    return sameRouter(next, config.router) ? config : withRouter(config, next)
  }
  if (key === 'maxAttempts') {
    const next = Math.min(100, Math.max(1, config.maxAttempts + delta))
    return next === config.maxAttempts ? config : withLimits(config, { maxAttempts: next })
  }
  if (key === 'timeoutMs') {
    const next = Math.max(1, config.timeoutMs + delta * 1000)
    return next === config.timeoutMs ? config : withLimits(config, { timeoutMs: next })
  }
  if (key.startsWith('agent:')) {
    const agentId = key.slice('agent:'.length)
    const agent = config.agents.find(candidate => candidate.id === agentId)
    if (!agent) throw new Error(`Unknown agent: ${agentId}`)
    const ids = Object.keys(config.harnesses)
    if (!ids.length) return config
    const index = ids.indexOf(agent.harness)
    const base = index < 0 ? (delta > 0 ? -1 : 0) : index
    const next = ids[(base + delta + ids.length) % ids.length]!
    return next === agent.harness ? config : withAgentHarness(config, agentId, next)
  }
  throw new Error(`Unknown setting: ${key}`)
}

export function selectWorker(config: Config, workerId: string, harnessId: string): Config {
  if (!config.agents.some(agent => agent.id === workerId && agent.role === 'worker')) throw new Error('Unknown worker')
  if (!config.harnesses[harnessId]) throw new Error('Unknown harness')
  return { ...config, agents: config.agents.filter(agent => agent.role !== 'worker' || agent.id === workerId)
    .map(agent => agent.id === workerId ? { ...agent, harness: harnessId } : agent) }
}
// Strip terminal control sequences from model responses and pasted task input.
export function safeText(text: string): string {
  return text.replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}
export function pageLines(text: string, width: number): string[] {
  const limit = Math.max(1, width)
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return safeText(text).split('\n').flatMap(line => {
    if (!line) return ['']
    const result: string[] = []
    let buffer = ''
    for (const { segment } of segmenter.segment(line)) {
      if (buffer && stringWidth(buffer + segment) > limit) {
        const space = buffer.lastIndexOf(' ')
        if (space > 0) {
          result.push(buffer.slice(0, space))
          buffer = buffer.slice(space + 1)
          // A long unbroken remainder may still need its own line.
          if (stringWidth(buffer + segment) > limit) { result.push(buffer); buffer = '' }
        } else { result.push(buffer); buffer = '' }
      }
      buffer += segment
    }
    result.push(buffer)
    return result
  })
}

export type NodeState = 'idle' | 'active' | 'done' | 'revise' | 'failed'
export type LoopOutcome = RunState['status'] | 'cancelled' | 'error'
export interface LoopView {
  decide: NodeState; work: NodeState; review: NodeState
  finish: NodeState; finishLabel: string
  // The review → decide back-edge: idle until a revise verdict, active while the next lap is underway.
  backEdge: 'idle' | 'taken' | 'active'
  attempt: number; laps: number
}
// Fold one run's live progress into the state of the decide → work → review loop diagram.
// Each new decide starts a fresh lap: work/review reset so the diagram shows the current pass only.
export function loopView(progress: Progress[], outcome?: LoopOutcome): LoopView {
  const view: LoopView = { decide: 'idle', work: 'idle', review: 'idle', finish: 'idle', finishLabel: 'done', backEdge: 'idle', attempt: 0, laps: 0 }
  for (const step of progress) {
    view.attempt = Math.max(view.attempt, step.attempt)
    if (step.phase === 'start') {
      if (step.node === 'decide' && view.review === 'revise') {
        view.laps += 1; view.work = 'idle'; view.review = 'idle'; view.backEdge = 'active'
      }
      view[step.node] = 'active'
      continue
    }
    const failed = step.status === 'blocked' || step.status === 'exhausted'
    view[step.node] = failed ? 'failed' : step.node === 'review' && /^revise\b/.test(step.message) ? 'revise' : 'done'
    if (step.node === 'decide' && view.backEdge === 'active') view.backEdge = 'taken'
  }
  if (outcome && outcome !== 'running') {
    for (const node of ['decide', 'work', 'review'] as const) if (view[node] === 'active') view[node] = outcome === 'completed' ? 'done' : 'failed'
    if (view.backEdge === 'active') view.backEdge = 'taken'
    view.finish = outcome === 'completed' ? 'done' : 'failed'
    view.finishLabel = outcome
  }
  return view
}

export interface SlashCommand { name: string; aliases: string[]; args?: string; description: string }
// The `/` command table shown by the prompt menu, `/help`, and the README.
export const slashCommands: readonly SlashCommand[] = [
  { name: 'help', aliases: [], description: 'List commands and key bindings' },
  { name: 'settings', aliases: ['config'], description: 'Edit router, limits, and agent harnesses (saved to the config file)' },
  { name: 'cwd', aliases: ['dir'], args: '[path]', description: 'Change the project directory the agents work in' },
  { name: 'worker', aliases: [], args: '[id]', description: 'Choose the worker for the next runs' },
  { name: 'harness', aliases: [], args: '[id]', description: "Choose the selected worker's harness for the next runs" },
  { name: 'clear', aliases: [], description: 'Clear the screen and the transcript' },
  { name: 'exit', aliases: ['quit'], description: 'Interrupt any run and exit' },
]
export const keyBindings: readonly (readonly [string, string])[] = [
  ['Enter', 'Run the task, or the highlighted / command'],
  ['↑/↓ · Tab', 'Move through the / menu · complete the highlighted command'],
  ['←/→ · Home/End', 'Move the prompt cursor'],
  ['Ctrl+U', 'Clear the prompt'],
  ['Esc', 'Close a panel, interrupt a run, or clear the prompt'],
  ['Ctrl+S / Ctrl+O', 'Open settings'],
  ['Ctrl+C', 'Interrupt a run, or exit when idle'],
  ['Ctrl+D', 'Exit from an empty prompt'],
]
export function commandLabel(command: SlashCommand): string {
  return `/${command.name}${command.args ? ` ${command.args}` : ''}`
}
// Menu rows for a prompt that is still a bare `/word`: commands whose name or alias starts with the typed prefix.
export function matchCommands(input: string): SlashCommand[] {
  const typed = /^\/(\S*)$/.exec(input)
  if (!typed) return []
  const prefix = typed[1]!.toLowerCase()
  return slashCommands.filter(command => [command.name, ...command.aliases].some(name => name.startsWith(prefix)))
}
export interface ParsedCommand { name: string; arg: string; command?: SlashCommand }
// `/name rest` → the matching command (by name or alias) and its argument; null when the input is not a command.
export function parseCommand(input: string): ParsedCommand | null {
  const match = /^\/(\S*)\s*([\s\S]*)$/.exec(input.trim())
  if (!match) return null
  const name = match[1]!.toLowerCase()
  return { name, arg: match[2]!.trim(), command: slashCommands.find(command => command.name === name || command.aliases.includes(name)) }
}

export interface RunSummary { text: string; color: 'green' | 'yellow' | 'red' }
// The one-line transcript summary of a finished run, e.g. `● completed · 2 attempts · 1 revision`.
export function runSummary(outcome: LoopOutcome, attempts: number, laps: number, feedback = ''): RunSummary {
  const parts: string[] = [outcome]
  if (attempts > 0) parts.push(`${attempts} attempt${attempts === 1 ? '' : 's'}`)
  if (laps > 0) parts.push(`${laps} revision${laps === 1 ? '' : 's'}`)
  const detail = safeText(feedback).replace(/\s+/g, ' ').trim()
  if (outcome !== 'completed' && detail) parts.push(detail)
  const color = outcome === 'completed' ? 'green' : outcome === 'blocked' || outcome === 'error' ? 'red' : 'yellow'
  return { text: `● ${parts.join(' · ')}`, color }
}

// First visible row of a `size`-row window over `length` rows that keeps `index` in view, roughly centred.
export function windowStart(length: number, index: number, size: number): number {
  return Math.max(0, Math.min(index - Math.floor(size / 2), length - size))
}

export interface DirectoryEntry { kind: 'use' | 'parent' | 'dir' | 'recent'; path: string; name: string }
// Rows of the `/cwd` picker: select the browsed dir, its parent, its (filtered) subdirectories, then recent projects.
export function directoryEntries(browsing: string, subdirs: string[], recents: string[], current: string, filter = ''): DirectoryEntry[] {
  const parent = path.dirname(browsing)
  const needle = filter.toLowerCase()
  return [
    { kind: 'use', path: browsing, name: browsing },
    ...parent !== browsing ? [{ kind: 'parent' as const, path: parent, name: '..' }] : [],
    ...subdirs.filter(name => name.toLowerCase().includes(needle)).map(name => ({ kind: 'dir' as const, path: path.join(browsing, name), name })),
    ...recents.filter(dir => dir !== current).map(dir => ({ kind: 'recent' as const, path: dir, name: dir })),
  ]
}
