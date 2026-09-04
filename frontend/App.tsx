// module 8.1/8.2  frontend/App.tsx -- the whole page; there is no router and no second screen

import type { ReactElement } from 'react'

import { Connections } from './panels/Connections'
import { Requests } from './panels/Requests'
import { StatRow } from './panels/StatRow'
import { useMetricsStream, type StreamStatus } from './useMetricsStream'

// Written out one status at a time rather than built as `text-${...}`. Tailwind generates a
// utility only when it finds the whole class name as literal text in a source file, so an
// interpolated name produces no CSS at all -- and the failure is silent: the badge renders,
// uncoloured, with nothing logged anywhere.
const STREAM_COLOUR: Record<StreamStatus, string> = {
  connecting: 'text-warn',
  live: 'text-accent',
  reconnecting: 'text-warn',
  closed: 'text-bad',
}

export function App(): ReactElement {
  const { snapshot, status } = useMetricsStream()

  return (
    <div className="mx-auto max-w-6xl px-4 pt-8 pb-12">
      <header className="mb-6 grid grid-cols-[1fr_auto] items-center border-b border-line pb-4">
        <h1 className="col-start-1 text-xl font-bold tracking-wide text-accent">wirehttp</h1>
        <p className="col-start-1 mt-1 text-dim">
          an HTTP/1.1 server on raw TCP sockets, serving this page over its own wire format
        </p>
        <span
          className={`col-start-2 row-span-2 justify-self-end rounded-sm border border-current px-2 py-0.5 text-xs tracking-wider ${STREAM_COLOUR[status]}`}
        >
          {status}
        </span>
      </header>

      <main className="flex flex-col gap-6">
        <StatRow snapshot={snapshot} />
        <Connections snapshot={snapshot} />
        <Requests snapshot={snapshot} />
      </main>
    </div>
  )
}
