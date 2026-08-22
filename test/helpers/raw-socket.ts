// module 0.3  test/helpers/raw-socket.ts -- write literal bytes, collect raw response bytes
//
// Every protocol test in this project goes through here rather than through fetch, axios
// or supertest. That is not purism -- client libraries actively hide the three things this
// server most needs to prove:
//
//   * `100 Continue`. An interim response is consumed by the client library and never
//     surfaced. `curl -v` shows it; fetch does not.
//   * Keep-alive. Clients pool connections invisibly, so "did the server reuse this
//     socket" is unanswerable from the client API. On a raw socket, reuse is simply
//     whether a second response arrives without reconnecting.
//   * Chunked framing. Clients decode it before you see it, so an incorrectly framed
//     response that happens to decode is indistinguishable from a correct one.
//
// The only way to assert on those is to look at the bytes.

import { Socket } from 'node:net'
import { once } from 'node:events'

const DEFAULT_TIMEOUT_MS = 2_000

/** A predicate over everything received so far. Return true once the test has enough bytes. */
export type ReadCondition = (received: Buffer) => boolean

export interface ReadOptions {
  /** Milliseconds before the read gives up. */
  timeoutMs?: number
}

/** Resolves once the peer closes its side. Right for `Connection: close` responses. */
export const untilClose = Symbol('untilClose')

/** Resolves once at least `n` bytes have arrived. */
export function untilBytes(n: number): ReadCondition {
  return (received) => received.length >= n
}

/** Resolves once `needle` appears. `untilIncludes('\r\n\r\n')` waits for a header section. */
export function untilIncludes(needle: string | Buffer): ReadCondition {
  const target = typeof needle === 'string' ? Buffer.from(needle, 'latin1') : needle
  return (received) => received.includes(target)
}

/** Resolves once `count` complete response header sections have arrived. Used for keep-alive. */
export function untilResponses(count: number): ReadCondition {
  const terminator = Buffer.from('\r\n\r\n', 'latin1')
  return (received) => {
    let seen = 0
    let from = 0
    for (;;) {
      const at = received.indexOf(terminator, from)
      if (at === -1) return seen >= count
      seen++
      if (seen >= count) return true
      from = at + terminator.length
    }
  }
}

/**
 * Renders bytes so a failure message is readable.
 *
 * CRLF is shown as a visible token rather than as an actual line break, because "the
 * response had a bare LF where it should have had CRLF" is a real bug in this project and
 * a printed newline hides it completely.
 */
export function describe(bytes: Buffer): string {
  return bytes
    .toString('latin1')
    .replace(/\r\n/g, '[CRLF]\n')
    .replace(/\r/g, '[CR]')
    .replace(/\n(?!$)/g, (m, offset: number, s: string) =>
      s.slice(Math.max(0, offset - 6), offset).endsWith('[CRLF]') ? m : '[LF]\n',
    )
}

export interface RawConnection {
  /** Sends bytes exactly as given. No framing, no encoding, no newline translation. */
  write(data: string | Buffer): Promise<void>
  /** Waits until `condition` is satisfied (or the peer closes, for `untilClose`). */
  read(condition: ReadCondition | typeof untilClose, options?: ReadOptions): Promise<Buffer>
  /** Everything received so far, without waiting. */
  received(): Buffer
  /** True once the peer has closed or the socket has been destroyed. */
  readonly closed: boolean
  /** Closes the local side and waits for the socket to finish. */
  close(): Promise<void>
}

/** Opens a TCP connection and starts collecting every byte the peer sends. */
export async function connect(port: number, host = '127.0.0.1'): Promise<RawConnection> {
  const socket = new Socket()
  socket.connect(port, host)
  await once(socket, 'connect')

  let buffer = Buffer.alloc(0)
  let ended = false
  let failure: Error | undefined
  /** Woken on every data event, on end, and on error, so a pending read can re-check. */
  let wake: (() => void) | undefined

  const notify = (): void => {
    wake?.()
    wake = undefined
  }

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    notify()
  })
  socket.on('close', () => {
    ended = true
    notify()
  })
  socket.on('error', (error: Error) => {
    // ECONNRESET is how an abrupt peer close presents, and on Windows it arrives where
    // Linux would deliver a clean FIN. Tests assert on the collected bytes rather than on
    // which of the two happened, so this is recorded and only raised if a read is still
    // waiting for more.
    failure = error
    ended = true
    notify()
  })

  return {
    received: () => buffer,
    get closed() {
      return ended
    },

    async write(data) {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'latin1') : data
      await new Promise<void>((resolve, reject) => {
        socket.write(bytes, (error) => (error ? reject(error) : resolve()))
      })
    },

    async read(condition, options) {
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const deadline = Date.now() + timeoutMs
      const satisfied = (): boolean =>
        condition === untilClose ? ended : condition(buffer) || ended

      while (!satisfied()) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw new Error(
            `raw socket read timed out after ${timeoutMs}ms with ${buffer.length} byte(s) received:\n` +
              describe(buffer),
          )
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          setTimeout(resolve, Math.min(remaining, 25)).unref()
        })
      }

      // A read that ended with nothing at all is almost always a connection refused or a
      // server that died, and surfacing the socket error makes that obvious.
      if (failure && buffer.length === 0) throw failure
      return buffer
    },

    async close() {
      if (!socket.destroyed) {
        socket.destroy()
        await once(socket, 'close').catch(() => undefined)
      }
      ended = true
    },
  }
}

/**
 * Opens a connection, sends `bytes`, and returns everything received.
 *
 * Defaults to reading until close, which suits a `Connection: close` response. Pass a
 * condition for keep-alive, where waiting for close would hang until the idle timeout.
 */
export async function rawRequest(
  port: number,
  bytes: string | Buffer,
  options?: ReadOptions & { until?: ReadCondition | typeof untilClose },
): Promise<Buffer> {
  const connection = await connect(port)
  try {
    await connection.write(bytes)
    const readOptions: ReadOptions = {}
    if (options?.timeoutMs !== undefined) readOptions.timeoutMs = options.timeoutMs
    return await connection.read(options?.until ?? untilClose, readOptions)
  } finally {
    await connection.close()
  }
}
