// module 8.2  frontend/useMetricsStream.ts -- one EventSource, no state library

import { useEffect, useState } from 'react'

/**
 * The snapshot as it arrives over the wire.
 *
 * Declared here rather than imported from `server/metrics/registry.ts`, which is where the
 * server's copy lives. That module reaches for `process.env` through `config.ts` and names
 * `TcpServer`, neither of which exists in a browser -- and this config sets `types: []`
 * precisely so that fails. What crosses the wire is JSON, so the client declares the shape
 * of the JSON. The two must be kept in step by hand; that is the cost, and it is smaller
 * than a shared module both tsconfigs would have to include.
 */
export interface MetricsSnapshot {
  readonly at: number
  readonly connections: {
    readonly open: number
    readonly accepted: number
    readonly refused: number
    readonly rows: readonly ConnectionRow[]
  }
  readonly requests: {
    readonly total: number
    readonly perSecond: number
    readonly keepAliveReuse: number
  }
  readonly statusCounts: Readonly<Record<string, number>>
  readonly recent: readonly RequestSample[]
}

export interface ConnectionRow {
  readonly id: number
  readonly requestsServed: number
  readonly idleMs: number
  readonly ageMs: number
  readonly bytesRead: number
  readonly bytesWritten: number
}

export type Framing =
  | { readonly kind: 'none' }
  | { readonly kind: 'length'; readonly length: number }
  | { readonly kind: 'chunked' }

export interface RequestSample {
  readonly at: number
  readonly connectionId: number
  readonly sequence: number
  readonly head: string
  readonly method: string
  readonly target: string
  readonly path: string
  readonly query: string
  readonly httpVersion: string
  readonly headers: Readonly<Record<string, string>>
  readonly framing: Framing
  readonly status: number
  readonly durationMs: number
}

/**
 * `connecting` until the first byte, `live` while snapshots arrive, `reconnecting` while the
 * browser retries, `closed` when it has given up.
 */
export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'closed'

export interface MetricsStream {
  /** Null until the first snapshot arrives. */
  readonly snapshot: MetricsSnapshot | null
  readonly status: StreamStatus
}

export function useMetricsStream(url = '/api/metrics/stream'): MetricsStream {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null)
  const [status, setStatus] = useState<StreamStatus>('connecting')

  useEffect(() => {
    const source = new EventSource(url)

    source.onopen = (): void => setStatus('live')

    source.onmessage = (event: MessageEvent<string>): void => {
      setSnapshot(JSON.parse(event.data) as MetricsSnapshot)
      setStatus('live')
    }

    // There is deliberately no retry logic here. EventSource reconnects on its own, which
    // is the entire reason the dashboard uses it rather than a fetch loop; all this does
    // is report which side of that the connection is currently on.
    source.onerror = (): void => {
      setStatus(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting')
    }

    // Without this the stream survives the unmount, and the server keeps a timer and a
    // socket for a viewer that is gone -- the mirror of the `response.on('close')` that
    // clears the interval on the other end.
    return () => source.close()
  }, [url])

  return { snapshot, status }
}
