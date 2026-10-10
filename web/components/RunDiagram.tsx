'use client'

import { useEffect, useId, useState } from 'react'
import type { Decision, NodeName, Progress, Role, Run, RunPhaseStatus, StageName } from '@/lib/types'

export type NodeState = 'idle' | 'active' | 'done' | 'blocked' | 'interrupted' | 'failed'
export interface AgentInfo { agent: string; harness: string; role?: Role }
export interface Roster {
  router?: AgentInfo | 'rule' | 'jev'
  reviewer?: AgentInfo
  agents: Record<string, AgentInfo>
}
type Tone = 'idle' | 'info' | 'ok' | 'warn' | 'err'

export const NODES: NodeName[] = ['decide', 'orchestrate', 'research', 'plan', 'design', 'work', 'review', 'security-review']
const ROLES: Record<NodeName, Role> = {
  decide: 'router',
  orchestrate: 'orchestrator',
  'security-review': 'security-reviewer',
  research: 'researcher',
  plan: 'planner',
  design: 'designer',
  work: 'worker',
  review: 'reviewer',
}
const TONES: Record<NodeState, Tone> = { idle: 'idle', active: 'info', done: 'ok', blocked: 'warn', interrupted: 'warn', failed: 'err' }
const STATE_WORD: Record<NodeState, string> = { idle: 'waiting', active: 'running', done: 'done', blocked: 'blocked', interrupted: 'interrupted', failed: 'failed' }
const VIA = /^(.+?) via (.+)$/

const ICONS: Record<string, string[]> = {
  router: ['M6 3v12', 'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 9a9 9 0 0 1-9 9'],
  orchestrator: ['M12 3v6', 'M5 15v-3h14v3', 'M5 15v6', 'M19 15v6', 'M12 9v12'],
  'security-reviewer': ['M12 2 3 6v6c0 5 4 8 9 10 5-2 9-5 9-10V6z', 'M8 12l3 3 5-6'],
  worker: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'],
  reviewer: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
  researcher: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'm21 21-4.35-4.35'],
  planner: ['M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2', 'M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2h-2a2 2 0 0 1-2-2z', 'M9 12h6', 'M9 16h4'],
  designer: ['M12 2a10 10 0 1 0 10 10c0-1.66-1.34-3-3-3h-2.5c-.83 0-1.5-.67-1.5-1.5 0-.39.15-.74.39-1.01l.05-.06A3.49 3.49 0 0 0 16 4.3 9.96 9.96 0 0 0 12 2z', 'M7.5 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M12 7.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M16.5 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z'],
  check: ['M20 6 9 17l-5-5'],
  alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
  failed: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'm15 9-6 6', 'm9 9 6 6'],
}

function Icon({ name, x, y, size }: { name: string; x: number; y: number; size: number }) {
  return (
    <g className="rd-icon" transform={`translate(${x} ${y}) scale(${size / 24})`} aria-hidden>
      {(ICONS[name] ?? []).map(d => <path key={d} d={d} />)}
    </g>
  )
}

function findLast<T>(items: T[], test: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) if (test(items[index]!)) return items[index]
  return undefined
}

// Harness retries (`retry` set on the progress item) re-announce a node start; they are never a new attempt or phase.
export function retryOf(item: Progress): number | undefined {
  const retry = (item as Progress & { retry?: unknown }).retry
  return typeof retry === 'number' ? retry : undefined
}

export function nodeState(items: Progress[], node: NodeName, status: RunPhaseStatus): NodeState {
  const last = findLast(items, item => item.node === node && retryOf(item) === undefined)
  if (!last) return 'idle'
  if (last.phase === 'start') return status === 'running' ? 'active' : status === 'failed' ? 'failed' : 'interrupted'
  if (last.status && last.status !== 'running' && last.status !== 'completed') return 'blocked'
  return 'done'
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

export function parseAgentsFromMessage(message: string): { agents: string[]; harness: string } {
  if (message.includes(',') && message.includes(' via ')) {
    const parts = message.split(',').map(s => s.trim())
    if (parts.every(p => p.includes(' via '))) {
      const agents: string[] = []
      const harnesses: string[] = []
      for (const part of parts) {
        const m = VIA.exec(part)
        if (m) {
          agents.push(m[1]!.trim())
          harnesses.push(m[2]!.trim())
        }
      }
      return { agents, harness: [...new Set(harnesses)].join(', ') }
    }
  }

  const m = VIA.exec(message)
  if (m) {
    const agents = m[1]!.split(',').map(s => s.trim()).filter(Boolean)
    return { agents, harness: m[2]!.trim() }
  }

  const agents = message.split(',').map(s => s.trim()).filter(Boolean)
  return { agents, harness: '' }
}

interface Rect { x: number; y: number; w: number; h: number }
interface EdgePath { id: string; from: string; to: string; d: string; tone: Tone }
interface DynamicLayout {
  id: 'wide' | 'tall'
  w: number
  h: number
  node: Record<string, Rect>
  edges: EdgePath[]
  revise: { x: number; y: number; d: string; tone: Tone }
}
interface NodeView {
  id: string
  name: NodeName
  title: string
  role: Role
  state: NodeState
  agent: string
  via: string
  since?: number
  note?: string
  retry?: { count: number; message: string }
}
type SpawnDecision = Extract<Decision, { action: 'dispatch' | 'work' }>
const STAGES: StageName[] = ['research', 'plan', 'design', 'work']
const NODE_H = 108
const NODE_W = 232

function isSpawnDecision(decision?: Decision | null): decision is SpawnDecision {
  return decision?.action === 'dispatch' || decision?.action === 'work'
}

// A router at attempt N dispatches attempt N + 1. Its next start still says N,
// so event order, not just the largest attempt number, identifies the current cycle.
function currentCycle(progress: Progress[], run: Run) {
  const core = progress.filter(item => retryOf(item) === undefined)
  const lastRouter = core.findLastIndex(item => item.node === 'decide')
  const routerPending = lastRouter >= 0 && core[lastRouter]!.phase === 'start'
  const routerStart = core.findLastIndex(item => item.node === 'decide' && item.phase === 'start')
  const routerEvents = routerStart >= 0
    ? progress.slice(progress.indexOf(core[routerStart]!)).filter(item => item.node === 'decide')
    : progress.filter(item => item.node === 'decide')
  const maxAttempt = core.reduce((max, item) => Math.max(max, item.attempt), run.result?.attempts ?? 0)

  if (routerPending) {
    return { attempt: maxAttempt, events: routerEvents, routerEvents, decision: undefined, looped: maxAttempt > 0 }
  }

  // Keep the last executed dispatch visible after a terminal Router decision,
  // but never reuse it while that next Router decision is still being evaluated.
  const dispatchEvent = findLast(core, item => (item.node === 'decide' || item.node === 'orchestrate') && item.phase === 'end' && isSpawnDecision(item.decision))
  const resultDecision = run.result?.decision
  const decision = dispatchEvent?.decision ?? (isSpawnDecision(resultDecision) ? resultDecision : undefined)
  const attempt = dispatchEvent ? dispatchEvent.attempt + 1 : maxAttempt
  const events = progress.filter(item => item.node !== 'decide' && (item.attempt === attempt || item.node === 'orchestrate' && item.attempt === attempt - 1))
  return { attempt, events, routerEvents, decision, looped: routerEvents.some(item => item.attempt > 0) || attempt > 1 }
}

function messageAgent(message: string, agent: string): string {
  const parsed = parseAgentsFromMessage(message)
  if (!parsed.agents.includes(agent)) return ''
  // Multiple harnesses are emitted as "a via x, b via y"; do not attribute
  // their combined harness list to each individual dispatched agent.
  if (parsed.harness.includes(',')) {
    const part = message.split(',').map(item => item.trim()).find(item => VIA.exec(item)?.[1]?.trim() === agent)
    return part ? VIA.exec(part)?.[2]?.trim() ?? '' : ''
  }
  return parsed.harness
}

function computeLayout(layoutId: 'wide' | 'tall', groups: NodeView[][], looped: boolean): DynamicLayout {
  const node: Record<string, Rect> = {}
  let w: number
  let h: number
  if (layoutId === 'wide') {
    const cardW = groups.length <= 3 ? 200 : NODE_W
    const gap = groups.length <= 3 ? 44 : 56
    const rows = Math.max(...groups.map(group => group.length))
    const contentH = rows * NODE_H + (rows - 1) * 24
    groups.forEach((group, column) => group.forEach((item, row) => {
      node[item.id] = {
        x: 20 + column * (cardW + gap),
        y: 24 + (contentH - (group.length * NODE_H + (group.length - 1) * 24)) / 2 + row * (NODE_H + 24),
        w: cardW, h: NODE_H,
      }
    }))
    w = 40 + groups.length * cardW + (groups.length - 1) * gap
    h = contentH + 114
  } else {
    let y = 20
    for (const group of groups) {
      for (const item of group) {
        node[item.id] = { x: 34, y, w: NODE_W, h: NODE_H }
        y += NODE_H + 24
      }
      y += 32
    }
    w = 345
    h = y - 32
  }

  const edges: EdgePath[] = []
  for (let index = 0; index < groups.length - 1; index++) {
    const sources = groups[index]!
    const targets = groups[index + 1]!
    const lastSource = node[sources.at(-1)!.id]!
    const firstTarget = node[targets[0]!.id]!
    for (const source of sources) {
      for (const target of targets) {
        const a = node[source.id]!
        const b = node[target.id]!
        const tone = TONES[target.state]
        let d: string
        if (layoutId === 'wide') {
          const midX = (a.x + a.w + b.x) / 2
          d = `M${a.x + a.w} ${a.y + a.h / 2}H${midX}V${b.y + b.h / 2}H${b.x}`
        } else {
          const midY = (lastSource.y + lastSource.h + firstTarget.y) / 2
          const exit = sources.length === 1
            ? `M150 ${a.y + a.h}V${midY}`
            : `M${a.x + a.w} ${a.y + a.h / 2}H284V${midY}H150`
          const entry = targets.length === 1
            ? `V${b.y}`
            : `H16V${b.y + b.h / 2}H${b.x}`
          d = exit + entry
        }
        edges.push({ id: `${source.id}-${target.id}`, from: source.id, to: target.id, d, tone })
      }
    }
  }

  const router = groups[0]![0]!
  const reviewer = groups.at(-1)![0]!
  const a = node[router.id]!
  const b = node[reviewer.id]!
  const tone: Tone = !looped ? 'idle' : router.state === 'active' ? 'info' : 'ok'
  const revise = layoutId === 'wide'
    ? {
        x: (a.x + a.w / 2 + b.x + b.w / 2) / 2, y: h - 22,
        d: `M${b.x + b.w / 2} ${b.y + b.h}V${h - 44}H${a.x + a.w / 2}V${a.y + a.h}`,
        tone,
      }
    : {
        x: 316, y: (a.y + b.y + NODE_H) / 2,
        d: `M${b.x + b.w} ${b.y + b.h / 2}H316V${a.y + a.h / 2}H${a.x + a.w}`,
        tone,
      }
  return { id: layoutId, w, h, node, edges, revise }
}

function shorten(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function Diagram({ layout, uid, nodes, now, label }: {
  layout: DynamicLayout
  uid: string
  nodes: NodeView[]
  now: number
  label: string
}) {
  const { revise, edges } = layout
  return (
    <svg className={`rd-svg rd-${layout.id}`} style={layout.id === 'wide' ? { minWidth: layout.w } : undefined} viewBox={`0 0 ${layout.w} ${layout.h}`} role="img" aria-label={label}>
      <defs>
        {(['idle', 'info', 'ok', 'warn', 'err'] as Tone[]).map(tone => (
          <marker key={tone} id={`${uid}-${layout.id}-mk-${tone}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
            <path className={`rd-mk tone-${tone}`} d="M0 1.5 9 5 0 8.5z" />
          </marker>
        ))}
      </defs>
      {edges.map(edge => (
        <path key={edge.id} data-from={edge.from} data-to={edge.to}
          className={`rd-edge tone-${edge.tone}${edge.tone === 'info' ? ' flow' : ''}`}
          d={edge.d} markerEnd={`url(#${uid}-${layout.id}-mk-${edge.tone})`} />
      ))}
      <path className={`rd-edge rd-revise tone-${revise.tone}${revise.tone === 'info' ? ' flow' : ''}`}
        data-from="review" data-to="decide" d={revise.d} markerEnd={`url(#${uid}-${layout.id}-mk-${revise.tone})`} />
      <g className={`rd-pill tone-${revise.tone}`} transform={`translate(${revise.x} ${revise.y})`}>
        <rect x="-30" y="-11" width="60" height="22" rx="11" />
        <text textAnchor="middle" y="4">revise</text>
      </g>
      {nodes.map(item => {
        const r = layout.node[item.id]!
        const tone = TONES[item.state]
        const corner = item.state === 'done' ? 'check' : item.state === 'failed' ? 'failed' : item.state === 'blocked' || item.state === 'interrupted' ? 'alert' : ''
        return (
          <g key={item.id} className={`rd-node tone-${tone} ${item.state}`} transform={`translate(${r.x} ${r.y})`}
            data-node={item.name} data-node-id={item.id} data-agent={item.agent} data-role={item.role} data-state={item.state}>
            <title>{`${item.title} (${item.role})${item.agent ? ` · ${item.agent}` : ''}${item.via ? ` · ${item.via}` : ''}${item.note ? `: ${item.note}` : ''}`}</title>
            {item.state === 'active' && <rect className="rd-halo" width={r.w} height={r.h} rx="14" />}
            <rect className="rd-card" width={r.w} height={r.h} rx="14" />
            <rect className="rd-tile" x="14" y="14" width="36" height="36" rx="10" />
            <Icon name={item.role} x={22} y={22} size={20} />
            <text className="rd-title" x="62" y="29">{shorten(item.title, Math.floor((r.w - 94) / 8))}</text>
            <text className="rd-role" x="62" y="46">{item.role}</text>
            {item.state === 'active' && <circle className="rd-live" cx={r.w - 24} cy="24" r="5" />}
            {corner && <g className="rd-corner" transform={`translate(${r.w - 24} 24)`}>
              <circle r="11" /><Icon name={corner} x={-7} y={-7} size={14} />
            </g>}
            <line className="rd-sep" x1="14" x2={r.w - 14} y1="64" y2="64" />
            <text className="rd-agent" x="14" y="84">{shorten(item.agent, Math.floor((r.w - 28) / 8))}</text>
            <text className="rd-via" x="14" y="100">{shorten(item.via, Math.floor((r.w - 78) / 7))}</text>
            <text className="rd-state" x={r.w - 14} y="100" textAnchor="end">
              {item.state === 'active' && item.since !== undefined ? elapsed(now - item.since) : STATE_WORD[item.state]}
            </text>
            {item.retry && <g className="rd-retry" transform={`translate(${r.w - 50} 0)`} data-retry={item.retry.count}>
              <title>{item.retry.message}</title>
              <rect x="-44" y="-10" width="88" height="20" rx="10" />
              <text textAnchor="middle" y="4">↻ retry {item.retry.count}</text>
            </g>}
          </g>
        )
      })}
    </svg>
  )
}

export default function RunDiagram({ run, progress, maxAttempts, roster }: {
  run: Run
  progress: Progress[]
  maxAttempts?: number
  roster?: Roster
}) {
  const uid = useId().replace(/\W/g, '')
  const running = run.status === 'running'
  const [now, setNow] = useState(() => Date.now())

  const cycle = currentCycle(progress, run)
  const makeNode = (name: NodeName, id: string, agent: string, role: Role): NodeView => {
    const events = name === 'decide' ? cycle.routerEvents : cycle.events
    const state = nodeState(events, name, run.status)
    const latest = findLast(events, item => item.node === name)
    const start = findLast(events, item => item.node === name && item.phase === 'start' && retryOf(item) === undefined)
    const retryCount = latest && state === 'active' ? retryOf(latest) : undefined
    const rosterAgent = roster?.agents[agent]
    const harness = (start ? messageAgent(start.message, agent) : '') || rosterAgent?.harness || ''
    const since = start?.at ? Date.parse(start.at) : NaN
    return {
      id, name, role, agent, state,
      title: name === 'decide' ? 'Router' : name === 'review' ? 'Reviewer' : agent,
      via: harness ? `via ${harness}` : name === 'decide' && state === 'active' ? 'routing…' : '',
      since: state === 'active' && Number.isFinite(since) ? since : undefined,
      note: latest?.message,
      retry: retryCount === undefined ? undefined : { count: retryCount, message: latest!.message },
    }
  }
  const router = roster?.router
  const routerAgent = router === 'rule' ? 'rule-based router' : router === 'jev' ? 'Jev typed router' : router?.agent ?? 'router'
  const reviewerStart = findLast(cycle.events, item => item.node === 'review' && item.phase === 'start' && retryOf(item) === undefined)
  const reviewerAgent = reviewerStart ? parseAgentsFromMessage(reviewerStart.message).agents[0] ?? 'reviewer' : roster?.reviewer?.agent ?? 'reviewer'
  const routerNode = makeNode('decide', 'decide', routerAgent, 'router')
  if (router && typeof router === 'object' && !routerNode.via) routerNode.via = `via ${router.harness}`
  const reviewerNode = makeNode('review', 'review', reviewerAgent, 'reviewer')
  if (roster?.reviewer?.agent === reviewerAgent && !reviewerNode.via) reviewerNode.via = `via ${roster.reviewer.harness}`
  const groups: NodeView[][] = [[routerNode]]
  if (cycle.events.some(item => item.node === 'orchestrate')) {
    const start = findLast(cycle.events, item => item.node === 'orchestrate' && item.phase === 'start')
    groups.push([makeNode('orchestrate', 'orchestrate', start ? parseAgentsFromMessage(start.message).agents[0] ?? 'orchestrator' : 'orchestrator', 'orchestrator')])
  }
  for (const stage of STAGES) {
    const decision = cycle.decision
    const tasks = decision?.action === 'dispatch'
      ? decision.stages.filter(item => item.stage === stage).flatMap(item => item.tasks)
      : decision?.action === 'work' && stage === 'work' ? [{ agent: decision.agent, role: 'worker' as const }] : undefined
    // Older histories have no decisions; only real stage starts can identify
    // spawned agents. Never fill gaps from the configured agent roster.
    const selected = tasks ?? cycle.events
      .filter(item => item.node === stage && item.phase === 'start' && retryOf(item) === undefined)
      .flatMap(item => parseAgentsFromMessage(item.message).agents)
      .filter((agent, index, agents) => agents.indexOf(agent) === index)
      .map(agent => ({ agent, role: undefined }))
    if (selected.length > 0) {
      groups.push(selected.map((task, index) => makeNode(
        stage, `${stage}:${index}:${task.agent}`, task.agent,
        task.role ?? roster?.agents[task.agent]?.role ?? ROLES[stage],
      )))
    }
  }
  const reviewNodes = [reviewerNode]
  const securityStart = findLast(cycle.events, item => item.node === 'security-review' && item.phase === 'start')
  if (securityStart) reviewNodes.push(makeNode('security-review', 'security-review', parseAgentsFromMessage(securityStart.message).agents[0] ?? 'security-reviewer', 'security-reviewer'))
  groups.push(reviewNodes)
  const nodes = groups.flat()
  const active = nodes.some(item => item.state === 'active')
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  const label = [
    ...nodes.map(item => `${item.title} (${item.role}, ${item.agent}) ${STATE_WORD[item.state]}${item.via ? ` ${item.via}` : ''}${item.retry ? `, retry ${item.retry.count}` : ''}`),
    running ? 'run in progress' : `run ${run.status}`,
    cycle.attempt > 0 ? `attempt ${cycle.attempt}${maxAttempts ? ` of ${maxAttempts}` : ''}` : 'no attempts yet',
  ].join('; ')
  const common = { uid, nodes, now, label }
  return (
    <div className="run-diagram" data-run-status={run.status} data-attempt={cycle.attempt} data-columns={groups.length}>
      <div className="rd-meta">
        <span className="rd-attempt">Attempt <strong>{cycle.attempt}</strong>{running && maxAttempts ? <span className="muted"> / {maxAttempts}</span> : null}</span>
        <span className="muted small-text">Router → selected agents → Reviewer</span>
      </div>
      <Diagram layout={computeLayout('wide', groups, cycle.looped)} {...common} />
      <Diagram layout={computeLayout('tall', groups, cycle.looped)} {...common} />
    </div>
  )
}
