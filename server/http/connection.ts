// module 4.1  server/http/connection.ts -- one socket, many exchanges
//
// The seam between the byte layers and whatever answers a request. Module 1 knows sockets
// and nothing about HTTP; modules 2 and 3 know one message each and nothing about the
// connection carrying them. This file is the only place that knows a connection is a
// sequence of exchanges: it owns the parser, hands each request to a listener, and decides
// from the response whether the socket is reused or ends. Phase 5 replaces the listener
// with the ServerRequest/ServerResponse shims and changes nothing here.

import { config as defaultConfig, type Config } from '../config.js'
import { metrics as defaultMetrics, type MetricsRegistry } from '../metrics/registry.js'
import type { CloseReason, Connection } from '../tcp/connection.js'
import type { TcpServerOptions } from '../tcp/server.js'
import { ProtocolError, requestTimeout } from './errors.js'
import { decidePersistence } from './keep-alive.js'
import type { RequestHead, RequestParserOptions } from './parser/request-parser.js'
import { RequestParser } from './parser/request-parser.js'
import { listTokens } from './parser/tokens.js'
import {
  respondToProtocolError,
  writeErrorResponse,
  type ErrorResponseOptions,
} from './response/error-response.js'
import { ResponseWriter, serialiseHead, type ResponseWriterOptions } from './response/writer.js'

const NO_TRAILERS: Readonly<Record<string, string>> = Object.freeze({})
const CRLF = '\r\n'

interface Expectation {
  /** The client is waiting for `100 Continue` before it sends the body. */
  readonly continue: boolean
  /** The `Expect` field, when it asked for something this server does not implement. */
  readonly unsupported: string | undefined
}

const NO_EXPECTATION: Expectation = { continue: false, unsupported: undefined }

/**
 * What the request's `Expect` field asks for, if it has one.
 *
 * The only expectation defined by HTTP is `100-continue` (RFC 9110 section 10.1.1), and it
 * exists so a client can ask before sending content it may not be allowed to send. Anything
 * else is refused rather than ignored: ignoring it would have the client believe a condition
 * was honoured when it was not.
 */
function classifyExpectation(head: RequestHead): Expectation {
  const expect = head.headers['expect']
  if (expect === undefined) return NO_EXPECTATION

  const asked = listTokens(expect)
  if (asked.size === 1 && asked.has('100-continue')) {
    // Section 10.1.1 has a server ignore a 100-continue expectation from an HTTP/1.0 client:
    // the mechanism is an interim response, and 1.0 has no way to receive one. Nothing is
    // refused -- the client is not waiting, so it sends its body regardless.
    const usable = head.httpVersion === '1.1' && head.framing.kind !== 'none'
    return { continue: usable, unsupported: undefined }
  }

  return { continue: false, unsupported: expect }
}

/**
 * The request head as text, reserialised from what the parser kept.
 *
 * `rawHeaders` holds every field line in the order and casing it arrived in, so this is the
 * head the client sent, byte for byte, other than optional whitespace around a field value
 * -- which the parser trims and does not keep. Reserialising costs nothing and happens once
 * per request; the alternative was module 2 retaining the head bytes of every request for
 * the sake of a dashboard panel.
 */
function headText(head: RequestHead): string {
  const lines = [`${head.method} ${head.target} HTTP/${head.httpVersion}`]
  for (let i = 0; i + 1 < head.rawHeaders.length; i += 2) {
    lines.push(`${head.rawHeaders[i] ?? ''}: ${head.rawHeaders[i + 1] ?? ''}`)
  }
  return lines.join(CRLF) + CRLF + CRLF
}

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
  /**
   * The socket died with this exchange still open. Module 5 turns it into the request's
   * `'aborted'` event, which is the only thing that stops `express.json()` waiting for a
   * body the client is no longer sending.
   */
  onConnectionClose?(reason: CloseReason): void
  /**
   * Told `false` when the listener cannot take more body bytes for now, and `true` when it
   * can again. The inbound half of the backpressure seam: the read side of the socket has
   * one owner, `#throttle`, and this is how a slow consumer reaches it.
   */
  demandBody(wanted: boolean): void
}

export type ExchangeListener = (exchange: Exchange) => void

export interface HttpConnectionOptions {
  readonly listener: ExchangeListener
  readonly config?: Config
  readonly serverName?: string
  /**
   * Observes closed connections, after the HTTP session has been told about them.
   *
   * It goes through here rather than being set on the `TcpServerOptions` this module
   * returns, because that slot is taken: `serveHttp` owns `onClose`, and a caller replacing
   * it would silently disconnect every open exchange from the news that its socket is gone.
   */
  readonly onConnectionClose?: (connection: Connection, reason: CloseReason) => void
  /** Where this connection's requests are recorded. Defaults to the process registry. */
  readonly metrics?: MetricsRegistry
}

interface ExchangeState extends Exchange {
  /** When the head was read, which is where this request's latency starts. */
  readonly openedAt: number
  dispatched: boolean
  requestComplete: boolean
  trailers: Readonly<Record<string, string>> | undefined
  readonly buffered: Buffer[]
  /** The client is holding its body back until this server says it will take it. */
  expects100: boolean
  /** An `Expect` this server cannot meet, kept to name it in the 417. */
  unsupportedExpect: string | undefined
}

export class HttpConnection {
  readonly #tcp: Connection
  readonly #listener: ExchangeListener
  readonly #serverName: string | undefined
  readonly #config: Config
  readonly #metrics: MetricsRegistry
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

  /** True while the exchange being read has said it cannot take more body bytes. */
  #bodyBackpressure = false

  /**
   * Requests OPENED, not served. Under pipelining a head is read long before the response
   * to it goes out, and counting what has been answered would let a client past the cap by
   * sending the next request before the last one was finished with.
   */
  #requestsOpened = 0

  constructor(tcp: Connection, options: HttpConnectionOptions) {
    this.#tcp = tcp
    this.#listener = options.listener
    this.#serverName = options.serverName
    this.#config = options.config ?? defaultConfig
    this.#metrics = options.metrics ?? defaultMetrics

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
    // After the parser has drained the chunk, not from inside `onHead`: a client that sent
    // its head and body together is still mid-parse at head time, and would be told to
    // continue with something it had already finished.
    this.#writeContinue(this.#queue[0])
    //if no error occurred, re-check whether the socket should be paused or resumed given whatever state changed during parsing.
    this.#throttle()
  }

  //called the instant the parser finishes a request's head (line + headers). Turns that head into a full exchange — decide keep-alive, 
  // build a ResponseWriter, create the ExchangeState — put it in the queue, and dispatch it to the listener immediately if and only if nothing is ahead of it in the queue.
  #openExchange(head: RequestHead): void {
    this.#requestsOpened++

    const persistence = decidePersistence({
      httpVersion: head.httpVersion,
      connection: head.headers['connection'],
      // The last request the cap allows is answered normally and carries the close, so the
      // client is told on the response it asked for rather than by a socket that stops
      // working. What the cap bounds is how long one client can hold a connection slot.
      serverWantsClose: this.#requestsOpened >= this.#config.maxRequestsPerConnection,
    })

    const options: ResponseWriterOptions = {
      httpVersion: head.httpVersion,
      method: head.method,
      keepAlive: persistence.keepAlive,
      onFinish: () => this.#finishExchange(),
      metrics: this.#metrics,
      ...(this.#serverName === undefined ? {} : { serverName: this.#serverName }),
    }

    const expectation = classifyExpectation(head)

    const state: ExchangeState = {
      openedAt: Date.now(),
      head,
      response: new ResponseWriter(this.#tcp, options),
      connection: this.#tcp,
      dispatched: false,
      requestComplete: false,
      trailers: undefined,
      buffered: [],
      expects100: expectation.continue,
      unsupportedExpect: expectation.unsupported,
      demandBody: (wanted) => this.#demandBody(state, wanted),
    }

    this.#bodyBackpressure = false
    this.#reading = state
    this.#queue.push(state)
    if (this.#queue.length === 1) this.#dispatch(state)
  }

  //Purpose: called each time the parser decodes one more chunk of the currently-open request's body. 
  // Either delivers it straight to the listener (if the listener has already been called) or holds onto it for later.
  #receiveBody(chunk: Buffer): void {
    const state = this.#reading
    if (state === undefined) throw new Error('wirehttp: body bytes with no request open')

    // The client sent its body without waiting for permission, which it is entitled to do.
    // There is nothing left to permit.
    state.expects100 = false

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
    // There is no more body to hold back, so a demand left unsatisfied cannot keep the read
    // side paused into the next request.
    this.#bodyBackpressure = false
    if (state.dispatched) state.onRequestComplete?.(trailers)
  }

  /**
   * The listener can or cannot take more body bytes.
   *
   * Ignored once the request has been read to its end -- `#reading` has moved on, and the
   * bytes still arriving belong to a pipelined request rather than to this body.
   */
  #demandBody(state: ExchangeState, wanted: boolean): void {
    if (this.#reading !== state) return
    if (this.#bodyBackpressure === !wanted) return

    this.#bodyBackpressure = !wanted
    this.#throttle()
  }

  //Purpose: actually calls the application's listener for one exchange, and then replays whatever happened to that exchange 
  // (buffered body chunks, or a completion notice) while it was waiting for its turn.
  #dispatch(state: ExchangeState): void {
    state.dispatched = true

    // Both of these write to the socket, so they run at dispatch rather than when the head
    // was read: a pipelined request must not put bytes in front of the response before it.
    if (state.unsupportedExpect !== undefined) {
      this.#refuseExpectation(state)
      return
    }

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

  /**
   * Writes the interim response a client with `Expect: 100-continue` is waiting for.
   *
   * Skipped once the listener has answered, and that is the entire point of the mechanism:
   * a client asks before uploading, and a final status arriving instead of the 100 tells it
   * not to bother. A 50 MB upload refused on its headers then costs one round trip rather
   * than 50 MB.
   */
  #writeContinue(state: ExchangeState | undefined): void {
    if (state === undefined || !state.dispatched || !state.expects100) return
    state.expects100 = false

    // Nothing left to permit once the response has been given, and nothing to wait for once
    // the body has arrived anyway.
    if (state.response.headersSent || state.requestComplete) return

    // A bare status line and the empty line after it. 3.1 gives an interim response no Date,
    // no Server and no framing, because it is not the response -- the real one follows on
    // this same connection, and a client reads both.
    this.#tcp.write(serialiseHead({ status: 100, framing: { kind: 'none' } }))
  }

  /**
   * RFC 9110 section 10.1.1: an expectation the server cannot meet MUST be refused with 417
   * rather than ignored. The listener never sees the request -- an application cannot be
   * asked to honour a condition this server has already said it does not implement.
   */
  #refuseExpectation(state: ExchangeState): void {
    const body = '417 Expectation Failed\n'
    // The client is holding a body back waiting for a permission that is never coming, so
    // there is no way to find where the next request would start. With no content declared
    // the stream position is still known and the connection survives the refusal.
    const hasBody = state.head.framing.kind !== 'none'

    state.response.writeHead({
      status: 417,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...(hasBody ? { Connection: 'close' } : {}),
      },
    })
    state.response.end(body)
  }

  //onFinish runs when an exchange’s response is fully sent. It removes that exchange from the queue, updates the counter, 
  // decides whether to close the connection, and if not, moves to the next exchange and checks whether reading should resume.
  #finishExchange(): void {
    const state = this.#queue.shift()
    if (state === undefined) return

    this.#tcp.requestsServed++
    this.#record(state)

    if (state.response.mustCloseAfter) {
      this.#closing = true
      // end(), not destroy(): the response that explains the close is still in the socket's
      // send queue, and destroying discards it.
      this.#tcp.end('end-of-exchange')
      return
    }

    const next = this.#queue[0]
    if (next !== undefined) this.#dispatch(next)
    this.#writeContinue(this.#queue[0])
    this.#throttle()
  }

  /**
   * One answered exchange, for the inspector panel.
   *
   * Recorded here because this is the only place both halves are in hand: module 2 has the
   * request and module 3 has the response, and neither has the other. The status-code
   * counters do not come from here -- a protocol error never opens an exchange, so a
   * connection that answers only malformed requests would record nothing at all.
   */
  #record(state: ExchangeState): void {
    const { head } = state
    const status = state.response.status
    if (status === undefined) return

    this.#metrics.requestServed({
      at: Date.now(),
      connectionId: this.#tcp.id,
      sequence: this.#tcp.requestsServed,
      head: headText(head),
      method: head.method,
      target: head.target,
      path: head.path,
      query: head.query,
      httpVersion: head.httpVersion,
      headers: head.headers,
      framing: head.framing,
      status,
      durationMs: Date.now() - state.openedAt,
    })
  }

  /**
   * The one place that answers "is the server waiting on the client, or on the application?",
   * because reading and timing out are the same question asked twice.
   *
   * Waiting on the application means the request has been read to its end and its response
   * has not been written. Nothing more can be read -- every further byte starts a request
   * that cannot be answered until the queue drains -- and nothing should be timed out
   * either, since the silence is the server's own latency rather than an idle client.
   *
   * A body the listener has stopped reading counts as waiting on the application for the
   * same reason and with the same consequence. Bytes left in the client's send buffer cost
   * it memory rather than this process, and the idle timer must not be running: the silence
   * is a slow consumer here, not a slow client, and timing it out would report the server's
   * own latency as the client's fault mid-upload.
   *
   * Every other state is waiting on the client: idle between requests, or a request still
   * arriving. Both read and both time out, which is what catches a client dribbling a
   * request out one byte at a time. Parse-ahead within one socket read stays allowed, so a
   * pipelining client's next request is ready the moment the current response ends.
   */
  #throttle(): void {
    if (this.#closing) return

    if (this.#bodyBackpressure || (this.#reading === undefined && this.#queue.length > 0)) {
      this.#tcp.pause()
      this.#tcp.disarmIdleTimeout()
    } else {
      this.#tcp.resume()
      this.#tcp.armIdleTimeout()
    }
  }

  /**
   * The socket is gone, however it went.
   *
   * Every exchange still open is told, once. Without this a request whose client vanished
   * mid-body is a stream that never ends and never errors: `raw-body` waits for bytes that
   * are not coming, and the only thing that would ever notice is a timeout on a connection
   * that no longer exists.
   */
  closed(reason: CloseReason): void {
    this.#closing = true

    // `#reading` is not always in the queue -- a listener that answers before the request
    // has been read to its end leaves its exchange being read after it has been shifted off.
    const open = new Set<ExchangeState>(this.#queue)
    if (this.#reading !== undefined) open.add(this.#reading)

    this.#queue.length = 0
    this.#reading = undefined

    for (const state of open) state.onConnectionClose?.(reason)
  }

  /**
   * The idle timeout expired while the server was waiting on the client -- `#throttle` does
   * not leave the timer armed in any other state.
   */
  timedOut(): void {
    if (this.#closing) return
    this.#closing = true

    // A response already on the wire has taken the only status line there is, so the timeout
    // cannot be reported: this is a client that stopped reading mid-response, not one that
    // failed to finish a request, and the bytes it is owed will never be acknowledged.
    if (this.#queue[0]?.response.headersSent === true) {
      this.#tcp.destroy('idle-timeout')
      return
    }

    // The two cases the timer catches, told apart by whether any of a request arrived. The
    // second is the slowloris: a connection held open by a byte every few seconds, costing
    // the attacker nothing and the server a connection slot.
    const partial = this.#reading !== undefined || this.#parser.buffered > 0
    const error = requestTimeout(
      partial ? 'an incomplete request stalled' : 'no request arrived before the idle timeout',
    )

    writeErrorResponse(this.#tcp, error, this.#errorOptions(this.#reading?.head.method))
    this.#tcp.end('idle-timeout')
  }

  /** The error path builds its own writer, so it is handed this connection's registry. */
  #errorOptions(method: string | undefined): ErrorResponseOptions {
    const options: { method?: string; metrics: MetricsRegistry } = { metrics: this.#metrics }
    if (method !== undefined) options.method = method
    return options
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
    respondToProtocolError(this.#tcp, error, this.#errorOptions(method))
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
  const registry = options.metrics ?? defaultMetrics

  return {
    onConnection: (connection) => {
      // Accepted sockets are counted here rather than in module 1, which never learns what
      // a connection is for. The ones refused at the cap never reach this function and are
      // counted by `TcpServer.refusedConnections` instead.
      registry.connectionOpened()
      sessions.set(connection, new HttpConnection(connection, options))
    },
    onTimeout: (connection) => {
      sessions.get(connection)?.timedOut()
    },
    onData: (connection, chunk) => {
      sessions.get(connection)?.receive(chunk)
    },
    onClose: (connection, reason) => {
      sessions.get(connection)?.closed(reason)
      options.onConnectionClose?.(connection, reason)
    },
  }
}
