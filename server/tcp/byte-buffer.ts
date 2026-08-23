const CR = 0x0d
const LF = 0x0a

const INITIAL_CAPACITY = 4_096

//If the internal buffer has grown to more than 4 times its original starting size, and it then becomes completely empty, it gets shrunk back down to its original size instead of staying large forever.
const SHRINK_FACTOR = 4

export class ByteBuffer {
  //the actual block of memory holding the data.
  #bytes: Buffer
  #start = 0
  #end = 0

  readonly #initialCapacity: number

  constructor(initialCapacity: number = INITIAL_CAPACITY) {
    if (!Number.isInteger(initialCapacity) || initialCapacity <= 0) {
      throw new RangeError(
        `ByteBuffer: initialCapacity must be a positive integer, got ${String(initialCapacity)}`,
      )
    }
    this.#initialCapacity = initialCapacity
    this.#bytes = Buffer.allocUnsafe(initialCapacity)
  }

  get length(): number {
    return this.#end - this.#start
  }

  get capacity(): number {
    return this.#bytes.length
  }

  //Purpose: Add a new chunk of bytes (as received from the network) to the end of the held data.
  append(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.#makeRoom(chunk.length)
    chunk.copy(this.#bytes, this.#end)
    this.#end += chunk.length
  }

  //Purpose: Read the value of a single byte at a given position, returning undefined instead of throwing if the position is out of range.
  byteAt(index: number): number | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined
    return this.#bytes[this.#start + index]
  }

  //Purpose: Find the position of the first occurrence of a specific byte value, starting the search at a given offset. Returns -1 if the byte is not found in the valid data.
  indexOf(byte: number, from = 0): number {
    this.#checkOffset(from)
    const at = this.#bytes.indexOf(byte, this.#start + from)
    return at === -1 || at >= this.#end ? -1 : at - this.#start
  }

  //Purpose: Search for the next complete \r\n (CRLF) in the buffer starting from a given position. If \r and \n arrive separately in different TCP chunks, 
  // it waits until both are present. Returns the position of \r, or -1 if the complete \r\n hasn't arrived yet.
  indexOfCRLF(from = 0): number {
    this.#checkOffset(from)
    //at is set to the real starting search position.
    let at = this.#start + from
    for (;;) {
      const cr = this.#bytes.indexOf(CR, at)
      if (cr === -1 || cr >= this.#end) return -1
      if (cr + 1 >= this.#end) return -1
      if (this.#bytes[cr + 1] === LF) return cr - this.#start
      at = cr + 1
    }
  }

  //Purpose: Look at a range of bytes without copying memory and without removing them from the buffer.
  peek(from = 0, to = this.length): Buffer {
    this.#checkRange(from, to)
    return this.#bytes.subarray(this.#start + from, this.#start + to)
  }

  //Purpose: Like peek, but returns an independent copy of the bytes, which remains valid even after later operations change the internal buffer.
  copy(from = 0, to = this.length): Buffer {
    this.#checkRange(from, to)
    return Buffer.from(this.#bytes.subarray(this.#start + from, this.#start + to))
  }

  //Purpose: Convert a byte range into a JavaScript string, decoded as latin1. Unlike peek and copy, both from and to are required here with no default — 
  // the caller must specify exactly which bytes to decode, because turning bytes into a string before knowing where a field actually ends is exactly what this class is meant to prevent.
  toLatin1(from: number, to: number): string {
    this.#checkRange(from, to)
    return this.#bytes.toString('latin1', this.#start + from, this.#start + to)
  }

  //Purpose: Mark the first count bytes as processed and drop them from the front of the buffer. This is a cheap, constant-time operation
  consume(count: number): void {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`ByteBuffer: consume(${String(count)}) is not a byte count`)
    }
    if (count > this.length) {
      throw new RangeError(`ByteBuffer: consume(${count}) with only ${this.length} byte(s) held`)
    }

    this.#start += count
    if (this.#start === this.#end) this.reset()
  }

  //Purpose: Clear all data from the buffer and make it ready to use again. If the buffer became much larger than its original size, 
  // replace it with a smaller buffer so the server doesn't keep wasting memory after a large request.
  reset(): void {
    this.#start = 0
    this.#end = 0
    if (this.#bytes.length > this.#initialCapacity * SHRINK_FACTOR) {
      this.#bytes = Buffer.allocUnsafe(this.#initialCapacity)
    }
  }

  //Purpose: Make sure there is enough space to add new bytes. It first reuses space freed by consume(). If there still isn't enough space, it creates a larger buffer.
  #makeRoom(need: number): void {
    if (this.#end + need <= this.#bytes.length) return

    const live = this.length

    if (live + need <= this.#bytes.length) {
      this.#bytes.copyWithin(0, this.#start, this.#end)
    } else {
      let capacity = this.#bytes.length * 2
      while (capacity < live + need) capacity *= 2
      const grown = Buffer.allocUnsafe(capacity)
      this.#bytes.copy(grown, 0, this.#start, this.#end)
      this.#bytes = grown
    }

    this.#start = 0
    this.#end = live
  }

  //This function checks whether a given position (from) is valid inside the buffer.
  #checkOffset(from: number): void {
    if (!Number.isInteger(from) || from < 0 || from > this.length) {
      throw new RangeError(
        `ByteBuffer: offset ${String(from)} is outside 0..${this.length}`,
      )
    }
  }

  //Purpose: Checks whether a given byte range is valid. It makes sure from and to are whole numbers, from isn't negative, to isn't before from, 
  // and to doesn't go beyond the buffer's length. If anything is invalid, it throws a RangeError.
  #checkRange(from: number, to: number): void {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > this.length) {
      throw new RangeError(
        `ByteBuffer: range [${String(from)}, ${String(to)}) is outside 0..${this.length}`,
      )
    }
  }
}
