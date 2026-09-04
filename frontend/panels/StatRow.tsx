// module 8.2  frontend/panels/StatRow.tsx -- the four numbers, straight off the stream

import type { ReactElement } from 'react'

import type { MetricsSnapshot } from '../useMetricsStream'

/** Shown in place of a number before the first snapshot arrives. */
const PENDING = '--'

// Literal class names for the same reason as the stream badge in App.tsx: Tailwind never
// sees a name that only exists once the digit is interpolated in.
const CODE_COLOUR: Readonly<Record<string, string>> = {
  '2': 'text-accent',
  '3': 'text-info',
  '4': 'text-warn',
  '5': 'text-bad',
}

function codeColour(code: string): string {
  return CODE_COLOUR[code.charAt(0)] ?? 'text-dim'
}

interface StatProps {
  readonly label: string
  readonly value: string
  readonly note: string
}

function Stat({ label, value, note }: StatProps): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-dim">{label}</span>
      {/* Tabular figures, so a value going from 9 to 10 does not shift the row it sits in.
          Every number on this page rewrites itself twice a second. */}
      <span className="text-2xl leading-tight tabular-nums">{value}</span>
      <span className="min-h-4 text-xs text-dim">{note}</span>
    </div>
  )
}

export function StatRow({ snapshot }: { snapshot: MetricsSnapshot | null }): ReactElement {
  const codes = snapshot === null ? [] : Object.entries(snapshot.statusCounts)

  return (
    <section className="rounded-sm border border-line bg-panel p-4">
      <h2 className="mb-4 text-xs font-normal tracking-[0.12em] uppercase text-dim">live</h2>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4">
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

        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs text-dim">status codes</span>
          <span className="flex flex-wrap gap-1.5 text-base leading-8 tabular-nums text-dim">
            {codes.length === 0
              ? PENDING
              : codes.map(([code, count]) => (
                  <span
                    key={code}
                    className={`rounded-sm border border-current px-1.5 ${codeColour(code)}`}
                  >
                    {code}
                    <span className="ml-1.5 text-fg">{count}</span>
                  </span>
                ))}
          </span>
          <span className="min-h-4 text-xs text-dim">{snapshot === null ? '' : 'since boot'}</span>
        </div>
      </div>
    </section>
  )
}
