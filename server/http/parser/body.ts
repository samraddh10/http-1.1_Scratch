// module 2.4/2.5  server/http/parser/body.ts -- content-length + chunked decoders, trailers

import type { ByteBuffer } from '../../tcp/byte-buffer.js'

/**
 * The simple framing: exactly `length` bytes follow, and the only question each time round
 * is how many of them have arrived.
 *
 * It never waits for the whole body. `express.json()` reads the request as a stream, so a
 * decoder that buffered until the declared length was complete would hold a megabyte in
 * this process for no reason and defeat the flow control module 5 is built on.
 */
export class LengthBody {
  #remaining: number

  constructor(length: number) {
    this.#remaining = length
  }

  get remaining(): number {
    return this.#remaining
  }

  get finished(): boolean {
    return this.#remaining === 0
  }

  /**
   * Takes up to `remaining` bytes off the front of the buffer.
   *
   * Copies rather than returning a view. The buffer's backing store is reused and compacted
   * as later chunks arrive, so a view handed to the application would change underneath it
   * -- silently, and long after the code that made the mistake has returned.
   */
  take(buffer: ByteBuffer): Buffer {
    const count = Math.min(this.#remaining, buffer.length)
    const chunk = buffer.copy(0, count)

    buffer.consume(count)
    this.#remaining -= count
    return chunk
  }
}
