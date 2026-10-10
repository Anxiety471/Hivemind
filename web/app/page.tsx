'use client'

import { useCallback, useEffect, useState } from 'react'
import RunView from '@/components/RunView'
import StatusBadge from '@/components/StatusBadge'
import { api, errorMessage } from '@/lib/api'
import type { Run } from '@/lib/types'

export default function ConsolePage() {
  const [task, setTask] = useState('')
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try { setRuns(await api.listRuns()) } catch { /* the shell reports connectivity */ }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [refresh])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!task.trim()) return
    setSubmitting(true)
    setError('')
    try {
      const run = await api.startRun(task.trim())
      setSelected(run.id)
      setTask('')
      void refresh()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="console">
      <section className="primary">
        <form className="card composer" onSubmit={event => void submit(event)}>
          <label htmlFor="task"><h2>New task</h2></label>
          <textarea
            id="task"
            value={task}
            rows={4}
            placeholder="Describe what the hive should produce…"
            onChange={event => setTask(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit() }}
          />
          <div className="row end">
            <span className="muted small-text">Ctrl/⌘ + Enter to run</span>
            <button type="submit" disabled={submitting || !task.trim()}>{submitting ? 'Starting…' : 'Run task'}</button>
          </div>
          {error && <p className="field-error" role="alert">{error}</p>}
        </form>

        <div className="card">
          {selected ? <RunView key={selected} runId={selected} onChange={() => void refresh()} onSelect={setSelected} />
            : <p className="muted">Submit a task or pick a run from the history to see the decide → work → review loop.</p>}
        </div>
      </section>

      <aside className="card history">
        <div className="row between"><h2>Runs</h2><button type="button" className="ghost small" onClick={() => void refresh()}>Refresh</button></div>
        {runs === null && <p className="muted">Loading…</p>}
        {runs?.length === 0 && <p className="muted">No runs yet.</p>}
        <ul className="list runs">
          {runs?.map(run => (
            <li key={run.id}>
              <button type="button" className={`run-item ${run.id === selected ? 'selected' : ''}`} onClick={() => setSelected(run.id)}>
                <span className="run-item-top"><StatusBadge status={run.status} /><time className="muted small-text">{new Date(run.startedAt).toLocaleTimeString()}</time></span>
                <span className="run-item-task">{run.task}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  )
}
