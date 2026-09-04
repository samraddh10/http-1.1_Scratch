// module 8.4  frontend/panels/Requests.tsx -- the head as it arrived, and what the parser made
// of it, side by side

import { useState, type ReactElement } from 'react'

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

function Field({ label, value }: { label: string; value: string }): ReactElement {
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
 * worth showing -- including the empty line that ends the header section.
 */
function RawHead({ head }: { head: string }): ReactElement {
  const lines = head.split('\r\n')
  // The split leaves an empty final element after the terminating CRLF, which is not a line.
  if (lines.at(-1) === '') lines.pop()

  return (
    <pre className="max-h-64 overflow-auto text-xs leading-6">
      {lines.map((line, index) => (
        <div key={index}>
          {line}
          <span className="text-dim">{'\\r\\n'}</span>
        </div>
      ))}
    </pre>
  )
}

function Parsed({ sample }: { sample: RequestSample }): ReactElement {
  const headers = Object.entries(sample.headers)

  return (
    <dl className="grid max-h-64 grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 overflow-auto text-xs leading-6">
      <Field label="method" value={sample.method} />
      <Field label="target" value={sample.target} />
      <Field label="path" value={sample.path} />
      <Field label="query" value={sample.query === '' ? '(none)' : sample.query} />
      <Field label="version" value={`HTTP/${sample.httpVersion}`} />
      <Field label="framing" value={framingText(sample.framing)} />
      <Field label="connection" value={`#${sample.connectionId}, request ${sample.sequence}`} />
      <Field label="answered" value={`${sample.status} in ${sample.durationMs}ms`} />

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
      className="rounded-sm border border-line px-3 py-1 text-xs text-accent hover:border-accent disabled:text-dim disabled:hover:border-line"
    >
      {firing ? 'firing...' : `fire ${BURST_SIZE} requests`}
    </button>
  )

  return (
    <Panel
      title="requests"
      hint="the last requests this server answered. click one to pin it; the panel otherwise follows the newest."
      action={button}
    >
      {selected === undefined ? (
        <p className="text-xs text-dim">no requests yet</p>
      ) : (
        <>
          <div className="mb-4 max-h-40 overflow-y-auto border-y border-line">
            {samples.map((sample) => {
              const key = keyOf(sample)
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPinned(key)}
                  className={`flex w-full gap-3 px-1 py-0.5 text-left text-xs tabular-nums ${
                    key === keyOf(selected) ? 'bg-line' : ''
                  }`}
                >
                  <span className="w-12 shrink-0 text-dim">#{sample.connectionId}</span>
                  <span className="w-12 shrink-0">{sample.method}</span>
                  <span className="grow truncate">{sample.target}</span>
                  <span className={`w-8 shrink-0 text-right ${codeColour(sample.status)}`}>
                    {sample.status}
                  </span>
                  <span className="w-14 shrink-0 text-right text-dim">{sample.durationMs}ms</span>
                </button>
              )
            })}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <h3 className="mb-2 text-xs text-dim">raw bytes</h3>
              <RawHead head={selected.head} />
            </div>
            <div className="min-w-0">
              <h3 className="mb-2 text-xs text-dim">what the parser made of them</h3>
              <Parsed sample={selected} />
            </div>
          </div>
        </>
      )}
    </Panel>
  )
}
