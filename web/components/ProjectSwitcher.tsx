'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import type { DirectoriesResponse, ProjectsResponse } from '@/lib/types'

function join(dir: string, name: string): string {
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) return name
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}

function baseName(entry: string): string {
  const parts = entry.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? entry
}

export default function ProjectSwitcher({ current, recent, onSwitched }: {
  current: string
  recent: string[]
  onSwitched: (projects: ProjectsResponse) => void
}) {
  const [typed, setTyped] = useState(current)
  const [listing, setListing] = useState<DirectoriesResponse | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const browse = useCallback(async (path?: string) => {
    try {
      const next = await api.listDirectories(path)
      setListing(next)
      setTyped(next.path)
      setError('')
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [])

  useEffect(() => { void browse(current || undefined) }, [browse, current])

  async function choose(path: string) {
    if (!path.trim()) return
    setBusy(true)
    try {
      onSwitched(await api.setProject(path.trim()))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="switcher card">
      <div className="switcher-grid">
        <div>
          <h3>Recent projects</h3>
          {recent.length === 0 && <p className="muted">None yet.</p>}
          <ul className="list">
            {recent.map(path => (
              <li key={path}>
                <button type="button" className={`link ${path === current ? 'current' : ''}`} disabled={busy} onClick={() => void choose(path)} title={path}>
                  {path}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Browse folders</h3>
          <form className="row" onSubmit={event => { event.preventDefault(); void browse(typed.trim() || undefined) }}>
            <input value={typed} onChange={event => setTyped(event.target.value)} placeholder="/absolute/path or ~/path" aria-label="Project path" spellCheck={false} />
            <button type="submit" className="ghost">Go</button>
            <button type="button" disabled={busy || !typed.trim()} onClick={() => void choose(typed)}>Use this folder</button>
          </form>
          {listing && (
            <ul className="list folders">
              {listing.parent !== null && (
                <li><button type="button" className="link" onClick={() => void browse(listing.parent ?? undefined)}>↑ ..</button></li>
              )}
              {listing.directories.map(entry => {
                const full = join(listing.path, entry)
                return <li key={full}><button type="button" className="link" onClick={() => void browse(full)}>📁 {baseName(entry)}</button></li>
              })}
              {listing.directories.length === 0 && <li className="muted">No subfolders.</li>}
            </ul>
          )}
        </div>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
    </section>
  )
}
