// module 8.3  frontend/panels/Connections.tsx -- one row per open socket, live

import type { ReactElement } from 'react'

import type { ConnectionRow, MetricsSnapshot } from '../useMetricsStream'
import { Panel } from './Panel'

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function bytes(count: number): string {
  return count < 1024 ? `${count} B` : `${(count / 1024).toFixed(1)} KB`
}

const HEADINGS = ['id', 'requests', 'idle', 'age', 'read', 'written'] as const

function Row({ connection }: { connection: ConnectionRow }): ReactElement {
  return (
    <tr className="border-t border-line">
      <td className="py-1 text-dim">{connection.id}</td>
      <td className="py-1 text-right">{connection.requestsServed}</td>
      <td className="py-1 text-right">{duration(connection.idleMs)}</td>
      <td className="py-1 text-right">{duration(connection.ageMs)}</td>
      <td className="py-1 text-right text-dim">{bytes(connection.bytesRead)}</td>
      <td className="py-1 text-right text-dim">{bytes(connection.bytesWritten)}</td>
    </tr>
  )
}

export function Connections({ snapshot }: { snapshot: MetricsSnapshot | null }): ReactElement {
  // Ascending by id, so a socket keeps its place in the table for as long as it is open.
  // The server reports them in whatever order the connection map holds them, and a row that
  // jumped every half-second would be unreadable exactly when it is worth reading.
  const rows =
    snapshot === null ? [] : [...snapshot.connections.rows].sort((a, b) => a.id - b.id)

  return (
    <Panel
      title="connections"
      hint="one row per open socket. a keep-alive client serves every request down the same one, so the request count climbs while the table stays a single line."
    >
      <table className="w-full border-collapse tabular-nums">
        <thead>
          <tr className="text-xs text-dim">
            {HEADINGS.map((heading) => (
              <th
                key={heading}
                className={`pb-2 font-normal ${heading === 'id' ? 'text-left' : 'text-right'}`}
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="border-t border-line">
              <td className="py-1 text-dim" colSpan={HEADINGS.length}>
                {snapshot === null ? 'waiting for the stream' : 'no open connections'}
              </td>
            </tr>
          ) : (
            rows.map((connection) => <Row key={connection.id} connection={connection} />)
          )}
        </tbody>
      </table>
    </Panel>
  )
}
