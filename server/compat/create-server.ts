// module 5.4  server/compat/create-server.ts -- http.createServer-compatible entry point
import type { AddressInfo } from 'node:net'

import type { Config } from '../config.js'
import type { Exchange } from '../http/connection.js'
import type { MetricsRegistry } from '../metrics/registry.js'
import { serveHttp } from '../http/connection.js'
import type { Connection, CloseReason } from '../tcp/connection.js'
import type { TcpServer } from '../tcp/server.js'
import { createTcpServer } from '../tcp/server.js'
import { ServerRequest } from './server-request.js'
import { ServerResponse } from './server-response.js'

export type RequestListener = (request: ServerRequest, response: ServerResponse) => void

export interface CreateServerOptions {
  readonly config?: Config
  /** Value sent in the `Server` response header. */
  readonly serverName?: string
  readonly idleTimeoutMs?: number
  readonly maxConnections?: number
  /** Observes closed sockets. Module 7's connection counters hang off this. */
  readonly onConnectionClose?: (connection: Connection, reason: CloseReason) => void
  /** Where this server records its metrics. Defaults to the process registry. */
  readonly metrics?: MetricsRegistry
}

//This is the shape of the object createServer returns
export interface WireServer {
  listen(port?: number, host?: string, onListening?: () => void): WireServer
  listen(port: number, onListening: () => void): WireServer
  close(onClosed?: () => void): WireServer
  address(): AddressInfo | null
  readonly listening: boolean
  /**
   * Resolves with the bound address, or rejects if the bind failed. Unhandled, a failed
   * bind ends the process -- which is what an unhandled `'error'` on Node's server does too.
   */
  ready(): Promise<AddressInfo>
  /** The TCP layer underneath, which is where module 7 reads its connection counters. */
  readonly tcp: TcpServer
}

//dispatch takes one Exchange (a fully parsed request, produced by the HTTP layer) and converts it into the ServerRequest/ServerResponse pair the application's listener expects, 
// wires up the callbacks that keep those objects updated as more data arrives, and finally calls the listener.
function dispatch(exchange: Exchange, listener: RequestListener): void {
  const request = new ServerRequest({
    head: exchange.head,
    tcp: exchange.connection,
    onDemandChange: (wantsMore) => exchange.demandBody(wantsMore),
  })

  //Creates the response object, wrapping the response writer (writer.ts) and the same TCP connection.
  const response = new ServerResponse({
    writer: exchange.response,
    tcp: exchange.connection,
  })

  exchange.onBodyChunk = (chunk) => request.receiveBody(chunk)
  exchange.onRequestComplete = (trailers) => request.completeBody(trailers)
  exchange.onConnectionClose = () => {
    request.abort()
    response.abort()
  }

  listener(request, response)
}

//The public factory function. Accepts either just a listener, or an options object plus a listener, and returns a bound-but-not-yet-listening WireServer built on top of createTcpServer and serveHttp.
export function createServer(listener: RequestListener): WireServer
export function createServer(options: CreateServerOptions, listener: RequestListener): WireServer
export function createServer(
  optionsOrListener: CreateServerOptions | RequestListener,
  maybeListener?: RequestListener,
): WireServer {
  const options = typeof optionsOrListener === 'function' ? {} : optionsOrListener
  const listener = typeof optionsOrListener === 'function' ? optionsOrListener : maybeListener

  if (listener === undefined) {
    // Node allows a server with no request listener and an `on('request')` handler added
    // later. There is no `'request'` event here, so that server could never answer anything.
    throw new TypeError('wirehttp: createServer() needs a request listener')
  }

  //Building the TCP server
  const tcp = createTcpServer({
    ...serveHttp({
      listener: (exchange) => dispatch(exchange, listener),
      ...(options.config === undefined ? {} : { config: options.config }),
      ...(options.serverName === undefined ? {} : { serverName: options.serverName }),
      ...(options.onConnectionClose === undefined
        ? {}
        : { onConnectionClose: options.onConnectionClose }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
  })

  //Holds the promise from the eventual tcp.listen(...) call. undefined until listen() is invoked.
  let binding: Promise<AddressInfo> | undefined

  const server: WireServer = {
    tcp,
    address: () => tcp.address(),
    get listening() {
      return tcp.listening
    },

    ready(): Promise<AddressInfo> {
      return binding ?? Promise.reject(new Error('wirehttp: listen() has not been called'))
    },

    listen(port?: number, hostOrCallback?: string | (() => void), onListening?: () => void) {
      const host = typeof hostOrCallback === 'string' ? hostOrCallback : undefined
      const callback = typeof hostOrCallback === 'function' ? hostOrCallback : onListening

      binding = host === undefined ? tcp.listen(port) : tcp.listen(port, host)
      // No `catch` on purpose. A bind that fails is fatal, and letting the rejection go
      // unhandled ends the process with EADDRINUSE, which is what Node does with an
      // unhandled `'error'` on its own server.
      if (callback !== undefined) void binding.then(() => callback())

      return server
    },

    close(onClosed?: () => void) {
      const closed = tcp.close()
      if (onClosed !== undefined) void closed.then(() => onClosed())
      return server
    },
  }

  return server
}
