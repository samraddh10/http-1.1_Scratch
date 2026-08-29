// module 4.1  server/http/connection.ts -- one socket, many exchanges
//
// The seam between the byte layers and whatever answers a request. Module 1 knows sockets
// and nothing about HTTP; modules 2 and 3 know one message each and nothing about the
// connection carrying them. This file is the only place that knows a connection is a
// sequence of exchanges: it owns the parser, hands each request to a listener, and decides
// from the response whether the socket is reused or ends. Phase 5 replaces the listener
// with the ServerRequest/ServerResponse shims and changes nothing here.

import type { Config } from '../config.js'
import type { Connection } from '../tcp/connection.js'
import type { TcpServerOptions } from '../tcp/server.js'
import { ProtocolError } from './errors.js'
import { decidePersistence } from './keep-alive.js'
import type { RequestHead, RequestParserOptions } from './parser/request-parser.js'
import { RequestParser } from './parser/request-parser.js'
import { respondToProtocolError } from './response/error-response.js'
import { ResponseWriter, type ResponseWriterOptions } from './response/writer.js'

const NO_TRAILERS: Readonly<Record<string, string>> = Object.freeze({})

/**
 * One request and the response being written for it.
 *
 * `onBodyChunk` and `onRequestComplete` must be assigned synchronously by the listener:
 * body bytes read before the listener ran are replayed as soon as it returns, and an
 * assignment made after an `await` would miss them.
 */
export interface Exchange {
  readonly head: RequestHead
  readonly response: ResponseWriter
  readonly connection: Connection
  onBodyChunk?(chunk: Buffer): void
  onRequestComplete?(trailers: Readonly<Record<string, string>>): void
}

export type ExchangeListener = (exchange: Exchange) => void

export interface HttpConnectionOptions {
  readonly listener: ExchangeListener
  readonly config?: Config
  readonly serverName?: string
}

interface ExchangeState extends Exchange {
  dispatched: boolean
  requestComplete: boolean
  trailers: Readonly<Record<string, string>> | undefined
  readonly buffered: Buffer[]
}

export class HttpConnection {
  readonly #tcp: Connection
  readonly #listener: ExchangeListener
  readonly #serverName: string | undefined
  readonly #parser: RequestParser

  /**
   * Exchanges in request order: index 0 is the one being answered, the rest are pipelined
   * requests already parsed and waiting. Responses go out in this order because HTTP/1.1
   * has no way to say which request a response belongs to other than its position.
   */
  readonly #queue: ExchangeState[] = []

  /**
   * The exchange the parser is currently filling, which is not always one in `#queue`: a
   * listener may answer and finish before the request has been read to its end, and the
   * rest of that body still has to be consumed to find where the next request begins.
   */
  #reading: ExchangeState | undefined

  #closing = false

  constructor(tcp: Connection, options: HttpConnectionOptions) {
    this.#tcp = tcp
    this.#listener = options.listener
    this.#serverName = options.serverName

    const parserOptions: RequestParserOptions = {
      onHead: (head) => this.#openExchange(head),
      onBodyChunk: (chunk) => this.#receiveBody(chunk),
      onComplete: (trailers) => this.#completeRequest(trailers),
    }
    if (options.config !== undefined) parserOptions.config = options.config

    this.#parser = new RequestParser(parserOptions)
  }

  /** Exchanges parsed and not yet answered. Zero between requests on an idle connection. */
  get pending(): number {
    return this.#queue.length
  }

  receive(chunk: Buffer): void {
    // After a close is decided the remaining bytes are not a request that will ever be
    // answered, and parsing them could only produce an error response nobody will read.
    if (this.#closing) return

    try {
      this.#parser.push(chunk)
    } catch (thrown) {
      if (!(thrown instanceof ProtocolError)) throw thrown
      this.#fail(thrown)
      return
    }
    //if no error occurred, re-check whether the socket should be paused or resumed given whatever state changed during parsing.
    this.#throttle()
  }

  //called the instant the parser finishes a request's head (line + headers). Turns that head into a full exchange — decide keep-alive, 
  // build a ResponseWriter, create the ExchangeState — put it in the queue, and dispatch it to the listener immediately if and only if nothing is ahead of it in the queue.
  #openExchange(head: RequestHead): void {
    const persistence = decidePersistence({
      httpVersion: head.httpVersion,
      connection: head.headers['connection'],
    })

    const options: ResponseWriterOptions = {
      httpVersion: head.httpVersion,
      method: head.method,
      keepAlive: persistence.keepAlive,
      onFinish: () => this.#finishExchange(),
      ...(this.#serverName === undefined ? {} : { serverName: this.#serverName }),
    }

    const state: ExchangeState = {
      head,
      response: new ResponseWriter(this.#tcp, options),
      connection: this.#tcp,
      dispatched: false,
      requestComplete: false,
      trailers: undefined,
      buffered: [],
    }

    this.#reading = state
    this.#queue.push(state)
    if (this.#queue.length === 1) this.#dispatch(state)
  }

  //Purpose: called each time the parser decodes one more chunk of the currently-open request's body. 
  // Either delivers it straight to the listener (if the listener has already been called) or holds onto it for later.
  #receiveBody(chunk: Buffer): void {
    const state = this.#reading
    if (state === undefined) throw new Error('wirehttp: body bytes with no request open')

    if (state.dispatched) state.onBodyChunk?.(chunk)
    else state.buffered.push(chunk)
  }

  //Purpose: called once the parser has consumed an entire request — body and any trailers — from the wire. 
  // Marks the exchange complete, and notifies the listener immediately if it's already running.
  #completeRequest(trailers: Readonly<Record<string, string>>): void {
    const state = this.#reading
    if (state === undefined) throw new Error('wirehttp: request completed with none open')

    state.requestComplete = true
    state.trailers = trailers
    this.#reading = undefined
    if (state.dispatched) state.onRequestComplete?.(trailers)
  }

  //Purpose: actually calls the application's listener for one exchange, and then replays whatever happened to that exchange 
  // (buffered body chunks, or a completion notice) while it was waiting for its turn.
  #dispatch(state: ExchangeState): void {
    state.dispatched = true

    try {
      this.#listener(state)
    } catch (thrown) {
      this.#failListener(state)
      return
    }

    for (const chunk of state.buffered) state.onBodyChunk?.(chunk)
    state.buffered.length = 0
    if (state.requestComplete) state.onRequestComplete?.(state.trailers ?? NO_TRAILERS)
  }

  //onFinish runs when an exchange’s response is fully sent. It removes that exchange from the queue, updates the counter, 
  // decides whether to close the connection, and if not, moves to the next exchange and checks whether reading should resume.
  #finishExchange(): void {
    const state = this.#queue.shift()
    if (state === undefined) return

    this.#tcp.requestsServed++

    if (state.response.mustCloseAfter) {
      this.#closing = true
      // end(), not destroy(): the response that explains the close is still in the socket's
      // send queue, and destroying discards it.
      this.#tcp.end('end-of-exchange')
      return
    }

    const next = this.#queue[0]
    if (next !== undefined) this.#dispatch(next)
    this.#throttle()
  }

  /**
   * Stops reading while a response is outstanding and no request is mid-read, because every
   * further byte then starts a request that cannot be answered until the queue drains.
   * Parse-ahead within one socket read is still allowed, which is what keeps a pipelining
   * client's next request ready the moment the current response ends.
   */
  #throttle(): void {
    if (this.#closing) return

    if (this.#reading === undefined && this.#queue.length > 0) this.#tcp.pause()
    else this.#tcp.resume()
  }

  //Called when the parser detects an invalid HTTP request. It sends an error response if it is still safe to do so; otherwise, it simply closes the connection.
  #fail(error: ProtocolError): void {
    // A response already on the wire has taken the only place a status line could go, so
    // the error goes unreported and the connection ends once that response has flushed.
    if (this.#queue[0]?.response.headersSent === true) {
      this.#closing = true
      this.#tcp.end('client-error')
      return
    }

    const method = this.#reading?.head.method ?? this.#parser.requestLine?.method
    this.#closing = error.closeAfter
    respondToProtocolError(this.#tcp, error, method === undefined ? {} : { method })
  }

  //Called when the application’s handler throws an error. Since the problem is in the application, not the client’s request, 
  // it simply checks whether an error response can still be sent; if not, it closes the connection.
  #failListener(state: ExchangeState): void {
    // The listener is the application. Whatever it threw is its bug rather than a protocol
    // error, so the client is told the status and nothing else, and the connection ends:
    // past a throw there is no knowing how much of the response was meant to be written.
    if (!state.response.headersSent) {
      state.response.writeHead({ status: 500, headers: { Connection: 'close' } })
      state.response.end('500 Internal Server Error\n')
      return
    }

    this.#closing = true
    this.#tcp.end('end-of-exchange')
  }
}

///Converts the HTTP connection settings into the format expected by the TCP server. In simple terms, it connects the HTTP layer to the TCP server so serveHttp() can create a working HTTP/1.1 server.
export function serveHttp(options: HttpConnectionOptions): TcpServerOptions {
  const sessions = new WeakMap<Connection, HttpConnection>()

  return {
    onConnection: (connection) => {
      sessions.set(connection, new HttpConnection(connection, options))
    },
    onData: (connection, chunk) => {
      sessions.get(connection)?.receive(chunk)
    },
  }
}
