// module 8.2  frontend/panels/StatRow.tsx -- the four numbers, straight off the stream

import type { ReactElement } from 'react'

import type { MetricsSnapshot } from '../useMetricsStream'

/** Shown in place of a number before the first snapshot arrives. */
const PENDING = '--'

interface StatProps {
  readonly label: string
  readonly value: string
  readonly note: string
}

function Stat({ label, value, note }: StatProps): ReactElement {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className="stat-note">{note}</span>
    </div>
  )
}

function statusClass(code: string): string {
  return `code code-${code.charAt(0)}xx`
}

export function StatRow({ snapshot }: { snapshot: MetricsSnapshot | null }): ReactElement {
  const codes = snapshot === null ? [] : Object.entries(snapshot.statusCounts)

  return (
    <section className="panel">
      <h2 className="panel-title">live</h2>

      <div className="stats">
        <Stat
          label="open connections"
          value={snapshot === null ? PENDING : String(snapshot.connections.open)}
          note={snapshot === null ? '' : `${snapshot.connections.accepted} accepted`}
        />
        <Stat
          label="requests/sec"
          value={snapshot === null ? PENDING : snapshot.requests.perSecond.toFixed(1)}
          note="5s rolling"
        />
        <Stat
          label="keep-alive reuse"
          value={
            snapshot === null ? PENDING : `${Math.round(snapshot.requests.keepAliveReuse * 100)}%`
          }
          note={snapshot === null ? '' : `${snapshot.requests.total} served`}
        />

        <div className="stat">
          <span className="stat-label">status codes</span>
          <span className="codes">
            {codes.length === 0
              ? PENDING
              : codes.map(([code, count]) => (
                  <span key={code} className={statusClass(code)}>
                    {code}
                    <span className="code-count">{count}</span>
                  </span>
                ))}
          </span>
          <span className="stat-note">{snapshot === null ? '' : 'since boot'}</span>
        </div>
      </div>
    </section>
  )
}
