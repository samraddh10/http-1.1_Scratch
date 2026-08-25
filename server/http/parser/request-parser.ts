// module 2.1  server/http/parser/request-parser.ts -- the state machine; push(chunk) -> events

import type { Config } from '../../config.js'
import { config as defaultConfig } from '../../config.js'
import { ByteBuffer } from '../../tcp/byte-buffer.js'
import { ProtocolError, uriTooLong } from '../errors.js'
import { State, assertTransition } from './states.js'

/**
 * What one state step reports back to the drive loop.
 *
 * `NeedMore` carries an obligation: a step that returns it must have consumed nothing, so
 * that the next chunk sees the same bytes plus more. Half-consuming and then asking for
 * more bytes is how a parser loses a field boundary.
 */
export const Step = {
  Advanced: 'advanced',
  NeedMore: 'need-more',
} as const

export type Step = (typeof Step)[keyof typeof Step]

export interface ParserHandlers {
  /** A run of body bytes. Called any number of times, including with one byte. */
  onBodyChunk?(chunk: Buffer): void
  /** One complete request has been read; the parser is ready for the next one. */
  onComplete?(): void
}

export interface RequestParserOptions extends ParserHandlers {
  /** Limits to enforce. Injected so a test can shrink one cap instead of sending 8 KB. */
  config?: Config
}

/**
 * Turns an arbitrarily chunked byte stream into requests.
 *
 * The contract that everything else rests on: `push()` may be called with any number of
 * bytes, including a single byte or none of use, and the parser answers either by
 * advancing or by keeping every byte it was given and waiting. It is not "one call, one
 * request" in either direction -- one push can complete two pipelined requests, and one
 * request can take a hundred pushes.
 */
export class RequestParser {
  readonly #config: Config
  readonly #handlers: ParserHandlers
  readonly #buffer: ByteBuffer

  #state: State = State.RequestLine
  #error: ProtocolError | undefined

  constructor(options: RequestParserOptions = {}) {
    this.#config = options.config ?? defaultConfig
    this.#handlers = options
    this.#buffer = new ByteBuffer()
  }

  get state(): State {
    return this.#state
  }

  /** Bytes held that have not yet been interpreted. */
  get buffered(): number {
    return this.#buffer.length
  }

  /** The error that stopped this parser, if one did. */
  get error(): ProtocolError | undefined {
    return this.#error
  }

  /**
   * Feeds bytes in. Returns normally when the parser needs more; throws a `ProtocolError`
   * carrying the status and the close-or-not flag when the input cannot be interpreted.
   */
  push(chunk: Buffer): void {
    if (this.#error !== undefined) {
      throw new Error(
        `RequestParser: push() after ${this.#error.message}; the connection must close`,
      )
    }

    this.#buffer.append(chunk)
    this.#drive()
  }

  #drive(): void {
    try {
      while (this.#step() === Step.Advanced) {
        // each step either advances or blocks, so this terminates on the first NeedMore
      }
    } catch (thrown) {
      if (thrown instanceof ProtocolError) {
        this.#error = thrown
        this.#transition(State.Error)
      }
      throw thrown
    }
  }

  #step(): Step {
    switch (this.#state) {
      case State.RequestLine:
        return this.#stepRequestLine()
      case State.Headers:
        return this.#stepHeaders()
      case State.Body:
        return this.#stepBody()
      case State.Complete:
        return this.#stepComplete()
      case State.Error:
        return Step.NeedMore
    }
  }

  #transition(to: State): void {
    assertTransition(this.#state, to)
    this.#state = to
  }

  // -- states ----------------------------------------------------------------------------

  #stepRequestLine(): Step {
    // Subphase 2.2 finds the CRLF and splits the line here. Until then the only thing this
    // state can decide is that the line has already run too long to be one, which is the
    // check that keeps a client dribbling bytes with no delimiter from buffering forever.
    if (this.#buffer.length > this.#config.maxRequestLineBytes) throw uriTooLong()
    return Step.NeedMore
  }

  #stepHeaders(): Step {
    return Step.NeedMore // subphase 2.3
  }

  #stepBody(): Step {
    return Step.NeedMore // subphases 2.4 and 2.5
  }

  #stepComplete(): Step {
    this.#handlers.onComplete?.()
    // The buffer is deliberately left alone: whatever follows is the next pipelined
    // request, and the very next loop iteration starts reading it.
    this.#transition(State.RequestLine)
    return Step.Advanced
  }
}
