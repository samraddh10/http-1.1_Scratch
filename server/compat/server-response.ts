import type { ServerResponse as NodeServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { Writable } from 'node:stream'

import type { Connection } from '../tcp/connection.js'
import type { HeaderValue, OutgoingHeaders, ResponseHead } from '../http/response/writer.js'
import { ResponseWriter } from '../http/response/writer.js'
import { pinToInstance } from './own-props.js'

const WRITABLE_MEMBERS: readonly string[] = Object.getOwnPropertyNames(Writable.prototype).filter(
  (name) => name !== 'constructor',
)

const DECLARED = [
  'write',
  'end',
  '_write',
  '_final',
  'writeHead',
  'flushHeaders',
  'setHeader',
  'getHeader',
  'getHeaders',
  'getHeaderNames',
  'hasHeader',
  'removeHeader',
  'headersSent',
  'finished',
  '_header',
  'abort',
] as const satisfies readonly (keyof ServerResponse & string)[]

const PINNED: readonly string[] = [...WRITABLE_MEMBERS, ...DECLARED]

export interface ServerResponseOptions {
  readonly writer: ResponseWriter
  readonly tcp: Connection
}

//Purpose: build the exact error Node itself throws when you try to mutate headers after they've gone out, so any code checking err.code === 'ERR_HTTP_HEADERS_SENT' works identically here.
function headersSentError(what: string): Error {
  const error = new Error(`wirehttp: cannot ${what} after they are sent`)
  Object.assign(error, { code: 'ERR_HTTP_HEADERS_SENT' })
  return error
}

export class ServerResponse extends Writable {
  statusCode = 200
  statusMessage = ''

  readonly socket: Socket

  readonly #writer: ResponseWriter
  readonly #tcp: Connection

  readonly #headers = new Map<string, { name: string; value: HeaderValue }>()

  constructor(options: ServerResponseOptions) {
    super()

    this.#writer = options.writer
    this.#tcp = options.tcp
    this.socket = options.tcp.socket

    pinToInstance(this, PINNED)
  }

  get headersSent(): boolean {
    return this.#writer.headersSent
  }

  get _header(): string | null {
    return this.#writer.head?.toString('latin1') ?? null
  }

  get finished(): boolean {
    return this.writableEnded
  }

  setHeader(name: string, value: HeaderValue): this {
    if (this.headersSent) throw headersSentError('set headers')
    this.#headers.set(name.toLowerCase(), { name, value })
    return this
  }

  getHeader(name: string): string | number | string[] | undefined {
    const field = this.#headers.get(name.toLowerCase())
    return field === undefined ? undefined : detachedValue(field.value)
  }

  getHeaderNames(): string[] {
    return [...this.#headers.keys()]
  }

  getHeaders(): Record<string, string | number | string[]> {
    const headers = Object.create(null) as Record<string, string | number | string[]>
    for (const [lower, field] of this.#headers) headers[lower] = detachedValue(field.value)
    return headers
  }

  hasHeader(name: string): boolean {
    return this.#headers.has(name.toLowerCase())
  }

  removeHeader(name: string): void {
    if (this.headersSent) throw headersSentError('remove headers')
    this.#headers.delete(name.toLowerCase())
  }

  writeHead(status: number, reason?: string | OutgoingHeaders, headers?: OutgoingHeaders): this {
    if (typeof reason === 'string') this.statusMessage = reason
    const extra = typeof reason === 'object' ? reason : headers

    this.statusCode = status
    for (const [name, value] of Object.entries(extra ?? {})) this.setHeader(name, value)

    this.#flushHead()
    return this
  }

  flushHeaders(): void {
    this.#flushHead()
  }

  override end(chunk?: unknown, encoding?: unknown, callback?: unknown): this {
    if (!this.headersSent) {
      const body = typeof chunk === 'function' || chunk === null ? undefined : chunk
      const bodyEncoding = typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'
      this.#flushHead(byteLengthOf(body, bodyEncoding))
    }

    return super.end(chunk as never, encoding as never, callback as never)
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    if (!this.headersSent) this.#flushHead()

    try {
      this.#settle(this.#writer.write(chunk), done)
    } catch (thrown) {
      done(thrown as Error)
    }
  }

  override _final(done: (error?: Error | null) => void): void {
    if (!this.headersSent) this.#flushHead(0)

    try {
      this.#settle(this.#writer.end(), done)
    } catch (thrown) {
      done(thrown as Error)
    }
  }

  abort(): void {
    if (this.destroyed) return
    this.destroy()
  }

  #settle(accepted: boolean, done: (error?: Error | null) => void): void {
    if (accepted) {
      done()
      return
    }

    this.#tcp.whenDrained().then(
      () => done(),
      () => this.abort(),
    )
  }

  #flushHead(knownLength?: number): void {
    if (this.headersSent) return

    const headers = this.#outgoingHeaders()

    const framed = this.#headers.has('content-length') || this.#headers.has('transfer-encoding')
    if (knownLength !== undefined && !framed) headers['Content-Length'] = knownLength

    const head: ResponseHead = {
      status: this.statusCode,
      headers,
      ...(this.statusMessage === '' ? {} : { reason: this.statusMessage }),
    }

    this.#writer.writeHead(head)
  }

  #outgoingHeaders(): Record<string, HeaderValue> {
    const headers: Record<string, HeaderValue> = {}
    for (const field of this.#headers.values()) headers[field.name] = field.value
    return headers
  }
}

function detachedValue(value: HeaderValue): string | number | string[] {
  return Array.isArray(value) ? [...value] : (value as string | number)
}

function byteLengthOf(body: unknown, encoding: BufferEncoding): number {
  if (body === undefined) return 0
  if (typeof body === 'string') return Buffer.byteLength(body, encoding)
  if (Buffer.isBuffer(body)) return body.length
  throw new TypeError('wirehttp: res.end() takes a string or a Buffer')
}

type Conforms<T extends U, U> = T
type _ResponseConformsToNode = Conforms<
  ServerResponse,
  Pick<
    NodeServerResponse,
    | 'statusCode'
    | 'statusMessage'
    | 'socket'
    | 'headersSent'
    | 'finished'
    | 'getHeader'
    | 'getHeaders'
    | 'getHeaderNames'
    | 'hasHeader'
    | 'removeHeader'
    | 'flushHeaders'
    | 'write'
    | 'writable'
  >
>

type _AcceptsNodesSetHeaderArguments = Conforms<
  Parameters<NodeServerResponse['setHeader']>,
  Parameters<ServerResponse['setHeader']>
>
type _AcceptsNodesEndArguments = Conforms<
  Parameters<NodeServerResponse['end']>,
  Parameters<ServerResponse['end']>
>
