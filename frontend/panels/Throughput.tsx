// module 8.2  frontend/panels/Throughput.tsx -- requests/sec over the last minute, as a shape

import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { MetricsSnapshot } from '../useMetricsStream'
import { Panel } from './Panel'

/** Milliseconds between snapshots. Mirrors the interval `/api/metrics/stream` pushes on. */
const SAMPLE_INTERVAL_MS = 500

/** Samples kept, so at the interval above the chart covers the last minute. */
const CAPACITY = 120

const VIEW_WIDTH = 600
const VIEW_HEIGHT = 120
/** Headroom above the peak, so the highest point is a point rather than a clipped edge. */
const TOP_PAD = 6

/**
 * The last CAPACITY readings, oldest first.
 *
 * Appended from an effect rather than during render, and only for a timestamp not already
 * seen: StrictMode mounts, unmounts and remounts every effect, so a push that did not check
 * would record each sample twice and halve the window the chart actually covers.
 */
function useSeries(snapshot: MetricsSnapshot | null): readonly number[] {
  const [series, setSeries] = useState<readonly number[]>([])
  const lastAt = useRef(0)

  useEffect(() => {
    if (snapshot === null || snapshot.at === lastAt.current) return
    lastAt.current = snapshot.at
    setSeries((previous) => [...previous, snapshot.requests.perSecond].slice(-CAPACITY))
  }, [snapshot])

  return series
}

/** SVG polygon/polyline coordinates, x spread across the full width, y scaled to `scale`. */
function coordinates(series: readonly number[], scale: number): string {
  const step = VIEW_WIDTH / (series.length - 1)

  return series
    .map((value, index) => {
      const y = VIEW_HEIGHT - (value / scale) * (VIEW_HEIGHT - TOP_PAD)
      return `${(index * step).toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

export function Throughput({ snapshot }: { snapshot: MetricsSnapshot | null }): ReactElement {
  const series = useSeries(snapshot)

  const peak = series.reduce((highest, value) => Math.max(highest, value), 0)
  // An idle server is a flat line along the floor rather than a divide by zero.
  const scale = Math.max(peak, 1)
  const now = snapshot?.requests.perSecond ?? 0

  // Two points are the minimum that describe a direction; one would draw a spike at x=0.
  const line = series.length < 2 ? '' : coordinates(series, scale)
  const span = Math.round((series.length * SAMPLE_INTERVAL_MS) / 1000)

  return (
    <Panel
      title="throughput"
      hint="requests per second, one sample every half second. the server averages over a five second window, so this is a smoothed curve and not a count per tick."
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <span className="flex items-baseline gap-2">
          <span className="text-3xl leading-none tracking-tight text-accent tabular-nums">
            {snapshot === null ? '--' : now.toFixed(1)}
          </span>
          <span className="text-xs text-dim">req/sec now</span>
        </span>
        <span className="flex items-baseline gap-5 text-xs text-dim tabular-nums">
          <span>
            peak <span className="text-fg">{peak.toFixed(1)}</span>
          </span>
          <span>
            spanning <span className="text-fg">{span}s</span>
          </span>
        </span>
      </div>

      <div className="relative">
        <svg
          className="h-32 w-full"
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          // The chart is a shape to read, not a grid to measure against, so it stretches to
          // whatever width the column has. Every stroke below opts out of that scaling.
          preserveAspectRatio="none"
          role="img"
          aria-label={`requests per second over the last ${span} seconds, currently ${now.toFixed(1)}, peak ${peak.toFixed(1)}`}
        >
          <defs>
            <linearGradient id="throughput-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.3" />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {[0.25, 0.5, 0.75].map((fraction) => (
            <line
              key={fraction}
              x1="0"
              x2={VIEW_WIDTH}
              y1={VIEW_HEIGHT * fraction}
              y2={VIEW_HEIGHT * fraction}
              stroke="var(--color-line)"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {line === '' ? null : (
            <>
              <polygon
                points={`0,${VIEW_HEIGHT} ${line} ${VIEW_WIDTH},${VIEW_HEIGHT}`}
                fill="url(#throughput-fill)"
              />
              <polyline
                points={line}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth="1.5"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
        </svg>

        {/* Overlaid rather than placed after the chart, so the chart does not jump down the
            page the moment the second sample arrives. */}
        {line === '' ? (
          <p className="absolute inset-0 flex items-center justify-center text-xs text-faint">
            collecting samples
          </p>
        ) : null}
      </div>
    </Panel>
  )
}
