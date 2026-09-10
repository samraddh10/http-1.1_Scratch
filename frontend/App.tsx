// module 8.1/8.2  frontend/App.tsx -- the whole page; there is no router and no second screen

import type { ReactElement } from 'react'

import { Connections } from './panels/Connections'
import { Requests } from './panels/Requests'
import { StatRow } from './panels/StatRow'
import { StatusCodes } from './panels/StatusCodes'
import { Throughput } from './panels/Throughput'
import { useMetricsStream, type MetricsSnapshot, type StreamStatus } from './useMetricsStream'

// Written out one status at a time rather than built as `text-${...}`. Tailwind generates a
// utility only when it finds the whole class name as literal text in a source file, so an
// interpolated name produces no CSS at all -- and the failure is silent: the badge renders,
// uncoloured, with nothing logged anywhere.
const STREAM_STYLE: Record<StreamStatus, { readonly text: string; readonly dot: string }> = {
  connecting: { text: 'text-warn', dot: 'bg-warn' },
  live: { text: 'text-accent', dot: 'bg-accent' },
  reconnecting: { text: 'text-warn', dot: 'bg-warn' },
  closed: { text: 'text-bad', dot: 'bg-bad' },
}

function StreamBadge({ status }: { status: StreamStatus }): ReactElement {
  const style = STREAM_STYLE[status]

  return (
    <span
      // Announced when it changes, because losing the stream is the one thing on this page
      // a reader needs to be told rather than left to notice in a number that stopped.
      aria-live="polite"
      className={`ml-auto flex shrink-0 items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-xs tracking-wider ${style.text}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${style.dot} ${status === 'closed' ? '' : 'animate-pulse'}`}
      />
      {status}
    </span>
  )
}

// Same thresholds as the connections table, so a figure here and a figure there read alike.
function bytes(count: number): string {
  if (count < 1024) return `${count} B`
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`
  return `${(count / (1024 * 1024)).toFixed(1)} MB`
}

function Fact({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-faint">{label}</span>
      <span className="text-dim tabular-nums">{value}</span>
    </span>
  )
}

/**
 * The name, what the thing is, and the path a request takes through it.
 *
 * Also load-bearing as layout: the panels above stop well short of the fold on a tall
 * screen, and without something anchored to the bottom the page ends in a band of empty
 * base colour that reads as a rendering fault rather than as whitespace.
 */
function Footer({ snapshot }: { snapshot: MetricsSnapshot | null }): ReactElement {
  // Open sockets only -- the same rows the connections table draws, so the two agree. A
  // closed socket takes its counters with it, which is why this is not billed as a total.
  const openBytes =
    snapshot === null
      ? 0
      : snapshot.connections.rows.reduce((sum, row) => sum + row.bytesRead + row.bytesWritten, 0)

  return (
    <footer className="mt-auto border-t border-line bg-sunken">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between fit:py-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="font-semibold tracking-tight text-accent">Socket/1.1</span>
            <span className="text-xs text-faint">HTTP/1.1, written from the socket up</span>
          </p>
          {/* Dropped where the page is locked to the window: the sentence is the first thing
              worth trading for a taller inspector, and the line above it still names the
              thing. */}
          <p className="mt-1.5 max-w-prose font-sans text-xs leading-relaxed text-dim fit:hidden">
            the parser, the framing and the keep-alive accounting are written here; node's http
            module is a type import and nothing else. this page rides the same stream.
          </p>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-xs lg:justify-end">
          <Fact label="path" value="tcp -> parser -> shims -> express" />
          <Fact label="metrics" value="server-sent events" />
          <Fact label="on the wire now" value={bytes(openBytes)} />
        </div>
      </div>
    </footer>
  )
}

export function App(): ReactElement {
  const { snapshot, status } = useMetricsStream()

  return (
    // A column the height of the viewport. Under `fit` it is exactly the viewport and clips:
    // the dashboard then neither scrolls as a page nor leaves a band of base colour under the
    // footer, because the inspector below takes whatever height is left over and its lists
    // scroll inside themselves. Everywhere else the column is a floor, the page scrolls, and
    // the footer's `mt-auto` still holds it to the bottom edge.
    <div className="flex min-h-screen flex-col fit:h-screen fit:overflow-hidden">
      {/* Sticky, because the panels below it scroll past on a laptop and the stream badge is
          the one control that has to stay answerable at any scroll position. */}
      <header className="sticky top-0 z-10 border-b border-line bg-base/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-4 py-3 sm:px-6">
          {/* Preflight resets headings to inherit, so the size is set here or the wordmark
              comes out at the body's text-sm. */}
          <h1 className="flex shrink-0 items-center gap-2.5 text-lg font-semibold tracking-tight text-accent">
            {/* The same accent tick the panel titles carry, at the size of this line: the
                wordmark and a panel heading are then visibly the same system. */}
            <span aria-hidden="true" className="h-4 w-0.5 rounded-full bg-accent" />
            Socket/1.1
          </h1>
          {/* A rule rather than a gap. The tagline is a different kind of text from the name
              beside it, and at this size the two ran together as one phrase. */}
          <span aria-hidden="true" className="hidden h-5 w-px shrink-0 bg-line md:block" />
          <p className="hidden min-w-0 truncate font-sans text-xs text-dim md:block">
            an HTTP/1.1 server on raw TCP sockets, serving this page over its own wire format
          </p>
          <StreamBadge status={status} />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 px-4 py-6 sm:px-6 fit:min-h-0 fit:grow fit:py-4">
        <StatRow snapshot={snapshot} />

        {/* Three readings of the server as it stands, on one row: the rate, the outcomes, the
            sockets. Each is a handful of short lines, so they are sized to their content and
            the chart takes what is left. */}
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_17rem_24rem]">
          <Throughput snapshot={snapshot} />
          <StatusCodes snapshot={snapshot} />
          <Connections snapshot={snapshot} />
        </div>

        {/* Full width, alone. The inspector is a list and two panes of text side by side, and
            it is the one thing here you read rather than glance at. */}
        <Requests snapshot={snapshot} />
      </main>

      <Footer snapshot={snapshot} />
    </div>
  )
}
