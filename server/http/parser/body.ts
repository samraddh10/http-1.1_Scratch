// module 2.4/2.5  server/http/parser/body.ts -- content-length + chunked decoders, trailers

import type { Config } from '../../config.js'
import type { ByteBuffer } from '../../tcp/byte-buffer.js'
import { badRequest, contentTooLarge } from '../errors.js'
import { HeaderSection } from './headers.js'
import { Step } from './states.js'

const CR = 0x0d
const LF = 0x0a

const NO_TRAILERS: Readonly<Record<string, string>> = Object.freeze({})

/** Called with each run of decoded body bytes, in order. */
export type EmitChunk = (chunk: Buffer) => void

/**
 * The two framings behind one shape, so the Body state does not care which it has.
 *
 * Neither decoder ever waits for a whole body. `express.json()` reads the request as a
 * stream, so a decoder that accumulated until the end would hold a megabyte in this process
 * for no reason and defeat the flow control module 5 is built on.
 */
export interface BodyDecoder {
  readonly finished: boolean
  /** The trailer section, empty unless a chunked body sent one. */
  readonly trailers: Readonly<Record<string, string>>
  step(buffer: ByteBuffer, emit: EmitChunk): Step
}

/**
 * Copies bytes out rather than handing out a view.
 *
 * The buffer's backing store is compacted and reused as later chunks arrive, so a view
 * given to the application would change underneath it -- silently, and long after the code
 * that made the mistake has returned.
 */
function takeFrom(buffer: ByteBuffer, count: number): Buffer {
  const chunk = buffer.copy(0, count)
  buffer.consume(count)
  return chunk
}

/** Exactly `length` bytes follow; the only question each time round is how many arrived. */
export class LengthBody implements BodyDecoder {
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

  get trailers(): Readonly<Record<string, string>> {
    return NO_TRAILERS
  }

  step(buffer: ByteBuffer, emit: EmitChunk): Step {
    if (buffer.length === 0) return Step.NeedMore

    const count = Math.min(this.#remaining, buffer.length)
    this.#remaining -= count
    emit(takeFrom(buffer, count))
    return Step.Advanced
  }
}

/** RFC 9112 section 7.1: chunk-size is 1*HEXDIG, and nothing else. */
const HEXDIG = /^[0-9a-fA-F]+$/

/**
 * Where the chunk decoder is. Four of these are blocking positions, and every one of them
 * can be split across TCP reads -- including the size line itself, which is why this is a
 * machine rather than a counter.
 *
 *   Size -> Data -> DataEnd -> Size -> ... -> (size 0) -> Trailers -> Done
 */
const Phase = {
  Size: 'size',
  Data: 'data',
  DataEnd: 'data-end',
  Trailers: 'trailers',
  Done: 'done',
} as const

type Phase = (typeof Phase)[keyof typeof Phase]

export class ChunkedBody implements BodyDecoder {
  readonly #config: Config
  readonly #trailers: HeaderSection

  #phase: Phase = Phase.Size
  #remaining = 0
  #received = 0
  #scanned = 0

  constructor(config: Config) {
    this.#config = config
    // The trailer section is a header section: same grammar, same obs-fold and token rules,
    // same caps. A fresh one, because it is a separate section with a separate budget.
    this.#trailers = new HeaderSection(config)
  }

  get finished(): boolean {
    return this.#phase === Phase.Done
  }

  /** Parsed but not cross-checked against any `Trailer` header -- a stated non-goal. */
  get trailers(): Readonly<Record<string, string>> {
    return this.#trailers.headers
  }

  /** Decoded body bytes so far, across every chunk. */
  get received(): number {
    return this.#received
  }

  step(buffer: ByteBuffer, emit: EmitChunk): Step {
    switch (this.#phase) {
      case Phase.Size:
        return this.#stepSize(buffer)
      case Phase.Data:
        return this.#stepData(buffer, emit)
      case Phase.DataEnd:
        return this.#stepDataEnd(buffer)
      case Phase.Trailers:
        return this.#stepTrailers(buffer)
      case Phase.Done:
        return Step.NeedMore
    }
  }

  #stepSize(buffer: ByteBuffer): Step {
    const end = buffer.indexOfCRLF(this.#scanned)

    if (end === -1) {
      this.#guardLine(buffer.length)
      this.#scanned = Math.max(0, buffer.length - 1)
      return Step.NeedMore
    }
    this.#guardLine(end)

    const size = this.#parseSize(buffer.toLatin1(0, end))
    buffer.consume(end + 2)
    this.#scanned = 0

    if (size === 0) {
      this.#phase = Phase.Trailers
      return Step.Advanced
    }

    // A chunked body declares no total length, so the body cap has to be enforced as it
    // accumulates. Without this, chunked encoding is a plain bypass of the 413 that a
    // Content-Length body is held to.
    if (this.#received + size > this.#config.maxBodyBytes) {
      throw contentTooLarge('chunked body exceeds the configured limit')
    }

    this.#remaining = size
    this.#phase = Phase.Data
    return Step.Advanced
  }

  #stepData(buffer: ByteBuffer, emit: EmitChunk): Step {
    if (buffer.length === 0) return Step.NeedMore

    const count = Math.min(this.#remaining, buffer.length)
    this.#remaining -= count
    this.#received += count
    emit(takeFrom(buffer, count))

    if (this.#remaining === 0) this.#phase = Phase.DataEnd
    return Step.Advanced
  }

  #stepDataEnd(buffer: ByteBuffer): Step {
    if (buffer.length < 2) return Step.NeedMore

    if (buffer.byteAt(0) !== CR || buffer.byteAt(1) !== LF) {
      // The chunk declared its own length, so this CRLF is redundant -- which is exactly
      // why it has to be checked. If it is missing, the size that produced it was wrong,
      // and every byte after this point is being read at the wrong offset.
      throw badRequest('chunk data is not followed by CRLF')
    }

    buffer.consume(2)
    this.#phase = Phase.Size
    return Step.Advanced
  }

  #stepTrailers(buffer: ByteBuffer): Step {
    const end = buffer.indexOfCRLF(this.#scanned)

    if (end === -1) {
      this.#trailers.guardPending(buffer.length)
      this.#scanned = Math.max(0, buffer.length - 1)
      return Step.NeedMore
    }

    if (end === 0) {
      buffer.consume(2)
      this.#scanned = 0
      this.#phase = Phase.Done
      return Step.Advanced
    }

    this.#trailers.add(buffer.toLatin1(0, end))
    buffer.consume(end + 2)
    this.#scanned = 0
    return Step.Advanced
  }

  #guardLine(length: number): void {
    if (length > this.#config.maxChunkLineBytes) {
      throw badRequest('chunk size line exceeds the configured limit')
    }
  }

  #parseSize(line: string): number {
    // chunk = chunk-size [ chunk-ext ] CRLF. Extensions are ignored, but they still have to
    // be cut off before the size is read, or `1a;x` would parse as 0x1a by accident rather
    // than on purpose.
    const semicolon = line.indexOf(';')
    const digits = (semicolon === -1 ? line : line.slice(0, semicolon)).replace(/[ \t]+$/, '')

    // Deliberately not trimmed on the left: the grammar has no whitespace before the size,
    // and accepting some would be one more thing this parser tolerates that a proxy does not.
    if (!HEXDIG.test(digits)) throw badRequest('chunk size is not hexadecimal')

    const size = Number.parseInt(digits, 16)
    if (!Number.isSafeInteger(size)) throw badRequest('chunk size is out of range')
    if (size > this.#config.maxChunkSizeBytes) {
      throw badRequest('chunk size exceeds the configured limit')
    }

    return size
  }
}
