// module 3.1-3.3  server/http/response/writer.ts -- status line, headers, framing, bodyless rules

import { config } from '../../config.js'
import { hasForbiddenFieldByte, isToken, listTokens, trimOWS } from '../parser/tokens.js'
import { forbidsContent, isInformational, isValidStatus, reasonPhrase } from './status.js'

/** A number is accepted because Content-Length is one everywhere it is produced. */
export type HeaderValue = string | number | readonly string[]

export type OutgoingHeaders = Readonly<Record<string, HeaderValue>>

/**
 * How the client is told where this response's body ends. The mirror of module 2.4's
 * `Framing`, and the same decision seen from the sending side.
 *
 * `close` is the option a request never has: with no Content-Length and no chunked coding
 * available, the end of the body is the end of the connection. It is the HTTP/1.0 fallback,
 * and it costs the connection -- which is what chunked was added to 1.1 to avoid.
 *
 * `none` is the absence of framing rather than a kind of it: the body is over at the empty
 * line and no header describes it.
 */
export type ResponseFraming =
  | { readonly kind: 'length'; readonly length: number }
  | { readonly kind: 'chunked' }
  | { readonly kind: 'close' }
  | { readonly kind: 'none' }

export interface ResponseHead {
  readonly status: number
  /** Replaces the table's phrase. Express writes one through `res.statusMessage`. */
  readonly reason?: string
  /** Sent in insertion order after the framing header; an array sends one field line each. */
  readonly headers?: OutgoingHeaders
  /** Emits the matching framing header unless `headers` already carries one. */
  readonly framing?: ResponseFraming
}

export interface SerialiseOptions {
  /** Injected so a test can pin the clock rather than assert on the second it ran in. */
  readonly now?: number
  readonly serverName?: string
}

/** Anything bytes can be handed to. `Connection` satisfies it; a test array does too. */
export interface ByteSink {
  write(data: Buffer | string, onFlush?: (error?: Error) => void): boolean
}

let cachedSecond = -1
let cachedDate = ''

/**
 * The current time as an IMF-fixdate, recomputed at most once a second.
 *
 * `Date.prototype.toUTCString()` is exactly IMF-fixdate -- ECMA-262 pins its output to the
 * `Sun, 06 Nov 1994 08:49:37 GMT` form, which is the one RFC 9110 section 5.6.7 requires an
 * origin server to send. The cache is not a micro-optimisation: without it every response
 * on a keep-alive connection allocates a Date and reformats a string that cannot have
 * changed, and the header is only accurate to the second anyway.
 */
export function imfFixdate(atMs: number = Date.now()): string {
  const second = Math.floor(atMs / 1_000)
  if (second !== cachedSecond) {
    cachedSecond = second
    cachedDate = new Date(second * 1_000).toUTCString()
  }
  return cachedDate
}

function fieldLine(name: string, value: string): string {
  if (!isToken(name)) {
    throw new TypeError(`wirehttp: ${JSON.stringify(name)} is not a valid header name`)
  }
  if (hasForbiddenFieldByte(value)) {
    throw new TypeError(`wirehttp: header ${name} has a value containing a forbidden byte`)
  }
  return `${name}: ${value}\r\n`
}

function lowercasedNames(headers: OutgoingHeaders | undefined): Set<string> {
  const names = new Set<string>()
  for (const name of Object.keys(headers ?? {})) names.add(name.toLowerCase())
  return names
}

function firstValue(headers: OutgoingHeaders, wanted: string): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== wanted) continue
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    return value[0]
  }
  return undefined
}

export interface FramingContext {
  /** The status being sent. 1xx, 204 and 304 are framed by the empty line and nothing else. */
  readonly status?: number
  /** Length of the whole body when it is in hand at head time; absent when it is not. */
  readonly knownLength?: number
  /** The client's version. HTTP/1.0 has no chunked coding. */
  readonly httpVersion?: '1.0' | '1.1'
}

/**
 * Chooses the framing for one response.
 *
 * A sender MUST NOT send both Content-Length and Transfer-Encoding -- RFC 9112 section 6.1,
 * the same rule module 2.4 enforces on the way in. Refusing it here as well is not symmetry
 * for its own sake: a response carrying both is the smuggling primitive pointed at whatever
 * proxy sits in front of this server, and picking one silently is exactly the choice that
 * makes two hops disagree about where the response ended.
 */
export function decideResponseFraming(
  headers: OutgoingHeaders,
  context: FramingContext = {},
): ResponseFraming {
  // Checked before the header fields, not after them: RFC 9112 section 6.3 makes the status
  // the first rule of response framing, so a Content-Length on a 204 is not a conflict to
  // resolve -- it is a field with nothing to describe, and it does not go out.
  if (context.status !== undefined && forbidsContent(context.status)) return { kind: 'none' }

  const transferEncoding = firstValue(headers, 'transfer-encoding')
  const contentLength = firstValue(headers, 'content-length')
  const httpVersion = context.httpVersion ?? '1.1'

  if (transferEncoding !== undefined && contentLength !== undefined) {
    throw new TypeError(
      'wirehttp: a response cannot carry both Content-Length and Transfer-Encoding',
    )
  }

  if (transferEncoding !== undefined) {
    if (trimOWS(transferEncoding).toLowerCase() !== 'chunked') {
      throw new TypeError(
        `wirehttp: unsupported Transfer-Encoding ${JSON.stringify(transferEncoding)}`,
      )
    }
    if (httpVersion === '1.0') {
      throw new TypeError('wirehttp: an HTTP/1.0 client cannot be sent a chunked response')
    }
    return { kind: 'chunked' }
  }

  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) {
      throw new TypeError(
        `wirehttp: Content-Length ${JSON.stringify(contentLength)} is not a length`,
      )
    }
    return { kind: 'length', length: Number(contentLength) }
  }

  if (context.knownLength !== undefined) return { kind: 'length', length: context.knownLength }

  return httpVersion === '1.0' ? { kind: 'close' } : { kind: 'chunked' }
}

const CRLF = Buffer.from('\r\n', 'latin1')

/**
 * The terminating zero-length chunk and the empty trailer section after it. Written once,
 * by `end()`. Responses never send trailers, so nothing goes between the two CRLFs.
 */
export const LAST_CHUNK = Buffer.from('0\r\n\r\n', 'latin1')

/**
 * chunk = chunk-size CRLF chunk-data CRLF, size in hex with no extensions (RFC 9112
 * section 7.1).
 *
 * A zero-length chunk is refused rather than encoded, because `0` CRLF is the last-chunk
 * marker: encoding an empty write would end the body early and leave the rest of it to be
 * read as the next response. A truncated page from a single `res.write('')`.
 */
export function encodeChunk(chunk: Buffer): Buffer {
  if (chunk.length === 0) throw new RangeError('wirehttp: a chunk of zero bytes cannot be encoded')
  return Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`, 'latin1'), chunk, CRLF])
}

/** Serialises the status line, the header block, and the empty line that ends it. */
export function serialiseHead(head: ResponseHead, options: SerialiseOptions = {}): Buffer {
  const { status } = head
  if (!isValidStatus(status)) {
    throw new RangeError(`wirehttp: ${status} is not a three-digit HTTP status code`)
  }

  const reason = head.reason ?? reasonPhrase(status)
  if (hasForbiddenFieldByte(reason)) {
    throw new TypeError(
      `wirehttp: reason phrase ${JSON.stringify(reason)} contains a forbidden byte`,
    )
  }

  let text = `HTTP/1.1 ${status} ${reason}\r\n`

  const supplied = lowercasedNames(head.headers)

  // RFC 9110 section 6.6.1: an origin server with a clock MUST send Date on 2xx, 3xx and
  // 4xx, and MAY on 1xx. An interim response is a bare status line and nothing else, which
  // is what 4.4 writes before the request body has even been read.
  if (!isInformational(status)) {
    if (!supplied.has('date')) text += `Date: ${imfFixdate(options.now)}\r\n`
    if (!supplied.has('server')) text += `Server: ${options.serverName ?? config.serverName}\r\n`
  }

  const framing = head.framing
  const bodyless = framing?.kind === 'none'

  if (framing?.kind === 'length' && !supplied.has('content-length')) {
    text += `Content-Length: ${framing.length}\r\n`
  } else if (framing?.kind === 'chunked' && !supplied.has('transfer-encoding')) {
    text += 'Transfer-Encoding: chunked\r\n'
  }

  for (const [name, value] of Object.entries(head.headers ?? {})) {
    // A framing header an application set on a 204 or a 304 is dropped rather than passed
    // through. Everything else it set is kept -- a 304's ETag and Cache-Control are the
    // point of the response.
    const lower = name.toLowerCase()
    if (bodyless && (lower === 'content-length' || lower === 'transfer-encoding')) continue

    if (typeof value === 'string' || typeof value === 'number') {
      text += fieldLine(name, String(value))
    } else {
      for (const one of value) text += fieldLine(name, one)
    }
  }

  return Buffer.from(text + '\r\n', 'latin1')
}

export interface ResponseWriterOptions {
  readonly serverName?: string
  /** The requesting client's version. HTTP/1.0 gets a close-delimited body, not chunked. */
  readonly httpVersion?: '1.0' | '1.1'
  /**
   * The request's method. A HEAD response carries the full header block the equivalent GET
   * would have carried -- Content-Length included, describing a body that is not sent --
   * and then stops. Suppressing the header instead would remove the only reason to send a
   * HEAD at all.
   */
  readonly method?: string
  /**
   * The connection policy module 4 decided for this exchange. When it is set this writer
   * owns the `Connection` header; when it is not, the header is left to the caller, which
   * is what 3.4's error path does.
   */
  readonly keepAlive?: boolean
  /**
   * Called once `end()` has put the last byte of this response on the sink. Module 4 uses
   * it to start the next exchange or close the connection; 5.3's `'finish'` event is the
   * same moment seen from the stream side.
   */
  readonly onFinish?: () => void
}

/**
 * Body bytes are encoded here rather than in the sink. The sink writes a string as latin1,
 * which is right for a header line and wrong for a body: Node's `res.end(str)` defaults to
 * utf8, and a server that mangles every non-ASCII character in a body is a compatibility
 * bug that would not surface until module 6.
 */
function toBuffer(chunk: Buffer | string, encoding: BufferEncoding): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
}

/**
 * One response, written onto one sink.
 *
 * The sink is an interface rather than a `Connection` so module 3 does not depend on module
 * 1, and so a test can assert on the bytes without opening a socket.
 *
 * Framing is decided when the head goes out and never revisited, because by then the client
 * has been told how to find the end of the body. `end(body)` with nothing written yet is
 * the one case where the whole length is known, and it is the common one: it produces
 * Content-Length. Anything else produces chunked.
 */
export class ResponseWriter {
  readonly #sink: ByteSink
  readonly #options: ResponseWriterOptions

  #framing: ResponseFraming | undefined
  #head: Buffer | undefined
  #headersSent = false
  #finished = false
  #bodyAllowed = true
  #bodyBytesWritten = 0
  #closeAnnounced = false

  constructor(sink: ByteSink, options: ResponseWriterOptions = {}) {
    this.#sink = sink
    this.#options = options
  }

  get headersSent(): boolean {
    return this.#headersSent
  }

  get finished(): boolean {
    return this.#finished
  }

  /** The framing this response committed to, once its head has gone out. */
  get framing(): ResponseFraming | undefined {
    return this.#framing
  }

  /**
   * The status line and header block exactly as they went on the wire, or undefined before
   * they did.
   *
   * Kept because subphase 5.3 has to expose it as `res._header`: `finalhandler/index.js:259`
   * and `send/index.js:1048` both fall back to `Boolean(res._header)` to decide whether a
   * response has already started, and the alternative to keeping the bytes here is
   * serialising the same head a second time somewhere else.
   */
  get head(): Buffer | undefined {
    return this.#head
  }

  /** Body bytes put on the wire, before any chunk encoding. Zero for a bodyless response. */
  get bodyBytesWritten(): number {
    return this.#bodyBytesWritten
  }

  /**
   * False once this response has been settled as one that carries no body -- a HEAD, a 204,
   * a 304 or an interim. Body bytes handed to `write()` and `end()` are then discarded
   * rather than refused, because Express calls `res.end(body)` on a HEAD request without
   * knowing it is one, and Node swallows it exactly the same way.
   */
  get bodyAllowed(): boolean {
    return this.#bodyAllowed
  }

  /**
   * True once this connection cannot carry another request after this response -- either
   * because the close is the framing, or because the policy in `keepAlive` said so. Module
   * 4 reads this rather than its own decision, because the framing can overrule it.
   */
  get mustCloseAfter(): boolean {
    return (
      this.#framing?.kind === 'close' || this.#options.keepAlive === false || this.#closeAnnounced
    )
  }

  /**
   * Writes the status line and header block, choosing the framing from the headers given.
   * Optional -- `write()` and `end()` send a head themselves if one has not gone out.
   */
  writeHead(head: ResponseHead): boolean {
    return this.#sendHead(head)
  }

  write(chunk: Buffer | string, encoding: BufferEncoding = 'utf8'): boolean {
    if (this.#finished) throw new Error('wirehttp: write() after end()')

    const body = toBuffer(chunk, encoding)
    // Committing to a framing here rather than buffering is what makes a streamed response
    // stream: this chunk is on the wire before the next one is asked for.
    if (!this.#headersSent) this.#sendHead({ status: 200 })
    if (body.length === 0) return true

    return this.#writeBody(body)
  }

  end(chunk?: Buffer | string, encoding: BufferEncoding = 'utf8'): boolean {
    if (this.#finished) throw new Error('wirehttp: end() called twice on one response')

    const body = chunk === undefined ? undefined : toBuffer(chunk, encoding)
    if (!this.#headersSent) {
      this.#sendHead({ status: 200, framing: { kind: 'length', length: body?.length ?? 0 } })
    }

    let accepted = true
    if (body !== undefined && body.length > 0) accepted = this.#writeBody(body)

    const framing = this.#framing
    // Both of these describe a body, so neither applies when there is not one: the declared
    // length belongs to the GET this HEAD is asking about, and the terminal chunk is the
    // last thing in a body rather than a thing that follows one.
    if (this.#bodyAllowed) {
      if (framing?.kind === 'length' && this.#bodyBytesWritten !== framing.length) {
        throw new Error(
          `wirehttp: response declared Content-Length ${framing.length} but sent ${this.#bodyBytesWritten}`,
        )
      }
      if (framing?.kind === 'chunked') accepted = this.#sink.write(LAST_CHUNK)
    }

    this.#finished = true
    this.#options.onFinish?.()
    return accepted
  }

  /**
   * The `Connection` header, from the policy module 4 handed down.
   *
   * Applied here rather than by the caller because it cannot be known any earlier than the
   * framing is: an HTTP/1.0 response whose length is not in hand at head time is delimited
   * by the close itself, so that response ends the connection whatever the request asked
   * for. An announced keep-alive on a close-delimited body would leave the client waiting
   * for a second response on a socket that is already going away.
   */
  #withConnection(head: ResponseHead, framing: ResponseFraming): OutgoingHeaders | undefined {
    const { keepAlive, httpVersion } = this.#options
    if (keepAlive === undefined) return head.headers
    // An interim response is a bare status line: the connection it is sent on belongs to
    // the final response that follows it, not to this one.
    if (isInformational(head.status)) return head.headers
    if (lowercasedNames(head.headers).has('connection')) return head.headers

    if (!keepAlive || framing.kind === 'close') return { Connection: 'close', ...head.headers }

    // A 1.1 connection is already persistent, so the header would only restate the default.
    return httpVersion === '1.0' ? { Connection: 'keep-alive', ...head.headers } : head.headers
  }

  #sendHead(head: ResponseHead): boolean {
    if (this.#headersSent) throw new Error('wirehttp: writeHead() called twice on one response')

    const { httpVersion, serverName, method } = this.#options
    const context: { status: number; httpVersion?: '1.0' | '1.1' } = { status: head.status }
    if (httpVersion !== undefined) context.httpVersion = httpVersion

    const framing = head.framing ?? decideResponseFraming(head.headers ?? {}, context)
    this.#framing = framing
    this.#headersSent = true
    this.#bodyAllowed = framing.kind !== 'none' && method?.toUpperCase() !== 'HEAD'

    const options: SerialiseOptions = serverName === undefined ? {} : { serverName }
    const headers = this.#withConnection(head, framing)
    const sending: ResponseHead =
      headers === undefined ? { ...head, framing } : { ...head, headers, framing }

    // Read back off the headers actually going out rather than off the policy, so that a
    // `Connection: close` an application set for its own reasons -- 3.4's error path is one
    // -- is a close that happens, not just a close the client is told about.
    const announced = firstValue(sending.headers ?? {}, 'connection')
    if (announced !== undefined && listTokens(announced).has('close')) this.#closeAnnounced = true

    this.#head = serialiseHead(sending, options)
    return this.#sink.write(this.#head)
  }

  #writeBody(body: Buffer): boolean {
    if (!this.#bodyAllowed) return true

    const framing = this.#framing
    if (framing?.kind === 'length' && this.#bodyBytesWritten + body.length > framing.length) {
      // Past the declared length the extra bytes are not part of this response at all: a
      // pipelining client reads them as the status line of the next one.
      throw new Error(
        `wirehttp: response declared Content-Length ${framing.length} and tried to send more`,
      )
    }

    this.#bodyBytesWritten += body.length
    return this.#sink.write(framing?.kind === 'chunked' ? encodeChunk(body) : body)
  }
}
