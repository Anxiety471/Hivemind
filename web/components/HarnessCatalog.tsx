'use client'

import { useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import type { HarnessCatalogEntry, HarnessCatalogResponse } from '@/lib/types'

type InstallState = { running: boolean; ok?: boolean; text?: string }

export default function HarnessCatalog({ catalog, loading, error, configured, onRefresh, onInstalled, onAdd }: {
  catalog: HarnessCatalogResponse | null
  loading: boolean
  error: string
  /** Ids of configured harnesses, per catalog type. */
  configured: Record<string, string[]>
  onRefresh: () => void
  onInstalled: (entry: HarnessCatalogEntry) => void
  onAdd: (type: HarnessCatalogEntry['type']) => void
}) {
  const [installs, setInstalls] = useState<Record<string, InstallState>>({})

  async function install(entry: HarnessCatalogEntry) {
    setInstalls(current => ({ ...current, [entry.type]: { running: true } }))
    try {
      const result = await api.installHarness(entry.type)
      onInstalled(result.entry)
      setInstalls(current => ({ ...current, [entry.type]: { running: false, ok: result.entry.installed, text: result.output.trim() || (result.entry.installed ? 'Installed.' : 'Installer finished, but the executable was not found on PATH.') } }))
      onRefresh()
    } catch (caught) {
      setInstalls(current => ({ ...current, [entry.type]: { running: false, ok: false, text: errorMessage(caught) } }))
    }
  }

  const anyInstalling = Object.values(installs).some(state => state.running)
  const installer = catalog?.installer ?? null

  return (
    <div className="catalog" data-testid="harness-catalog">
      <div className="row between wrap">
        <div>
          <h3 className="catalog-title">Detected harnesses</h3>
          <p className="muted small-text">
            {catalog
              ? installer ? <>Installs run with <code>{installer}</code>.</> : <>Neither <code>bun</code> nor <code>npm</code> was found on PATH, so harnesses cannot be installed from here.</>
              : 'Looking for harness CLIs on PATH…'}
          </p>
        </div>
        <button type="button" className="ghost small" onClick={onRefresh} disabled={loading || anyInstalling}>
          {loading && <span className="spinner" aria-hidden="true" />}{loading ? 'Detecting…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="notice err" role="alert">
          <span>{error}</span>
          <button type="button" className="ghost small" onClick={onRefresh} disabled={loading}>Retry</button>
        </div>
      )}

      {!catalog && !error && <p className="muted small-text">Detecting…</p>}

      {catalog && (
        <div className="catalog-grid">
          {catalog.harnesses.map(entry => {
            const state = installs[entry.type]
            const ids = configured[entry.type] ?? []
            const installDisabled = state?.running || !entry.installable
            return (
              <div key={entry.type} className={`catalog-card ${entry.installed ? 'installed' : 'missing'}`} data-catalog={entry.type}>
                <div className="row between">
                  <strong>{entry.name}</strong>
                  <span className={`badge ${entry.installed ? 'completed' : 'blocked'}`}>{entry.installed ? 'Installed' : 'Not installed'}</span>
                </div>
                <p className="muted small-text">{entry.description}</p>
                <dl className="fields">
                  <div><dt>executable</dt><dd><code>{entry.executable}</code></dd></div>
                  {entry.installed && entry.version && <div><dt>version</dt><dd><code>{entry.version}</code></dd></div>}
                  {entry.installed && entry.path && <div><dt>path</dt><dd><code>{entry.path}</code></dd></div>}
                  {!entry.installed && <div><dt>install</dt><dd><code>{entry.installCommand}</code></dd></div>}
                </dl>
                <div className="row wrap catalog-actions">
                  {entry.installed ? (
                    <button type="button" className="small" onClick={() => onAdd(entry.type)}>Add to config</button>
                  ) : (
                    <button
                      type="button"
                      className="small"
                      disabled={installDisabled}
                      title={entry.installable ? entry.installCommand : 'Neither bun nor npm was found on PATH'}
                      onClick={() => void install(entry)}
                    >
                      {state?.running && <span className="spinner" aria-hidden="true" />}{state?.running ? 'Installing…' : 'Install'}
                    </button>
                  )}
                  {ids.length > 0 && <span className="muted small-text">Configured as {ids.join(', ')}</span>}
                </div>
                {state?.running && <p className="muted small-text" role="status">Running <code>{entry.installCommand}</code> — this can take a few minutes.</p>}
                {state?.text && !state.running && (
                  <pre className={`install-output ${state.ok ? '' : 'failed'}`} role={state.ok ? 'status' : 'alert'}>{state.text}</pre>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
