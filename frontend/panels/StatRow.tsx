// module 8.2  frontend/panels/StatRow.tsx -- the four headline numbers, straight off the stream

import type { ReactElement, ReactNode } from 'react'

import type { MetricsSnapshot } from '../useMetricsStream'

/** Shown in place of a number before the first snapshot arrives. */
const PENDING = '--'

interface StatProps {
  readonly label: string
  readonly value: string
  readonly note: ReactNode
  /** 0 to 1. Draws a bar under the value, for a figure that is a proportion of something. */
  readonly ratio?: number
}

function Stat({ label, value, note, ratio }: StatProps): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-line bg-panel px-4 py-3.5">
      <span className="text-xs tracking-[0.14em] text-dim uppercase">{label}</span>
      {/* Tabular figures, so a value going from 9 to 10 does not shift the row it sits in.
          Every number on this page rewrites itself twice a second. */}
      <span className="text-3xl leading-none tracking-tight tabular-nums">{value}</span>
      {ratio === undefined ? null : (
        <span className="mt-0.5 block h-1 overflow-hidden rounded-full bg-line">
          <span
            className="block h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </span>
      )}
      <span className="mt-auto min-h-4 pt-1 text-xs text-dim">{note}</span>
    </div>
  )
}

export function StatRow({ snapshot }: { snapshot: MetricsSnapshot | null }): ReactElement {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Stat
        label="open connections"
        value={snapshot === null ? PENDING : String(snapshot.connections.open)}
        note={
          snapshot === null ? (
            ''
          ) : (
            <>
              {snapshot.connections.accepted} accepted
              {/* Refused only appears once it has happened. A permanent "0 refused" reads as
                  a control that is doing something; the connection cap is not, until it is. */}
              {snapshot.connections.refused === 0 ? null : (
                <span className="text-warn"> / {snapshot.connections.refused} refused</span>
              )}
            </>
          )
        }
      />
      <Stat
        label="requests / sec"
        value={snapshot === null ? PENDING : snapshot.requests.perSecond.toFixed(1)}
        note="5s rolling window"
      />
      <Stat
        label="keep-alive reuse"
        value={
          snapshot === null ? PENDING : `${Math.round(snapshot.requests.keepAliveReuse * 100)}%`
        }
        ratio={snapshot === null ? 0 : snapshot.requests.keepAliveReuse}
        note={
          snapshot === null
            ? ''
            : `${snapshot.requests.total} requests on ${snapshot.connections.accepted} sockets`
        }
      />
      <Stat
        label="requests served"
        value={snapshot === null ? PENDING : String(snapshot.requests.total)}
        note="since boot"
      />
    </div>
  )
}
