'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import type { AgentConfig, Config, HarnessConfig, Role } from '@/lib/types'
import ModelSelect from './ModelSelect'
import { ROLE_HELP } from './RoleGuide'

const ROLES: Role[] = ['worker', 'reviewer', 'router', 'planner', 'designer', 'researcher']

/** Only opencode and pi take a per-agent model; other harness types ignore it. */
const takesModel = (harness: HarnessConfig | undefined) => harness?.type === 'opencode' || harness?.type === 'pi'

export default function AgentsTable({ agents, harnesses, savedHarnesses, onUpdate, onRemove }: {
  agents: AgentConfig[]
  harnesses: Config['harnesses']
  /** Harnesses as last saved: the API can only list models for harnesses it knows about. */
  savedHarnesses: Config['harnesses']
  onUpdate: (index: number, patch: Partial<AgentConfig>) => void
  onRemove: (index: number) => void
}) {
  const harnessIds = Object.keys(harnesses)
  const [models, setModels] = useState<Record<string, string[]>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const inflight = useRef(new Set<string>())

  // Fetch suggestions lazily per harness id; an empty or failed list is re-fetched when the picker opens.
  const wanted = [...new Set(agents.map(agent => agent.harness))].filter(id =>
    takesModel(harnesses[id]) && harnesses[id]?.type === savedHarnesses[id]?.type)
  const wantedKey = wanted.join('\n')
  const load = useCallback((id: string) => {
    if (inflight.current.has(id)) return
    inflight.current.add(id)
    setModels(current => { const { [id]: _drop, ...rest } = current; return rest })
    api.getHarnessModels(id).then(
      response => {
        setModels(current => ({ ...current, [id]: response.models }))
        setErrors(current => ({ ...current, [id]: response.error ?? '' }))
      },
      caught => {
        setModels(current => ({ ...current, [id]: [] }))
        setErrors(current => ({ ...current, [id]: errorMessage(caught) }))
      },
    ).finally(() => inflight.current.delete(id))
  }, [])
  useEffect(() => {
    for (const id of wantedKey ? wantedKey.split('\n') : []) if (!(id in models)) load(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, load])

  return (
    <div className="table-wrap">
      <table className="agents">
        <thead><tr><th>Name</th><th>Role</th><th>Harness</th><th>Model</th><th>Description</th><th /></tr></thead>
        <tbody>
          {agents.map((agent, index) => {
            const harness = harnesses[agent.harness]
            const suggestions = models[agent.harness] ?? []
            const editable = takesModel(harness) || !!agent.model
            const placeholder = !editable ? 'n/a' : (harness && 'model' in harness ? harness.model : undefined) || 'harness default'
            const loading = wanted.includes(agent.harness) && !(agent.harness in models)
            return (
              <tr key={index}>
                <td><input value={agent.id} aria-label={`Agent ${index + 1} name`} spellCheck={false} onChange={event => onUpdate(index, { id: event.target.value })} /></td>
                <td>
                  <select value={agent.role} aria-label={`Agent ${index + 1} role`} title={ROLE_HELP[agent.role]} onChange={event => onUpdate(index, { role: event.target.value as Role })}>
                    {ROLES.map(role => <option key={role} value={role} title={ROLE_HELP[role]}>{role}</option>)}
                  </select>
                </td>
                <td>
                  <select value={agent.harness} aria-label={`Agent ${index + 1} harness`} onChange={event => onUpdate(index, { harness: event.target.value })}>
                    {!harnessIds.includes(agent.harness) && <option value={agent.harness}>{agent.harness || '— select —'}</option>}
                    {harnessIds.map(id => <option key={id} value={id}>{id} · {harnesses[id]?.type}</option>)}
                  </select>
                </td>
                <td>
                  <ModelSelect
                    value={agent.model || undefined}
                    models={suggestions}
                    loading={loading}
                    placeholder={placeholder}
                    disabled={!editable}
                    title="This harness type has no per-agent model"
                    label={`Agent ${index + 1} model`}
                    onChange={model => onUpdate(index, { model })}
                    error={errors[agent.harness] || undefined}
                    onRetry={() => load(agent.harness)}
                  />
                </td>
                <td><input value={agent.description} aria-label={`Agent ${index + 1} description`} onChange={event => onUpdate(index, { description: event.target.value })} /></td>
                <td><button type="button" className="ghost small danger-text" onClick={() => onRemove(index)}>Remove</button></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
