// module 8.4  frontend/panels/Requests.tsx -- the head as it arrived, and what the parser made
// of it, side by side

import { useState, type ReactElement, type ReactNode } from 'react'

import type { Framing, MetricsSnapshot, RequestSample } from '../useMetricsStream'
import { Panel } from './Panel'

/** Requests the button fires at once. Enough to move requests/sec off zero for a few ticks. */
const BURST_SIZE = 25

// Literal class names, as everywhere else on this page: Tailwind never sees a name that only
// exists once the digit is interpolated in.
const CODE_COLOUR: Readonly<Record<string, string>> = {
  '2': 'text-accent',
  '3': 'text-info',
  '4': 'text-warn',
  '5': 'text-bad',
}

function codeColour(status: number): string {
  return CODE_COLOUR[String(status).charAt(0)] ?? 'text-dim'
}

/** Unique per process: ids come from the TCP layer, sequences count within one connection. */
function keyOf(sample: RequestSample): string {
  return `${sample.connectionId}:${sample.sequence}`
}

function framingText(framing: Framing): string {
  switch (framing.kind) {
    case 'length':
      return `content-length, ${framing.length} bytes`
    case 'chunked':
      return 'chunked'
    case 'none':
      return 'no body'
  }
}

function Pane({
  label,
  meta,
  children,
}: {
  label: string
  meta: string
  children: ReactNode
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col fit:min-h-0">
      <div className="mb-2 flex shrink-0 items-baseline justify-between gap-3">
        <h3 className="text-xs tracking-[0.14em] text-dim uppercase">{label}</h3>
        <span className="shrink-0 text-xs text-faint tabular-nums">{meta}</span>
      </div>
      {children}
    </div>
  )
}

function Field({ label, value }: { label: string; value: ReactNode }): ReactElement {
  return (
    <>
      <dt className="text-dim">{label}</dt>
      <dd className="break-all">{value}</dd>
    </>
  )
}

/**
 * The head as text, one line per field line.
 *
 * The CRLF is drawn rather than implied. It is the delimiter the whole parser is built
 * around, and a pane that renders the head as ordinary wrapped text hides the one detail
 * worth showing -- including the empty line that ends the header section. Nothing else in
 * here is coloured or reordered: the pane next to it is where interpretation belongs.
 */
function RawHead({ head }: { head: string }): ReactElement {
  const lines = head.split('\r\n')
  // The split leaves an empty final element after the terminating CRLF, which is not a line.
  if (lines.at(-1) === '') lines.pop()

  return (
    // A fixed height on a scrolling page; under `fit` it takes what the panel has left over.
    <pre className="h-64 overflow-auto rounded-sm border border-line bg-sunken p-3 text-xs leading-6 fit:h-auto fit:min-h-0 fit:grow">
      {lines.map((line, index) => (
        <div key={index} className="break-all">
          {line}
          <span className="text-faint">{'\\r\\n'}</span>
        </div>
      ))}
    </pre>
  )
}

function Parsed({ sample }: { sample: RequestSample }): ReactElement {
  const headers = Object.entries(sample.headers)

  return (
    <dl className="grid h-64 grid-cols-[6.5rem_1fr] content-start gap-x-3 gap-y-1 overflow-auto rounded-sm border border-line bg-sunken p-3 text-xs leading-6 fit:h-auto fit:min-h-0 fit:grow">
      <Field label="method" value={sample.method} />
      <Field label="target" value={sample.target} />
      <Field label="path" value={sample.path} />
      <Field label="query" value={sample.query === '' ? '(none)' : sample.query} />
      <Field label="version" value={`HTTP/${sample.httpVersion}`} />
      <Field label="framing" value={framingText(sample.framing)} />
      <Field label="connection" value={`#${sample.connectionId}, request ${sample.sequence}`} />
      <Field
        label="answered"
        value={
          <>
            <span className={codeColour(sample.status)}>{sample.status}</span>
            {` in ${sample.durationMs}ms`}
          </>
        }
      />

      <dt className="mt-2 text-dim">headers</dt>
      <dd className="mt-2">
        {headers.length === 0
          ? '(none)'
          : headers.map(([name, value]) => (
              <div key={name} className="break-all">
                <span className="text-dim">{name}: </span>
                {value}
              </div>
            ))}
      </dd>
    </dl>
  )
}

export function Requests({ snapshot }: { snapshot: MetricsSnapshot | null }): ReactElement {
  const [pinned, setPinned] = useState<string | null>(null)
  const [firing, setFiring] = useState(false)

  const samples = snapshot?.recent ?? []
  // Newest unless one is pinned, and back to newest once a pinned one falls out of the ring.
  const selected = samples.find((sample) => keyOf(sample) === pinned) ?? samples[0]

  const fireBurst = (): void => {
    setFiring(true)
    void Promise.all(
      Array.from({ length: BURST_SIZE }, (_unused, index) =>
        fetch(`/echo/${index + 1}?burst=1`, { cache: 'no-store' }),
      ),
    ).finally(() => setFiring(false))
  }

  const button = (
    <button
      type="button"
      onClick={fireBurst}
      disabled={firing}
      className="shrink-0 cursor-pointer rounded-sm border border-edge px-3 py-1.5 text-xs text-accent transition-colors hover:border-accent hover:bg-raise disabled:cursor-not-allowed disabled:border-line disabled:text-faint disabled:hover:bg-transparent"
    >
      {firing ? 'firing...' : `fire ${BURST_SIZE} requests`}
    </button>
  )

  return (
    <Panel
      title="requests"
      hint="the last requests answered, newest first. click one to pin it."
      action={button}
      // The panel that absorbs the slack: everything above it is sized to its content, so
      // under `fit` this one ends level with the bottom of the window whatever height it is.
      className="fit:min-h-0 fit:grow"
    >
      {selected === undefined ? (
        <p className="text-xs text-faint">
          {snapshot === null ? 'waiting for the stream' : 'no requests yet'}
        </p>
      ) : (
        // The list is beside the two panes rather than above them, so picking a request and
        // reading it are one screen. Stacked, the panes started below the fold on a laptop and
        // every click cost a scroll down and back.
        <div className="grid gap-4 2xl:grid-cols-[24rem_minmax(0,1fr)] fit:min-h-0 fit:grow">
          <Pane label="recent" meta={`${samples.length} kept`}>
            <div className="h-64 overflow-y-auto rounded-sm border border-line bg-sunken fit:h-auto fit:min-h-0 fit:grow">
              {samples.map((sample) => {
                const key = keyOf(sample)
                const isSelected = key === keyOf(selected)

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setPinned(key)}
                    aria-pressed={isSelected}
                    className={`flex w-full cursor-pointer items-center gap-2.5 border-l-2 py-1 pr-3 pl-2 text-left text-xs transition-colors tabular-nums ${
                      isSelected ? 'border-accent bg-raise' : 'border-transparent hover:bg-raise'
                    }`}
                  >
                    <span className="w-8 shrink-0 text-faint">#{sample.connectionId}</span>
                    <span className="w-11 shrink-0 text-info">{sample.method}</span>
                    <span className="grow truncate">{sample.target}</span>
                    <span className={`w-8 shrink-0 text-right ${codeColour(sample.status)}`}>
                      {sample.status}
                    </span>
                    <span className="w-12 shrink-0 text-right text-dim">{sample.durationMs}ms</span>
                  </button>
                )
              })}
            </div>
          </Pane>

          <div className="grid min-w-0 gap-4 md:grid-cols-2 fit:min-h-0">
            <Pane label="raw bytes" meta={`${new TextEncoder().encode(selected.head).length} B`}>
              <RawHead head={selected.head} />
            </Pane>
            <Pane label="what the parser made of them" meta={`#${selected.connectionId}`}>
              <Parsed sample={selected} />
            </Pane>
          </div>
        </div>
      )}
    </Panel>
  )
}
