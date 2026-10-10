'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, errorMessage } from '@/lib/api'
import type { ConfigResponse, Progress, Role, Run } from '@/lib/types'
import RunDiagram, { NODES, nodeState, retryOf, type Roster } from './RunDiagram'
import StatusBadge from './StatusBadge'


function rosterOf(config: ConfigResponse['config']): Roster {
  const agent = (id: string) => {
    const found = config.agents.find(item => item.id === id)
    return found ? { agent: found.id, harness: found.harness } : undefined
  }
  const byRole = (role: Role) => {
    const found = config.agents.find(item => item.role === role)
    return found ? { agent: found.id, harness: found.harness } : undefined
  }
  return {
    router: config.router.type === 'rule' ? 'rule' : agent(config.router.agent),
    reviewer: byRole('reviewer'),
    agents: Object.fromEntries(config.agents.map(item => [
      item.id, { agent: item.id, harness: item.harness, role: item.role },
    ])),
  }
}

function duration(run: Run): string {
  if (!run.endedAt) return ''
  const seconds = Math.max(0, (Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000)
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

export default function RunView({ runId, onChange, onSelect }: { runId: string; onChange: () => void; onSelect?: (id: string) => void }) {
  const [run, setRun] = useState<Run | null>(null)
  const [progress, setProgress] = useState<Progress[]>([])
  const [error, setError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [config, setConfig] = useState<ConfigResponse['config'] | null>(null)
  const changed = useRef(onChange)
  const logEnd = useRef<HTMLLIElement>(null)
  useEffect(() => { changed.current = onChange }, [onChange])
  useEffect(() => { api.getConfig().then(response => setConfig(response.config), () => undefined) }, [])

  useEffect(() => {
    let closed = false
    let source: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    setRun(null)
    setProgress([])
    setError('')

    const connect = async () => {
      try {
        const loaded = await api.getRun(runId)
        if (closed) return
        setRun(loaded)
        setError('')
        if (loaded.status !== 'running') {
          setProgress(loaded.progress)
          return
        }
        const stream = new EventSource(api.eventsUrl(runId))
        source = stream
        // The server replays every stored item on (re)connect, so start from scratch each time.
        stream.onopen = () => setProgress([])
        stream.addEventListener('progress', event => setProgress(items => [...items, JSON.parse((event as MessageEvent<string>).data) as Progress]))
        stream.addEventListener('done', event => {
          stream.close()
          const final = JSON.parse((event as MessageEvent<string>).data) as Run
          setRun(final)
          setProgress(final.progress)
          changed.current()
        })
        stream.onerror = () => {
          stream.close()
          if (!closed) retry = setTimeout(() => void connect(), 1500)
        }
      } catch (caught) {
        if (closed) return
        setError(errorMessage(caught))
        if (!(caught instanceof ApiError && caught.status === 404)) retry = setTimeout(() => void connect(), 3000)
      }
    }
    void connect()
    return () => { closed = true; source?.close(); clearTimeout(retry) }
  }, [runId])

  useEffect(() => { logEnd.current?.scrollIntoView({ block: 'nearest' }) }, [progress.length])

  const running = run?.status === 'running'
  const attempts = useMemo(() => {
    const core = progress.filter(item => retryOf(item) === undefined)
    const numbers = [...new Set(core.map(item => item.attempt))].sort((a, b) => a - b)
    return numbers.map(attempt => ({ attempt, items: core.filter(item => item.attempt === attempt) }))
  }, [progress])
  const roster = useMemo(() => config ? rosterOf(config) : undefined, [config])
  const latestArtifact = useMemo(() => [...progress].reverse().find(item => item.artifact)?.artifact, [progress])
  const artifact = run?.result?.artifact || latestArtifact
  const maxAttempt = attempts.at(-1)?.attempt ?? 0

  async function cancel() {
    setCancelling(true)
    try {
      setRun(await api.cancelRun(runId))
      changed.current()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setCancelling(false)
    }
  }

  async function retry() {
    if (!run) return
    setRetrying(true)
    try {
      const next = await api.startRun(run.task)
      onSelect?.(next.id)
      changed.current()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setRetrying(false)
    }
  }

  if (!run) return error ? <p className="field-error" role="alert">{error}</p> : <p className="muted">Loading run…</p>

  return (
    <div className="run-view">
      <div className="run-head">
        <div>
          <h2>Run <code>{run.id.slice(0, 8)}</code></h2>
          <p className="task">{run.task}</p>
          <p className="muted small-text">
            {new Date(run.startedAt).toLocaleString()} · <code>{run.project}</code>{duration(run) && ` · ${duration(run)}`}
          </p>
        </div>
        <div className="run-actions">
          <StatusBadge status={run.status} />
          {running && <button type="button" className="danger" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? 'Cancelling…' : 'Cancel'}</button>}
          {!running && run.status !== 'completed' && <button type="button" className="ghost" disabled={retrying} onClick={() => void retry()}>{retrying ? 'Starting…' : 'Retry run'}</button>}
        </div>
      </div>

      {error && <p className="field-error" role="alert">{error}</p>}
      {run.error && <p className="field-error" role="alert">{run.error}</p>}

      <RunDiagram run={run} progress={progress} maxAttempts={config?.maxAttempts} roster={roster} />

      {attempts.length > 0 && (
        <div className="attempts">
          {attempts.map(({ attempt, items }) => (
            <div key={attempt} className="attempt-row">
              <span className="attempt-label">#{attempt}</span>
              {NODES.map(node => {
                const state = nodeState(items, node, attempt === maxAttempt ? run.status : 'completed')
                return state === 'idle' ? null : <span key={node} className={`chip ${state}`}>{node}</span>
              })}
            </div>
          ))}
        </div>
      )}

      <h3>Event log</h3>
      <ul className="log">
        {progress.length === 0 && <li className="muted">{running ? 'Waiting for the first event…' : 'No events recorded.'}</li>}
        {progress.map((item, index) => (
          <li key={index} className={`log-item ${item.phase}${retryOf(item) === undefined ? '' : ' retry'}`}>
            <span className={`tag ${item.node}`}>{item.node}</span>
            <span className="log-phase">{retryOf(item) === undefined ? item.phase : 'retry'}</span>
            <span className="log-attempt">#{item.attempt}</span>
            <span className="log-message">
              {item.message}
              {item.decision?.action === 'dispatch' && (
                <span className="chip ok" style={{ marginLeft: '8px' }}>
                  Spawned: {item.decision.stages.map(s => `${s.stage} [${s.tasks.map(t => t.agent).join(', ')}]`).join(' → ')}
                </span>
              )}
              {item.decision?.action === 'work' && (
                <span className="chip ok" style={{ marginLeft: '8px' }}>
                  Spawned: worker ({item.decision.agent})
                </span>
              )}
            </span>
            {item.status && item.status !== 'running' && <StatusBadge status={item.status} />}
          </li>
        ))}
        <li ref={logEnd} aria-hidden />
      </ul>

      {run.result && (run.result.feedback || run.result.decision) && (
        <div className="notes">
          {run.result.feedback && <p><span className="label">Reviewer feedback</span> {run.result.feedback}</p>}
          {run.result.decision && (
            <p>
              <span className="label">Final decision</span> {run.result.decision.action}
              {run.result.decision.action === 'dispatch' && ` (${run.result.decision.stages.map(s => `${s.stage} [${s.tasks.map(t => t.agent).join(', ')}]`).join(' → ')})`} — {run.result.decision.reason}
            </p>
          )}
        </div>
      )}

      <h3>Artifact</h3>
      {artifact ? <pre className="artifact" data-testid="artifact">{artifact}</pre> : <p className="muted">No artifact yet.</p>}
    </div>
  )
}
