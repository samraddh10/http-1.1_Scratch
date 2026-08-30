// module 1.1  server/tcp/server.ts -- net.createServer, the accept loop, and a close() that resolves

import { createServer, type AddressInfo } from 'node:net'

import { config } from '../config.js'
import { Connection, type ConnectionHandlers, type ConnectionOptions } from './connection.js'

export interface TcpServerOptions extends ConnectionHandlers {
  onConnection?(connection: Connection): void
  idleTimeoutMs?: number
  /** Concurrent connections allowed. Past it a socket is closed on arrival. */
  maxConnections?: number
}

export interface TcpServer {
  listen(port?: number, host?: string): Promise<AddressInfo>
  close(): Promise<void>
  address(): AddressInfo | null
  connections(): readonly Connection[]
  readonly connectionCount: number
  /** Sockets closed on arrival for being over the cap. Module 7 reports it. */
  readonly refusedConnections: number
  readonly listening: boolean
}

/**
 * Placeholder data handler: answers every chunk with `<chunk>/<total>\n`. Replaced in
 * phase 2 by the request parser; nothing above module 1 should use it.
 */
export function echoByteCounts(connection: Connection, chunk: Buffer): void {
  connection.write(`${chunk.length}/${connection.bytesRead}\n`)
}

export function createTcpServer(options: TcpServerOptions = {}): TcpServer {
  const open = new Set<Connection>()
  const maxConnections = options.maxConnections ?? config.maxConnections
  let refused = 0

  const handlers: ConnectionOptions = {
    onData: options.onData ?? echoByteCounts,
    ...(options.onTimeout === undefined ? {} : { onTimeout: options.onTimeout }),
    onClose: (connection, reason) => {
      open.delete(connection)
      options.onClose?.(connection, reason)
    },
  }
  if (options.idleTimeoutMs !== undefined) handlers.idleTimeoutMs = options.idleTimeoutMs

  const server = createServer(
    {
      // Nagle delays a small write hoping to coalesce it with the next one, but in a
      // request/response protocol the next write is the client's next request, which
      // cannot arrive until it has our response. Node's own http server disables it too.
      noDelay: true,
    },
    (socket) => {
      // Closed on arrival, with nothing written and nothing read. There is no request to
      // answer yet -- the client has not sent one -- and reading far enough to produce a
      // 503 would spend the parser, the buffer and the timer slot that being over the cap
      // says are not there. The cap is a resource limit, so it cannot cost a resource to
      // enforce; a client sees the connection refused, which is what it would see from
      // every other server at its accept limit.
      if (open.size >= maxConnections) {
        refused++
        socket.destroy()
        return
      }

      const connection = new Connection(socket, handlers)
      open.add(connection)
      options.onConnection?.(connection)
    },
  )

  function addressOrThrow(): AddressInfo {
    const bound = server.address()
    if (bound === null || typeof bound === 'string') {
      throw new Error('wirehttp: expected a TCP address after listen()')
    }
    return bound
  }

  let closing: Promise<void> | undefined

  async function shutDown(): Promise<void> {
    // `net.Server.close()` only stops accepting and then waits for open connections to end
    // on their own. For a keep-alive HTTP server that is a hang, because an idle client
    // has no reason to disconnect -- so this destroys what is open as well.
    if (!server.listening) {
      for (const connection of open) connection.destroy('server-shutdown')
      return
    }

    const closed = new Promise<void>((resolve) => {
      server.once('close', () => resolve())
    })

    // Stop accepting first, so a connection cannot slip in behind the destroy loop.
    server.close()
    for (const connection of open) connection.destroy('server-shutdown')

    await closed
  }

  return {
    address: () => (server.listening ? addressOrThrow() : null),
    connections: () => [...open],
    get connectionCount() {
      return open.size
    },
    get refusedConnections() {
      return refused
    },
    get listening() {
      return server.listening
    },

    async listen(port = config.port, host = '127.0.0.1'): Promise<AddressInfo> {
      if (server.listening) {
        throw new Error('wirehttp: listen() called on a server that is already listening')
      }

      // A failed bind arrives as an 'error' event, not as a throw from `listen()`. Both
      // listeners are removed once one fires: leaving the error listener attached would
      // mean a later server error resolved into an already-settled promise and vanished.
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })

      closing = undefined

      return addressOrThrow()
    },

    close(): Promise<void> {
      closing ??= shutDown()
      return closing
    },
  }
}
