import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
//A real runtime import — this is the base class.
import { Readable } from 'node:stream'

import type { RequestHead } from '../http/parser/request-parser.js'
import type { Connection } from '../tcp/connection.js'
import { pinToInstance, refuseMembers } from './own-props.js'

//The default argument for completeBody(). Three things going on:
//Object.freeze({}) makes an empty object that can never gain properties.
//It's a module-level singleton, so calling completeBody() with no argument doesn't allocate a new {} on every request.
//Readonly<Record<string, string>> tells the compiler the same thing freeze tells the runtime.
const NO_TRAILERS: Readonly<Record<string, string>> = Object.freeze({})

export interface ServerRequestOptions {
  readonly head: RequestHead
  readonly tcp: Connection
  onDemandChange?(wantsMore: boolean): void
}

const PINNED = [
  '_read',
  '_destroy',
  'receiveBody',
  'completeBody',
  'abort',
] as const satisfies readonly (keyof ServerRequest & string)[]


const UNSUPPORTED: PropertyDescriptorMap = {
  ...refuseMembers(['setTimeout']),
  ...refuseMembers(['headersDistinct', 'trailersDistinct'], 'property'),
}

export class ServerRequest extends Readable {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly rawHeaders: string[]
  readonly httpVersion: '1.0' | '1.1'
  readonly httpVersionMajor: number
  readonly httpVersionMinor: number

  readonly socket: Socket
  readonly connection: Socket

  complete = false

  readonly upgrade = false

  trailers: Record<string, string> = {}

  readonly #onDemandChange: ((wantsMore: boolean) => void) | undefined
  #wantsMore = false

  constructor(options: ServerRequestOptions) {
    super()

    const { head, tcp } = options

    this.method = head.method
    this.url = head.target
    this.headers = head.headers
    this.rawHeaders = head.rawHeaders
    this.httpVersion = head.httpVersion
    this.httpVersionMajor = head.httpVersionMajor
    this.httpVersionMinor = head.httpVersionMinor

    this.socket = tcp.socket
    this.connection = tcp.socket

    this.#onDemandChange = options.onDemandChange

    pinToInstance(this, PINNED)
    Object.defineProperties(this, UNSUPPORTED)
  }

  override _read(): void {
    this.#setDemand(true)
  }

  receiveBody(chunk: Buffer): void {
    if (this.destroyed) return
    if (!this.push(chunk)) this.#setDemand(false)
  }

  completeBody(trailers: Readonly<Record<string, string>> = NO_TRAILERS): void {
    if (this.complete || this.destroyed) return

    this.trailers = { ...trailers }
    this.complete = true
    this.push(null)
  }

  abort(): void {
    if (this.complete || this.destroyed) return

    this.emit('aborted')
    this.destroy()
  }

  //Purpose: the single place where demand state changes, so the callback is invoked once per transition rather than once per observation.
  #setDemand(wantsMore: boolean): void {
    if (this.#wantsMore === wantsMore) return
    this.#wantsMore = wantsMore
    this.#onDemandChange?.(wantsMore)
  }
}

type Conforms<T extends U, U> = T
type _RequestConformsToNode = Conforms<
  ServerRequest,
  Pick<
    IncomingMessage,
    | 'method'
    | 'url'
    | 'headers'
    | 'rawHeaders'
    | 'httpVersion'
    | 'httpVersionMajor'
    | 'httpVersionMinor'
    | 'socket'
    | 'connection'
    | 'complete'
    | 'trailers'
    | 'readable'
  >
>
