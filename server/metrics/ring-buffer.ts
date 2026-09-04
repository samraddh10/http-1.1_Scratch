// module 7.1  server/metrics/ring-buffer.ts -- fixed-size buffer that never grows

export class RingBuffer<T> {
  readonly #slots: (T | undefined)[]

  /** Where the next push goes; one past the newest entry. */
  #next = 0
  #size = 0

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `RingBuffer: capacity must be a positive integer, got ${String(capacity)}`,
      )
    }
    this.#slots = new Array<T | undefined>(capacity).fill(undefined)
  }

  get capacity(): number {
    return this.#slots.length
  }

  /** Entries held, which climbs to `capacity` and stops there. */
  get size(): number {
    return this.#size
  }

  push(item: T): void {
    this.#slots[this.#next] = item
    this.#next = (this.#next + 1) % this.#slots.length
    if (this.#size < this.#slots.length) this.#size++
  }

  /** Newest first, at most `count` of them. */
  recent(count = this.#size): T[] {
    const wanted = Math.min(Math.max(Math.trunc(count), 0), this.#size)
    const out: T[] = []
    for (let i = 1; i <= wanted; i++) {
      // `#next - i` reaches -capacity at the far end of a full buffer, and a negative
      // operand would come back out of `%` negative.
      out.push(this.#slots[(this.#next - i + this.#slots.length) % this.#slots.length] as T)
    }
    return out
  }
}
