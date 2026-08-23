// module 1.2  server/tcp/connection.ts -- per-socket state object, lifecycle, timers

import type { Socket } from 'node:net'

import { config } from '../config.js'

export type CloseReason = 'client-end' | 'client-error' | 'idle-timeout' | 'server-shutdown'

export interface ConnectionHandlers {
  //onData — called when data arrives, passing the Connection and the received Buffer (raw bytes)
  onData?(connection: Connection, chunk: Buffer): void
  //onClose — called when the connection ends, passing the Connection and the reason it closed
  onClose?(connection: Connection, reason: CloseReason): void
}

export interface ConnectionOptions extends ConnectionHandlers {
    //the number of milliseconds of inactivity allowed before the connection is considered timed out.
  idleTimeoutMs?: number
}

let nextId = 1

export class Connection {
  readonly id: number
  readonly socket: Socket
  readonly openedAt: number

  lastActivityAt: number
  bytesRead = 0
  bytesWritten = 0
  requestsServed = 0

  closed = false
  closeReason: CloseReason | undefined
  error: Error | undefined

  readonly #handlers: ConnectionHandlers

  constructor(socket: Socket, options: ConnectionOptions = {}) {
    const now = Date.now()

    this.id = nextId++
    this.socket = socket
    this.openedAt = now
    this.lastActivityAt = now
    this.#handlers = options

    //This tells the socket: "if no data is sent or received for ms milliseconds, emit a 'timeout' event."
    socket.setTimeout(options.idleTimeoutMs ?? config.idleTimeoutMs)

    //Whenever the client sends data, Node fires a 'data' event on the socket with the bytes as a Buffer
    socket.on('data', (chunk: Buffer) => this.#receive(chunk))
    socket.on('end', () => this.destroy('client-end'))
    socket.on('timeout', () => this.destroy('idle-timeout'))
    socket.on('close', () => this.destroy('client-end'))

    // 'error' and 'close' are deliberately the same event with the same cleanup. An
    // abrupt client disconnect arrives as ECONNRESET on Windows where Linux delivers a
    // clean FIN, and both are followed by 'close'; nothing above this line may depend on
    // which of them landed first, or on how many of them landed at all.
    socket.on('error', (error: Error) => {
      this.error = error
      this.destroy('client-error')
    })
  }

  get idleMs(): number {
    return Date.now() - this.lastActivityAt
  }

  get ageMs(): number {
    return Date.now() - this.openedAt
  }

  //Purpose: Resets the idle clock by updating lastActivityAt to right now.
  touch(): void {
    this.lastActivityAt = Date.now()
  }

  //Purpose: Safely sends data out to the client, while updating byte-count stats and the idle timer, and refusing to write if the connection is already closed.
  write(data: Buffer | string): boolean {
    if (this.closed) return false

    const bytes = typeof data === 'string' ? Buffer.from(data, 'latin1') : data
    this.bytesWritten += bytes.length
    this.touch()
    return this.socket.write(bytes)
  }

  destroy(reason: CloseReason): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason

    this.socket.setTimeout(0)
    this.socket.destroy()

    this.#handlers.onClose?.(this, reason)
  }

  //Purpose: A private method that runs every time raw data arrives on the socket. It updates byte-count stats, resets the idle timer, and hands the data off to the external onData handler.
  #receive(chunk: Buffer): void {
    if (this.closed) return

    this.bytesRead += chunk.length
    this.touch()
    this.#handlers.onData?.(this, chunk)
  }
}
