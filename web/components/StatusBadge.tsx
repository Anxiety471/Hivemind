import type { RunPhaseStatus } from '@/lib/types'

export default function StatusBadge({ status }: { status: RunPhaseStatus }) {
  return <span className={`badge ${status}`}>{status === 'running' && <span className="pulse" aria-hidden />}{status}</span>
}
