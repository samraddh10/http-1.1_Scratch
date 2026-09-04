// module 7.1  server/metrics/registry.ts -- the counters, and the hooks modules 3 and 4 call

import { config as defaultConfig } from '../config.js'
import type { Framing } from '../http/parser/framing.js'
import { RingBuffer } from './ring-buffer.js'

/** Seconds the requests-per-second figure averages over. */
const WINDOW_SECONDS = 5

/**
 * One answered request, as the inspector panel shows it: the head on the left, what the
 * parser made of it on the right.
 */
export interface RequestSample {
  /** Epoch ms at which the response finished. */
  readonly at: number
  /** The connection that carried it, so the panel can group requests by socket. */
  readonly connectionId: number
  /** Which request this was on that connection; 1 is the one that opened it. */
  readonly sequence: number
  /** The request head as text -- the left-hand pane. */
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

/** One open socket, read off the live connection rather than accumulated here. */
export interface ConnectionRow {
  readonly id: number
  readonly requestsServed: number
  readonly idleMs: number
  readonly ageMs: number
  readonly bytesRead: number
  readonly bytesWritten: number
}

/**
 * The half of a snapshot that is a live reading rather than a running total.
 *
 * It is passed in rather than accumulated because the numbers already exist on the objects
 * that own them -- `Connection.idleMs`, `TcpServer.refusedConnections` -- and a second copy
 * kept here would be one more thing to keep in step, wrong in exactly the moments that
 * matter.
 */
export interface LiveConnections {
  readonly refused: number
  readonly connections: readonly ConnectionRow[]
}

export interface MetricsSnapshot {
  /** Epoch ms the snapshot was taken. */
  readonly at: number
  readonly connections: {
    readonly open: number
    readonly accepted: number
    readonly refused: number
    readonly rows: readonly ConnectionRow[]
  }
  readonly requests: {
    readonly total: number
    /** Requests over the last five seconds, divided by five. */
    readonly perSecond: number
    /** Fraction of requests that arrived on a connection someone had already used. */
    readonly keepAliveReuse: number
  }
  /** Keyed by status code, ascending. */
  readonly statusCounts: Readonly<Record<string, number>>
  /** Newest first. */
  readonly recent: readonly RequestSample[]
}

export interface MetricsRegistryOptions {
  /** How many requests the inspector's ring keeps. */
  recentRequestsBufferSize?: number
  /** Injected so the rolling window can be tested without waiting out real seconds. */
  now?: () => number
}


export class MetricsRegistry {
  readonly #recent: RingBuffer<RequestSample>
  readonly #now: () => number

  #accepted = 0
  #requests = 0
  readonly #statusCounts = new Map<number, number>()

  // The rolling window, as one slot per second of it. A slot holds the second it was last
  // written for, so a slot last touched more than WINDOW_SECONDS ago is stale rather than
  // zero and is skipped on read -- which is what makes the window roll without a timer.
  readonly #windowSecond = new Array<number>(WINDOW_SECONDS).fill(Number.NEGATIVE_INFINITY)
  readonly #windowCount = new Array<number>(WINDOW_SECONDS).fill(0)

  constructor(options: MetricsRegistryOptions = {}) {
    this.#recent = new RingBuffer<RequestSample>(
      options.recentRequestsBufferSize ?? defaultConfig.recentRequestsBufferSize,
    )
    this.#now = options.now ?? Date.now
  }

  /** A socket was accepted. Refused ones never get here -- `TcpServer` counts those. */
  connectionOpened(): void {
    this.#accepted++
  }

  responseWritten(status: number): void {
    if (status < 200) return

    this.#requests++
    this.#statusCounts.set(status, (this.#statusCounts.get(status) ?? 0) + 1)

    const second = Math.floor(this.#now() / 1000)
    const slot = ((second % WINDOW_SECONDS) + WINDOW_SECONDS) % WINDOW_SECONDS
    if (this.#windowSecond[slot] !== second) {
      this.#windowSecond[slot] = second
      this.#windowCount[slot] = 0
    }
    this.#windowCount[slot] = (this.#windowCount[slot] ?? 0) + 1
  }

  /** A full exchange is over and both halves of it are known. Called from module 4. */
  requestServed(sample: RequestSample): void {
    this.#recent.push(sample)
  }

  snapshot(live: LiveConnections): MetricsSnapshot {
    const at = this.#now()

    return {
      at,
      connections: {
        open: live.connections.length,
        accepted: this.#accepted,
        refused: live.refused,
        rows: live.connections,
      },
      requests: {
        total: this.#requests,
        perSecond: this.#windowTotal(at) / WINDOW_SECONDS,
        keepAliveReuse: this.#keepAliveReuse(),
      },
      statusCounts: this.#statusSnapshot(),
      recent: this.#recent.recent(),
    }
  }

  #windowTotal(at: number): number {
    const second = Math.floor(at / 1000)
    let total = 0
    for (let i = 0; i < WINDOW_SECONDS; i++) {
      const written = this.#windowSecond[i] ?? Number.NEGATIVE_INFINITY
      if (written <= second && written > second - WINDOW_SECONDS) {
        total += this.#windowCount[i] ?? 0
      }
    }
    return total
  }

  /**
   * Requests that did not cost a connection, over requests.
   *
   * One request per connection is 0 and twenty requests on one connection is 0.95, which is
   * the claim the dashboard is making -- that a keep-alive connection is being reused
   * rather than reopened. It is clamped because a connection can be accepted before it has
   * asked for anything, and a server sitting on ten open sockets and no requests should
   * read as no reuse rather than as a negative one.
   */
  #keepAliveReuse(): number {
    if (this.#requests === 0) return 0
    return Math.max(0, (this.#requests - this.#accepted) / this.#requests)
  }

  #statusSnapshot(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const status of [...this.#statusCounts.keys()].sort((a, b) => a - b)) {
      out[String(status)] = this.#statusCounts.get(status) ?? 0
    }
    return out
  }
}

/**
 * The registry this process reports on, alongside `config` and for the same reason: modules
 * 3 and 4 reach it without every constructor between here and there carrying one. Both take
 * an override, so a test gets its own instance and no shared state.
 */
export const metrics = new MetricsRegistry()
