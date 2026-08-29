// module 3.1-3.2  server/http/response/writer.ts -- status line, headers, framing
//
// 3.3 adds the bodyless rules to this file.

import { config } from '../../config.js'
import { hasForbiddenFieldByte, isToken, trimOWS } from '../parser/tokens.js'
import { isInformational, isValidStatus, reasonPhrase } from './status.js'

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
 */
export type ResponseFraming =
  | { readonly kind: 'length'; readonly length: number }
  | { readonly kind: 'chunked' }
  | { readonly kind: 'close' }

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
  if (framing?.kind === 'length' && !supplied.has('content-length')) {
    text += `Content-Length: ${framing.length}\r\n`
  } else if (framing?.kind === 'chunked' && !supplied.has('transfer-encoding')) {
    text += 'Transfer-Encoding: chunked\r\n'
  }

  for (const [name, value] of Object.entries(head.headers ?? {})) {
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
  #headersSent = false
  #finished = false
  #bodyBytesWritten = 0

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

  /** Body bytes handed to `write()` and `end()`, before any chunk encoding. */
  get bodyBytesWritten(): number {
    return this.#bodyBytesWritten
  }

  /**
   * True once this response is framed by the end of the connection, which module 4 must
   * then actually close: here the close is the framing, not a policy choice.
   */
  get mustCloseAfter(): boolean {
    return this.#framing?.kind === 'close'
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
    if (framing?.kind === 'length' && this.#bodyBytesWritten !== framing.length) {
      throw new Error(
        `wirehttp: response declared Content-Length ${framing.length} but sent ${this.#bodyBytesWritten}`,
      )
    }
    if (framing?.kind === 'chunked') accepted = this.#sink.write(LAST_CHUNK)

    this.#finished = true
    return accepted
  }

  #sendHead(head: ResponseHead): boolean {
    if (this.#headersSent) throw new Error('wirehttp: writeHead() called twice on one response')

    const { httpVersion, serverName } = this.#options
    const context: FramingContext = httpVersion === undefined ? {} : { httpVersion }

    const framing = head.framing ?? decideResponseFraming(head.headers ?? {}, context)
    this.#framing = framing
    this.#headersSent = true

    const options: SerialiseOptions = serverName === undefined ? {} : { serverName }

    return this.#sink.write(serialiseHead({ ...head, framing }, options))
  }

  #writeBody(body: Buffer): boolean {
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
