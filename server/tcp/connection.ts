// module 1.2/1.4  server/tcp/connection.ts -- per-socket state, lifecycle, timers, write path

import type { Socket } from 'node:net'

import { config } from '../config.js'

export type CloseReason =
  | 'client-end'
  | 'client-error'
  | 'idle-timeout'
  | 'server-shutdown'
  /** The exchange that just finished was the connection's last -- module 4 decided so. */
  | 'end-of-exchange'

/** Called when a written chunk has been handed to the OS, or when it never will be. */
export type FlushCallback = (error?: Error) => void

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
  #drainWaiters: { resolve: () => void; reject: (error: Error) => void }[] = []
  #closeIntent: CloseReason | undefined

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
    socket.on('drain', () => this.#drained())
    socket.on('timeout', () => this.destroy('idle-timeout'))

    // After end() the peer answers our FIN with its own, so the last event to arrive is a
    // normal client disconnect and would otherwise be reported as one. Both of these are
    // the same teardown; whichever wins the race must still name the close we initiated.
    socket.on('end', () => this.destroy(this.#closeIntent ?? 'client-end'))
    socket.on('close', () => this.destroy(this.#closeIntent ?? 'client-end'))

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

  /** True while `write()` will still accept bytes. */
  get writable(): boolean {
    return !this.closed && this.socket.writable
  }

  /** True once a write has been refused and the drain has not arrived yet. */
  get needsDrain(): boolean {
    return !this.closed && this.socket.writableNeedDrain
  }

  /** Bytes accepted by `write()` that the OS has not taken yet. */
  get pendingBytes(): number {
    return this.closed ? 0 : this.socket.writableLength
  }

  /** True while the read side is stopped and arriving bytes are left in the kernel. */
  get paused(): boolean {
    return !this.closed && this.socket.isPaused()
  }

  touch(): void {
    this.lastActivityAt = Date.now()
  }

  /**
   * Stops reading. This is backpressure in the other direction from `write()`: a client
   * that pipelines requests faster than they are answered would otherwise have every one
   * of them parsed and queued in this process, so the read side stops until the queue
   * drains and the unread bytes stay in the client's send buffer, where they cost it
   * memory rather than the server.
   */
  pause(): void {
    if (!this.closed) this.socket.pause()
  }

  resume(): void {
    if (!this.closed) this.socket.resume()
  }

  /**
   * Sends bytes to the client.
   *
   * Returns false when the producer should stop and wait for `whenDrained()`. That return
   * value is the entire point of this method and must not be ignored: `socket.write()`
   * does not put bytes on the network, it copies them into a send buffer, and once that
   * buffer is full every further write is held in this process instead. A client that
   * connects and then stops reading -- a phone on a dead train, or an attacker doing it
   * deliberately -- will otherwise pull an entire response into memory, times every
   * connection in the registry.
   *
   * `onFlush` fires when this chunk reaches the OS, or with an error if it never does.
   */
  write(data: Buffer | string, onFlush?: FlushCallback): boolean {
    if (!this.writable) {
      onFlush?.(new Error(`wirehttp: write on a connection that is ${this.closed ? 'closed' : 'ending'}`))
      return false
    }

    const bytes = typeof data === 'string' ? Buffer.from(data, 'latin1') : data
    this.bytesWritten += bytes.length
    this.touch()

    // The queue behind this call is the socket's own, not a second one here. It already
    // preserves order and reports fullness; a queue at this level could only duplicate
    // that and find new ways to reorder a response.
    return onFlush
      ? this.socket.write(bytes, (error) => onFlush(error ?? undefined))
      : this.socket.write(bytes)
  }

  /**
   * Resolves when the socket will accept writes again, and rejects if the connection dies
   * first. This is the seam module 5 plugs into: `ServerResponse._write` withholds its
   * callback until this settles, which is what makes `stream.pipe(res)` pause a file read
   * instead of buffering the file.
   */
  whenDrained(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error(`wirehttp: connection closed while draining (${this.closeReason})`))
    }
    if (!this.socket.writableNeedDrain) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      this.#drainWaiters.push({ resolve, reject })
    })
  }

  /**
   * Closes once everything already written has been flushed.
   *
   * `destroy()` discards whatever is still queued, which for a response written
   * immediately before it means the client gets a reset instead of the response. Every
   * server-initiated close that follows a response -- 3.4's protocol errors, 4.1's
   * `Connection: close` -- goes through here.
   */
  end(reason: CloseReason = 'server-shutdown'): void {
    if (this.closed || this.#closeIntent !== undefined) return

    this.#closeIntent = reason
    // The idle timeout stays armed: if the peer never reads, the flush never completes
    // and this is the only thing that reclaims the socket.
    this.socket.end()
  }

  destroy(reason: CloseReason): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason

    this.socket.setTimeout(0)
    this.socket.destroy()

    this.#settleDrainWaiters(new Error(`wirehttp: connection closed (${reason})`))
    this.#handlers.onClose?.(this, reason)
  }

  #receive(chunk: Buffer): void {
    if (this.closed) return

    this.bytesRead += chunk.length
    this.touch()
    this.#handlers.onData?.(this, chunk)
  }

  #drained(): void {
    // A drain means bytes actually left for the peer, which is activity: a slow but live
    // reader must not be timed out as idle.
    this.touch()
    this.#settleDrainWaiters()
  }

  #settleDrainWaiters(error?: Error): void {
    const waiting = this.#drainWaiters
    this.#drainWaiters = []
    for (const waiter of waiting) {
      if (error) waiter.reject(error)
      else waiter.resolve()
    }
  }
}
