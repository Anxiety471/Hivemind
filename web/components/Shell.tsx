'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, errorMessage } from '@/lib/api'
import ProjectSwitcher from './ProjectSwitcher'

type Health = 'checking' | 'up' | 'down'

export default function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const [health, setHealth] = useState<Health>('checking')
  const [detail, setDetail] = useState('')
  const [configPath, setConfigPath] = useState('')
  const [project, setProject] = useState('')
  const [recent, setRecent] = useState<string[]>([])
  const [open, setOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [config, projects] = await Promise.all([api.getConfig(), api.getProjects()])
      setConfigPath(config.path)
      setProject(projects.current)
      setRecent(projects.recent)
      setHealth('up')
      setDetail('')
    } catch (error) {
      setHealth('down')
      setDetail(errorMessage(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      api.health().then(
        () => setHealth(previous => {
          if (previous === 'down') void refresh()
          return 'up'
        }),
        error => { setHealth('down'); setDetail(errorMessage(error)) })
    }, 5000)
    return () => clearInterval(timer)
  }, [refresh])

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="logo" aria-hidden>⬡</span> Hivemind</div>
        <nav>
          <Link href="/" className={pathname === '/' ? 'active' : undefined}>Console</Link>
          <Link href="/settings" className={pathname.startsWith('/settings') ? 'active' : undefined}>Settings</Link>
        </nav>
        <div className="project-info">
          <div className="project-line" title={project}>
            <span className="label">Project</span>
            <code>{project || '…'}</code>
            <button type="button" className="ghost small" disabled={health === 'down'} onClick={() => setOpen(value => !value)}>
              {open ? 'Close' : 'Change'}
            </button>
          </div>
          <div className="project-line" title={configPath}>
            <span className="label">Config</span>
            <code>{configPath || '…'}</code>
          </div>
        </div>
      </header>
      {open && (
        <ProjectSwitcher
          current={project}
          recent={recent}
          onSwitched={projects => { setProject(projects.current); setRecent(projects.recent); setOpen(false) }}
        />
      )}
      {health === 'down' && (
        <div className="banner error" role="alert">
          <strong>API unreachable.</strong> Start the Hivemind server (<code>bun run dev</code>) — retrying every few seconds.
          {detail && <div className="muted">{detail}</div>}
          <button type="button" className="small" onClick={() => void refresh()}>Retry now</button>
        </div>
      )}
      <main className="content">{children}</main>
    </div>
  )
}
