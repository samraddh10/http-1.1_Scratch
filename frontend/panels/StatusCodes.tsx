// module 8.2  frontend/panels/StatusCodes.tsx -- every response since boot, as a proportion

import type { ReactElement } from 'react'

import type { MetricsSnapshot } from '../useMetricsStream'
import { Panel } from './Panel'

// Written out one class at a time rather than built as `bg-${...}`. Tailwind generates a
// utility only when it finds the whole class name as literal text in a source file, so an
// interpolated name produces no CSS at all -- and the failure is silent: the bar renders,
// uncoloured, with nothing logged anywhere.
const FILL: Readonly<Record<string, string>> = {
  '2': 'bg-accent',
  '3': 'bg-info',
  '4': 'bg-warn',
  '5': 'bg-bad',
}

const TEXT: Readonly<Record<string, string>> = {
  '2': 'text-accent',
  '3': 'text-info',
  '4': 'text-warn',
  '5': 'text-bad',
}

function fill(code: string): string {
  return FILL[code.charAt(0)] ?? 'bg-edge'
}

function text(code: string): string {
  return TEXT[code.charAt(0)] ?? 'text-dim'
}

export function StatusCodes({ snapshot }: { snapshot: MetricsSnapshot | null }): ReactElement {
  const codes = snapshot === null ? [] : Object.entries(snapshot.statusCounts)
  const total = codes.reduce((sum, [, count]) => sum + count, 0)

  return (
    <Panel
      title="status codes"
      hint="every response this process has written, by code."
      action={<span className="shrink-0 text-xs text-dim tabular-nums">{total}</span>}
    >
      {total === 0 ? (
        <p className="text-xs text-faint">
          {snapshot === null ? 'waiting for the stream' : 'no responses yet'}
        </p>
      ) : (
        <>
          {/* The mix at a glance. A list of counts makes you divide in your head to answer
              the only question worth asking of it: is anything failing, and how much. */}
          <div className="flex h-2 overflow-hidden rounded-full bg-line">
            {codes.map(([code, count]) => (
              <span
                key={code}
                className={fill(code)}
                style={{ width: `${(count / total) * 100}%` }}
              />
            ))}
          </div>

          <ul className="mt-4 flex flex-col gap-2 text-xs tabular-nums">
            {codes.map(([code, count]) => (
              <li key={code} className="flex items-center gap-2.5">
                {/* Colour repeats the code rather than replacing it, so the class is still
                    readable to anyone who cannot separate the four hues. */}
                <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-xs ${fill(code)}`} />
                <span className={text(code)}>{code}</span>
                <span className="grow text-right">{count}</span>
                <span className="w-11 text-right text-faint">
                  {((count / total) * 100).toFixed(0)}%
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  )
}
