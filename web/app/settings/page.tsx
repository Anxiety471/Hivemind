'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import AgentsTable from '@/components/AgentsTable'
import HarnessCard from '@/components/HarnessCard'
import HarnessCatalog from '@/components/HarnessCatalog'
import NumberField from '@/components/NumberField'
import RoleGuide from '@/components/RoleGuide'
import { api, errorMessage } from '@/lib/api'
import type { AgentConfig, Config, ConfigResponse, HarnessCatalogEntry, HarnessCatalogResponse, HarnessConfig } from '@/lib/types'

function nextName(prefix: string, taken: string[]): string {
  let index = taken.length + 1
  while (taken.includes(`${prefix}-${index}`)) index += 1
  return `${prefix}-${index}`
}

export default function SettingsPage() {
  const [loaded, setLoaded] = useState<ConfigResponse | null>(null)
  const [draft, setDraft] = useState<Config | null>(null)
  const [mode, setMode] = useState<'form' | 'raw'>('form')
  const [raw, setRaw] = useState('')
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [catalog, setCatalog] = useState<HarnessCatalogResponse | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')

  const load = useCallback(async () => {
    try {
      const response = await api.getConfig()
      setLoaded(response)
      setDraft(response.config)
      setRaw(JSON.stringify(response.config, null, 2))
      setLoadError('')
    } catch (caught) {
      setLoadError(errorMessage(caught))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true)
    try {
      setCatalog(await api.getHarnessCatalog())
      setCatalogError('')
    } catch (caught) {
      setCatalogError(errorMessage(caught))
    } finally {
      setCatalogLoading(false)
    }
  }, [])

  useEffect(() => { void loadCatalog() }, [loadCatalog])

  const dirty = useMemo(() => {
    if (!loaded || !draft) return false
    return mode === 'raw' ? raw !== JSON.stringify(loaded.config, null, 2) : JSON.stringify(draft) !== JSON.stringify(loaded.config)
  }, [loaded, draft, mode, raw])

  function update(patch: Partial<Config>) {
    setDraft(current => (current ? { ...current, ...patch } : current))
    setSavedAt(null)
  }

  function updateAgent(index: number, patch: Partial<AgentConfig>) {
    if (!draft) return
    update({ agents: draft.agents.map((agent, position) => (position === index ? { ...agent, ...patch } : agent)) })
  }

  function switchMode(next: 'form' | 'raw') {
    if (next === mode || !draft) return
    if (next === 'raw') {
      setRaw(JSON.stringify(draft, null, 2))
    } else {
      try {
        setDraft(JSON.parse(raw) as Config)
      } catch (caught) {
        setSaveError(`Invalid JSON: ${errorMessage(caught)}`)
        return
      }
    }
    setSaveError('')
    setMode(next)
  }

  async function save() {
    if (!draft) return
    let config: Config
    try {
      config = mode === 'raw' ? (JSON.parse(raw) as Config) : draft
    } catch (caught) {
      setSaveError(`Invalid JSON: ${errorMessage(caught)}`)
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      const response = await api.saveConfig(config)
      setLoaded(response)
      setDraft(response.config)
      setRaw(JSON.stringify(response.config, null, 2))
      setSavedAt(Date.now())
    } catch (caught) {
      setSaveError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  if (!draft || !loaded) {
    return loadError
      ? <div className="card"><p className="field-error" role="alert">{loadError}</p><button type="button" onClick={() => void load()}>Retry</button></div>
      : <p className="muted">Loading configuration…</p>
  }

  const harnessIds = Object.keys(draft.harnesses)
  const configured: Record<string, string[]> = {}
  for (const id of harnessIds) (configured[draft.harnesses[id]?.type ?? ''] ??= []).push(id)

  const addDetected = (type: HarnessCatalogEntry['type']) => {
    const id = harnessIds.includes(type) ? nextName(type, harnessIds) : type
    update({ harnesses: { ...draft.harnesses, [id]: { type, executableArgs: [], maxOutputBytes: 8388608 } } })
  }

  const routerAgents = draft.agents.filter(agent => agent.role === 'router')
  const routerAgent = draft.router.type === 'model' ? draft.router.agent : undefined

  return (
    <div className="settings">
      <div className="row between wrap">
        <div>
          <h1>Settings</h1>
          <p className="muted small-text">Editing <code>{loaded.path}</code></p>
        </div>
        <div className="segmented" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'form'} className={mode === 'form' ? 'active' : ''} onClick={() => switchMode('form')}>Form</button>
          <button type="button" role="tab" aria-selected={mode === 'raw'} className={mode === 'raw' ? 'active' : ''} onClick={() => switchMode('raw')}>Raw JSON</button>
        </div>
      </div>

      {mode === 'raw' ? (
        <section className="card stack">
          <p className="muted small-text">The whole config as JSON — use this for harness types the form cannot edit.</p>
          <textarea className="mono raw" rows={28} value={raw} spellCheck={false} aria-label="Raw config JSON" onChange={event => { setRaw(event.target.value); setSavedAt(null) }} />
        </section>
      ) : (
        <>
          <section className="card stack">
            <h2>Loop</h2>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="maxAttempts">Max attempts</label>
                <NumberField id="maxAttempts" value={draft.maxAttempts} min={1} max={100} onChange={maxAttempts => update({ maxAttempts })} />
              </div>
              <div className="field">
                <label htmlFor="timeoutMs">Timeout per step (ms)</label>
                <NumberField id="timeoutMs" value={draft.timeoutMs} min={1} onChange={timeoutMs => update({ timeoutMs })} />
              </div>
              <div className="field">
                <label htmlFor="harnessRetries">Harness retries</label>
                <NumberField id="harnessRetries" value={draft.harnessRetries} min={0} max={10} onChange={harnessRetries => update({ harnessRetries })} />
                <span className="muted small-text">Retries after a harness error or timeout before the run is blocked</span>
              </div>
              <div className="field">
                <label htmlFor="routerType">Router</label>
                <select id="routerType" value={draft.router.type} onChange={event => update({ router: event.target.value === 'model' ? { type: 'model', agent: routerAgents[0]?.id ?? '' } : { type: 'rule' } })}>
                  <option value="rule">rule</option>
                  <option value="model">model</option>
                </select>
              </div>
              {routerAgent !== undefined && (
                <div className="field">
                  <label htmlFor="routerAgent">Router agent</label>
                  <select id="routerAgent" value={routerAgent} onChange={event => update({ router: { type: 'model', agent: event.target.value } })}>
                    {!draft.agents.some(agent => agent.id === routerAgent) && <option value={routerAgent}>{routerAgent || '— select —'}</option>}
                    {draft.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.id} ({agent.role})</option>)}
                  </select>
                </div>
              )}
            </div>
          </section>

          <section className="card stack">
            <div className="row between"><h2>Agents</h2>
              <button type="button" className="ghost small" onClick={() => update({ agents: [...draft.agents, { id: nextName('agent', draft.agents.map(agent => agent.id)), role: 'worker', harness: harnessIds[0] ?? '', description: '' }] })}>+ Add agent</button>
            </div>
            <RoleGuide agents={draft.agents} router={draft.router} />
            <AgentsTable
              agents={draft.agents}
              harnesses={draft.harnesses}
              savedHarnesses={loaded.config.harnesses}
              onUpdate={updateAgent}
              onRemove={index => update({ agents: draft.agents.filter((_, position) => position !== index) })}
            />
          </section>

          <section className="card stack">
            <div className="row between"><h2>Harnesses</h2>
              <button type="button" className="ghost small" onClick={() => update({ harnesses: { ...draft.harnesses, [nextName('harness', harnessIds)]: { type: 'demo' } } })}>+ Add harness</button>
            </div>
            <HarnessCatalog
              catalog={catalog}
              loading={catalogLoading}
              error={catalogError}
              configured={configured}
              onRefresh={() => void loadCatalog()}
              onInstalled={entry => setCatalog(current => current && { ...current, harnesses: current.harnesses.map(existing => existing.type === entry.type ? entry : existing) })}
              onAdd={addDetected}
            />
            <h3 className="section-label">Configured harnesses</h3>
            {harnessIds.length === 0 && <p className="muted">No harnesses configured.</p>}
            <div className="harnesses">
              {harnessIds.map(id => {
                const settings = draft.harnesses[id] as HarnessConfig
                return (
                  <HarnessCard
                    key={id}
                    id={id}
                    settings={settings}
                    usedBy={draft.agents.filter(agent => agent.harness === id).map(agent => agent.id)}
                    catalog={catalog?.harnesses.find(entry => entry.type === settings.type)}
                    onChange={next => update({ harnesses: { ...draft.harnesses, [id]: next } })}
                    onRemove={() => update({ harnesses: Object.fromEntries(Object.entries(draft.harnesses).filter(([key]) => key !== id)) })}
                  />
                )
              })}
            </div>
          </section>
        </>
      )}

      <div className="savebar">
        <div className="savebar-status">
          {saveError && <p className="field-error" role="alert" data-testid="save-error">{saveError}</p>}
          {!saveError && savedAt && !dirty && <p className="ok" role="status">Saved.</p>}
          {!saveError && dirty && <p className="muted">Unsaved changes.</p>}
        </div>
        <button type="button" className="ghost" disabled={!dirty || saving} onClick={() => { setDraft(loaded.config); setRaw(JSON.stringify(loaded.config, null, 2)); setSaveError(''); setSavedAt(null) }}>Discard</button>
        <button type="button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  )
}
