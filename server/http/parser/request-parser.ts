import type { Config } from '../../config.js'
import { config as defaultConfig } from '../../config.js'
import { ByteBuffer } from '../../tcp/byte-buffer.js'
import { ProtocolError, uriTooLong } from '../errors.js'
import type { BodyDecoder } from './body.js'
import { ChunkedBody, LengthBody } from './body.js'
import type { Framing } from './framing.js'
import { decideFraming } from './framing.js'
import type { HeaderSet } from './headers.js'
import { HeaderSection } from './headers.js'
import type { RequestLine } from './request-line.js'
import { parseRequestLine } from './request-line.js'
import type { Target } from './target.js'
import { parseTarget } from './target.js'
import { State, Step, assertTransition } from './states.js'

//Purpose: defines the two optional callback functions a caller can supply to be notified as parsing progresses, instead of the parser returning data directly.
/**
 * Everything known about a request before its body starts: the line, the fields, and from
 * subphase 2.4 the framing decision made from them. This is the event module 5 builds a
 * `ServerRequest` from.
 */
export interface RequestHead extends RequestLine, HeaderSet {
  /** How this request's body is delimited, decided from the fields above. */
  readonly framing: Framing
  /** The percent-decoded path. `target` stays raw, and is what `req.url` becomes. */
  readonly path: string
  /** The query string without its `?`, still encoded for Express's query parser. */
  readonly query: string
}

const EMPTY_TRAILERS: Readonly<Record<string, string>> = Object.freeze({})

export interface ParserHandlers {
  /** The header section is closed and the framing is decided; the body has not started. */
  onHead?(head: RequestHead): void
  /** A run of body bytes. Called any number of times, including with one byte. */
  onBodyChunk?(chunk: Buffer): void
  /**
   * One complete request has been read; the parser is ready for the next one. `trailers` is
   * empty unless a chunked body sent a trailer section.
   */
  onComplete?(trailers: Readonly<Record<string, string>>): void
}

export interface RequestParserOptions extends ParserHandlers {
  /** Limits to enforce. Injected so a test can shrink one cap instead of sending 8 KB. */
  config?: Config
}

//The doc comment above the class states its core contract plainly: push() can be called with any number of bytes — including zero useful bytes, or just one byte 
// — and after each call the parser has either advanced (made progress reading the request) or is waiting, having kept every byte it was given. It is explicitly 
// not a one-call-per-request design in either direction: a single push() call might contain enough bytes to complete two pipelined requests at once,
//  while a single request might take a hundred separate push() calls to fully arrive (for instance, over a slow connection).
export class RequestParser {
  readonly #config: Config
  readonly #handlers: ParserHandlers
  readonly #buffer: ByteBuffer

  #state: State = State.RequestLine
  #error: ProtocolError | undefined
  #requestLine: RequestLine | undefined
  #target: Target | undefined
  #headers: HeaderSection
  #framing: Framing = { kind: 'none' }
  #body: BodyDecoder | undefined

  /**
   * How far the current delimiter scan has already looked. Without it a client dribbling a
   * long line one byte at a time costs O(n^2) work for O(n) bytes, which is the cheap
   * version of the header-bomb attack.
   */
  #scanned = 0

  //Purpose: set up a fresh parser instance, ready to start reading a request line.
  constructor(options: RequestParserOptions = {}) {
    this.#config = options.config ?? defaultConfig
    this.#handlers = options
    this.#buffer = new ByteBuffer()
    this.#headers = new HeaderSection(this.#config)
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

  /** The in-flight request's line, once it has been read. Undefined between requests. */
  get requestLine(): RequestLine | undefined {
    return this.#requestLine
  }

  /** The in-flight request's target, taken apart. Undefined between requests. */
  get target(): Target | undefined {
    return this.#target
  }

  //Purpose: the single entry point for feeding newly-arrived bytes into the parser. 
  // This is the method the connection-handling code calls every time more data arrives on the socket.
  push(chunk: Buffer): void {
    //checks whether this parser has already failed on a previous call.
    if (this.#error !== undefined) {
      throw new Error(
        `RequestParser: push() after ${this.#error.message}; the connection must close`,
      )
    }

    this.#buffer.append(chunk)
    this.#drive()
  }

  //Purpose: repeatedly attempts to process the buffered bytes, one state-step at a time, for as long as each step keeps making progress. 
  // If a step throws a ProtocolError, this method records it and moves the parser into the Error state before letting the error continue propagating up to whoever called push().
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

  //Purpose: looks at the parser's current state and delegates to whichever private method handles that specific state, returning whatever that method returns.
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

  //Purpose: the only place in this class allowed to change #state, and it always checks legality first.
  #transition(to: State): void {
    assertTransition(this.#state, to)
    this.#state = to
  }

  // -- states ----------------------------------------------------------------------------

  //Purpose: look at the bytes currently buffered and try to find a complete request line — bytes up to and including a CRLF (\r\n). If the CRLF hasn't arrived yet, decide whether to keep waiting or give up because the line is already too long.
  #stepRequestLine(): Step {
    const end = this.#buffer.indexOfCRLF(this.#scanned)

    if (end === -1) {
      // No delimiter yet. Refusing here rather than on the finished line is the point: it
      // is what stops a client that never sends a CRLF from buffering without bound.
      if (this.#buffer.length > this.#config.maxRequestLineBytes) throw uriTooLong()
      // Resume one byte back: the CR may be the last byte held and its LF in the next chunk.
      this.#scanned = Math.max(0, this.#buffer.length - 1)
      return Step.NeedMore
    }

    if (end > this.#config.maxRequestLineBytes) throw uriTooLong()

    // Parse before consuming, so a refused line is still in the buffer for module 3 to log.
    const parsed = parseRequestLine(this.#buffer.toLatin1(0, end))
    const target = parseTarget(parsed.target, parsed.method)

    this.#buffer.consume(end + 2)
    this.#scanned = 0
    this.#requestLine = parsed
    this.#target = target
    this.#transition(State.Headers)
    return Step.Advanced
  }

  #stepHeaders(): Step {
    const end = this.#buffer.indexOfCRLF(this.#scanned)

    if (end === -1) {
      this.#headers.guardPending(this.#buffer.length)
      this.#scanned = Math.max(0, this.#buffer.length - 1)
      return Step.NeedMore
    }

    if (end === 0) {
      this.#buffer.consume(2)
      this.#scanned = 0
      this.#closeHead()
      return Step.Advanced
    }

    // One line per step rather than a loop over all of them: the drive loop is the loop,
    // and a step that returns after each line cannot leave a half-read line behind.
    this.#headers.add(this.#buffer.toLatin1(0, end))
    this.#buffer.consume(end + 2)
    this.#scanned = 0
    return Step.Advanced
  }

  #closeHead(): void {
    const requestLine = this.#requestLine
    if (requestLine === undefined) throw new Error('RequestParser: headers without a request line')

    const target = this.#target
    if (target === undefined) throw new Error('RequestParser: headers without a target')

    const headerSet = this.#headers.finish(requestLine)

    // RFC 9112 section 3.2.2: an origin server given an absolute-form target MUST use the
    // authority from the target and ignore the Host field. Two sources naming the host is
    // the same disagreement the framing rules refuse; here the RFC names which one wins.
    if (target.authority !== undefined) headerSet.headers['host'] = target.authority

    const framing = decideFraming(requestLine, headerSet.headers, this.#config)

    this.#framing = framing
    this.#handlers.onHead?.({
      ...requestLine,
      ...headerSet,
      framing,
      path: target.path,
      query: target.query,
    })

    if (framing.kind === 'none') {
      this.#transition(State.Complete)
      return
    }

    this.#body =
      framing.kind === 'length' ? new LengthBody(framing.length) : new ChunkedBody(this.#config)
    this.#transition(State.Body)
  }

  #stepBody(): Step {
    const body = this.#body
    if (body === undefined) throw new Error('RequestParser: body state with no decoder')

    if (body.finished) {
      this.#transition(State.Complete)
      return Step.Advanced
    }

    return body.step(this.#buffer, (chunk) => this.#handlers.onBodyChunk?.(chunk))
  }

  #stepComplete(): Step {
    // Read before the reset below: the trailers belong to the request being completed.
    this.#handlers.onComplete?.(this.#body?.trailers ?? EMPTY_TRAILERS)

    this.#requestLine = undefined
    this.#target = undefined
    this.#headers = new HeaderSection(this.#config)
    this.#framing = { kind: 'none' }
    this.#body = undefined
    this.#scanned = 0
    // The buffer is deliberately left alone: whatever follows is the next pipelined
    // request, and the very next loop iteration starts reading it.
    this.#transition(State.RequestLine)
    return Step.Advanced
  }
}
