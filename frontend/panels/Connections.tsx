// module 8.3  frontend/panels/Connections.tsx -- one row per open socket, live

import type { ReactElement } from 'react'

import type { ConnectionRow, MetricsSnapshot } from '../useMetricsStream'
import { Panel } from './Panel'

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

// Megabytes matter: the dashboard's own SSE stream is a connection that never closes, so its
// written total passes a megabyte within the hour and reads as a five-digit KB figure that is
// both unreadable and wide enough to blow out the column.
function bytes(count: number): string {
  if (count < 1024) return `${count} B`
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`
  return `${(count / (1024 * 1024)).toFixed(1)} MB`
}

/** `in` and `out` are the socket's own directions; `read` and `written` read as the server's. */
const HEADINGS = ['id', 'req', 'idle', 'age', 'in', 'out'] as const

function Row({ connection }: { connection: ConnectionRow }): ReactElement {
  return (
    <tr className="border-t border-line transition-colors hover:bg-raise">
      <td className="py-1.5 pr-2 text-faint">#{connection.id}</td>
      <td className="py-1.5 pr-2 text-right">{connection.requestsServed}</td>
      <td className="py-1.5 pr-2 text-right text-dim">{duration(connection.idleMs)}</td>
      <td className="py-1.5 pr-2 text-right text-dim">{duration(connection.ageMs)}</td>
      <td className="py-1.5 pr-2 text-right text-dim">{bytes(connection.bytesRead)}</td>
      <td className="py-1.5 text-right text-dim">{bytes(connection.bytesWritten)}</td>
    </tr>
  )
}

export function Connections({ snapshot }: { snapshot: MetricsSnapshot | null }): ReactElement {
  // Ascending by id, so a socket keeps its place in the table for as long as it is open.
  // The server reports them in whatever order the connection map holds them, and a row that
  // jumped every half-second would be unreadable exactly when it is worth reading.
  const rows = snapshot === null ? [] : [...snapshot.connections.rows].sort((a, b) => a.id - b.id)

  return (
    <Panel
      title="connections"
      hint="one row per open socket. a keep-alive client serves every request down the same one."
      action={<span className="shrink-0 text-xs text-dim tabular-nums">{rows.length} open</span>}
    >
      {/* Capped to the height of the chart beside it, so a burst that opens thirty sockets
          scrolls here instead of growing the row and pushing the inspector off the screen.
          This table is the one thing on the page whose length the server decides. */}
      <div className="max-h-36 overflow-y-auto">
        <table className="w-full border-collapse text-xs tabular-nums">
          <thead>
            <tr className="text-dim">
              {HEADINGS.map((heading) => (
                <th
                  key={heading}
                  scope="col"
                  className={`sticky top-0 bg-panel pb-2 font-normal ${
                    heading === 'id' ? 'text-left' : 'pr-2 text-right last:pr-0'
                  }`}
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr className="border-t border-line">
                <td className="py-2 text-faint" colSpan={HEADINGS.length}>
                  {snapshot === null ? 'waiting for the stream' : 'no open connections'}
                </td>
              </tr>
            ) : (
              rows.map((connection) => <Row key={connection.id} connection={connection} />)
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
