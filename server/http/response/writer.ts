// module 3.1  server/http/response/writer.ts -- status line, header block, Date cache
//
// 3.2 adds framing to this file and 3.3 the bodyless rules. Until then `write()` is a raw
// pass-through: it puts the caller's bytes on the wire without deciding how they end.

import { config } from '../../config.js'
import { hasForbiddenFieldByte, isToken } from '../parser/tokens.js'
import { isInformational, isValidStatus, reasonPhrase } from './status.js'

/** A number is accepted because Content-Length is one everywhere it is produced. */
export type HeaderValue = string | number | readonly string[]

export type OutgoingHeaders = Readonly<Record<string, HeaderValue>>

export interface ResponseHead {
  readonly status: number
  /** Replaces the table's phrase. Express writes one through `res.statusMessage`. */
  readonly reason?: string
  /** Sent in insertion order after Date and Server; an array sends one field line each. */
  readonly headers?: OutgoingHeaders
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

  const supplied = new Set<string>()
  for (const name of Object.keys(head.headers ?? {})) supplied.add(name.toLowerCase())

  // RFC 9110 section 6.6.1: an origin server with a clock MUST send Date on 2xx, 3xx and
  // 4xx, and MAY on 1xx. An interim response is a bare status line and nothing else, which
  // is what 4.4 writes before the request body has even been read.
  if (!isInformational(status)) {
    if (!supplied.has('date')) text += `Date: ${imfFixdate(options.now)}\r\n`
    if (!supplied.has('server')) text += `Server: ${options.serverName ?? config.serverName}\r\n`
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
}

/**
 * One response, written onto one sink.
 *
 * The sink is an interface rather than a `Connection` so module 3 does not depend on module
 * 1, and so a test can assert on the bytes without opening a socket.
 */
export class ResponseWriter {
  readonly #sink: ByteSink
  readonly #options: ResponseWriterOptions

  #headersSent = false
  #finished = false

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

  /** Writes the status line and header block. Returns false when the sink wants a drain. */
  writeHead(head: ResponseHead): boolean {
    if (this.#headersSent) throw new Error('wirehttp: writeHead() called twice on one response')
    this.#headersSent = true
    return this.#sink.write(serialiseHead(head, this.#options))
  }

  write(chunk: Buffer | string): boolean {
    if (!this.#headersSent) throw new Error('wirehttp: write() before writeHead()')
    if (this.#finished) throw new Error('wirehttp: write() after end()')
    return this.#sink.write(chunk)
  }

  end(chunk?: Buffer | string): boolean {
    if (this.#finished) throw new Error('wirehttp: end() called twice on one response')
    const accepted = chunk === undefined ? true : this.write(chunk)
    this.#finished = true
    return accepted
  }
}
