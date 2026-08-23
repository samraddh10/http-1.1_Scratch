import { Socket } from 'node:net'
import { once } from 'node:events'

const DEFAULT_TIMEOUT_MS = 2_000

export type ReadCondition = (received: Buffer) => boolean

export interface ReadOptions {
  timeoutMs?: number
}

export const untilClose = Symbol('untilClose')

export function untilBytes(n: number): ReadCondition {
  return (received) => received.length >= n
}

export function untilIncludes(needle: string | Buffer): ReadCondition {
  const target = typeof needle === 'string' ? Buffer.from(needle, 'latin1') : needle
  return (received) => received.includes(target)
}

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
  write(data: string | Buffer): Promise<void>
  read(condition: ReadCondition | typeof untilClose, options?: ReadOptions): Promise<Buffer>
  received(): Buffer
  readonly closed: boolean
  end(): Promise<void>
  close(): Promise<void>
}

export async function connect(port: number, host = '127.0.0.1'): Promise<RawConnection> {
  const socket = new Socket()
  socket.connect(port, host)
  await once(socket, 'connect')

  let buffer = Buffer.alloc(0)
  let ended = false
  let failure: Error | undefined
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

      if (failure && buffer.length === 0) throw failure
      return buffer
    },

    async end() {
      await new Promise<void>((resolve) => {
        socket.end(() => resolve())
      })
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
