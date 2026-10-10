'use client'

import { useState } from 'react'
import type { HarnessCatalogEntry, HarnessConfig } from '@/lib/types'

function keyFields(settings: HarnessConfig): [string, string][] {
  const pairs: [string, string | number | undefined][] = (() => {
    switch (settings.type) {
      case 'demo': return []
      case 'opencode': return [['executable', settings.executable], ['model', settings.model], ['agent', settings.agent], ['variant', settings.variant], ['cwd', settings.cwd]]
      case 'pi': return [['executable', settings.executable], ['provider', settings.provider], ['model', settings.model], ['thinking', settings.thinking], ['tools', settings.tools?.join(', ')], ['cwd', settings.cwd]]
      case 'command': return [['command', settings.command], ['args', settings.args.join(' ')], ['cwd', settings.cwd]]
      case 'openai-compatible': return [['baseUrl', settings.baseUrl], ['model', settings.model], ['apiKeyEnv', settings.apiKeyEnv], ['maxTokens', settings.maxTokens]]
    }
  })()
  return pairs.filter((pair): pair is [string, string | number] => pair[1] !== undefined && pair[1] !== '').map(([key, value]) => [key, String(value)])
}

export default function HarnessCard({ id, settings, usedBy, catalog, onChange, onRemove }: {
  id: string
  settings: HarnessConfig
  usedBy: string[]
  /** Catalog entry for this harness's type (opencode / pi), when the catalog has loaded. */
  catalog?: HarnessCatalogEntry
  onChange: (settings: HarnessConfig) => void
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const fields = keyFields(settings)
  const executable = settings.type === 'opencode' || settings.type === 'pi' ? settings.executable : undefined
  const customExecutable = !!executable && executable !== catalog?.executable
  const availability = !catalog ? undefined : customExecutable ? { cls: 'custom', label: 'Custom executable', title: `Uses ${executable}; not checked` }
    : catalog.installed ? { cls: 'completed', label: 'Installed', title: [catalog.version, catalog.path].filter(Boolean).join(' · ') || catalog.executable }
      : { cls: 'failed', label: 'Not installed', title: `\`${catalog.executable}\` was not found on PATH` }

  function toggle() {
    if (!editing) { setText(JSON.stringify(settings, null, 2)); setError('') }
    setEditing(value => !value)
  }

  function apply() {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || typeof (parsed as { type?: unknown }).type !== 'string') {
        throw new Error('Harness settings must be an object with a "type"')
      }
      onChange(parsed as HarnessConfig)
      setEditing(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  return (
    <div className={`harness card inner ${availability?.cls === 'failed' ? 'is-missing' : ''}`} data-harness={id}>
      <div className="row between">
        <div className="harness-title"><strong>{id}</strong><span className="tag type">{settings.type}</span></div>
        <div className="row">
          <button type="button" className="ghost small" onClick={toggle}>{editing ? 'Close JSON' : 'Edit JSON'}</button>
          <button type="button" className="ghost small danger-text" onClick={onRemove}>Remove</button>
        </div>
      </div>
      {availability && (
        <div className="row">
          <span className={`badge ${availability.cls}`} title={availability.title}>{availability.label}</span>
          {availability.cls === 'completed' && catalog?.version && <span className="muted small-text">{catalog.version}</span>}
        </div>
      )}
      {fields.length === 0
        ? <p className="muted small-text">No settings.</p>
        : <dl className="fields">{fields.map(([key, value]) => <div key={key}><dt>{key}</dt><dd><code>{value}</code></dd></div>)}</dl>}
      <div className="used-by">
        <span className="label">Used by</span>
        {usedBy.length > 0
          ? usedBy.map(agent => <span key={agent} className="chip">{agent}</span>)
          : <span className="muted small-text">no agents</span>}
      </div>
      {editing && (
        <div className="stack">
          <textarea className="mono" rows={Math.min(18, text.split('\n').length + 1)} value={text} spellCheck={false} onChange={event => setText(event.target.value)} aria-label={`JSON settings for ${id}`} />
          {error && <p className="field-error" role="alert">{error}</p>}
          <div className="row end"><button type="button" onClick={apply}>Apply</button></div>
        </div>
      )}
    </div>
  )
}
