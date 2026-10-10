'use client'

import { useState } from 'react'
import type { HarnessConfig } from '@/lib/types'

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

export default function HarnessCard({ id, settings, usedBy, onChange, onRemove }: {
  id: string
  settings: HarnessConfig
  usedBy: string[]
  onChange: (settings: HarnessConfig) => void
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const fields = keyFields(settings)

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
    <div className="harness card inner" data-harness={id}>
      <div className="row between">
        <div className="row"><strong>{id}</strong><span className="tag type">{settings.type}</span></div>
        <div className="row">
          <button type="button" className="ghost small" onClick={toggle}>{editing ? 'Close JSON' : 'Edit JSON'}</button>
          <button type="button" className="ghost small danger-text" onClick={onRemove}>Remove</button>
        </div>
      </div>
      {fields.length === 0
        ? <p className="muted small-text">No settings.</p>
        : <dl className="fields">{fields.map(([key, value]) => <div key={key}><dt>{key}</dt><dd><code>{value}</code></dd></div>)}</dl>}
      {usedBy.length > 0 && <p className="muted small-text">Used by {usedBy.join(', ')}</p>}
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
