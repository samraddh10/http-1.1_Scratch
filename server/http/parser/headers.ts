// module 2.3  server/http/parser/headers.ts -- field parsing, duplicate policy, obs-fold

import type { Config } from '../../config.js'
import { badRequest, headerFieldsTooLarge } from '../errors.js'
import type { RequestLine } from './request-line.js'
import { hasForbiddenFieldByte, isToken, trimOWS } from './tokens.js'

export interface HeaderSet {
  /** Names lowercased, duplicates resolved. This is what `req.headers` becomes. */
  readonly headers: Record<string, string>
  /** Every field line as sent, `[name, value, name, value, ...]`, original casing and order. */
  readonly rawHeaders: string[]
}

type DuplicatePolicy = 'join' | 'join-cookie' | 'first' | 'reject' | 'reject-conflict'

/**
 * Fields where a duplicate is silently dropped rather than joined. Taken from the list
 * Node's own parser uses, so that `req.headers` looks the same to Express either way --
 * `host` and `content-length` are handled separately below because a duplicate of those is
 * refused rather than dropped.
 */
const SINGLETON = new Set([
  'age',
  'authorization',
  'content-type',
  'etag',
  'expires',
  'from',
  'if-modified-since',
  'if-unmodified-since',
  'last-modified',
  'location',
  'max-forwards',
  'proxy-authorization',
  'referer',
  'retry-after',
  'server',
  'user-agent',
])

function policyFor(name: string): DuplicatePolicy {
  // RFC 9112 section 3.2: a server MUST reject a request with more than one Host field.
  // Which Host wins is precisely the disagreement that routes a request to the wrong
  // virtual host on one hop and the right one on the next.
  if (name === 'host') return 'reject'
  // RFC 9112 section 6.3: disagreeing lengths make the framing unrecoverable. Identical
  // repeats are explicitly allowed to collapse to one.
  if (name === 'content-length') return 'reject-conflict'
  // RFC 6265 section 5.4 separates cookie-pairs with "; ", so a comma would corrupt them.
  if (name === 'cookie') return 'join-cookie'
  if (SINGLETON.has(name)) return 'first'
  return 'join'
}

/**
 * One request's header section, accumulated a line at a time across however many TCP reads
 * it takes to arrive.
 */
export class HeaderSection {
  readonly #config: Config
  readonly #headers: Record<string, string> = {}
  readonly #rawHeaders: string[] = []

  #count = 0
  #bytes = 0

  constructor(config: Config) {
    this.#config = config
  }

  get headers(): Record<string, string> {
    return this.#headers
  }

  get rawHeaders(): string[] {
    return this.#rawHeaders
  }

  /** Field lines read so far. */
  get count(): number {
    return this.#count
  }

  /** Bytes consumed by the section so far, CRLFs included. */
  get bytes(): number {
    return this.#bytes
  }

  /**
   * Refuses a section that has grown past the byte cap while still incomplete.
   *
   * `pending` is what is held but not yet terminated by a CRLF. Checking it matters as much
   * as checking finished lines: the section does not end until an empty line arrives, so a
   * client that opens one header and never closes it would otherwise be buffered forever.
   * That is the header bomb, and it costs the attacker almost nothing to send.
   */
  guardPending(pending: number): void {
    if (this.#bytes + pending > this.#config.maxHeaderBytes) {
      throw headerFieldsTooLarge('header section exceeds the configured byte limit')
    }
  }

  /** Parses and stores one field line, without its CRLF. Never called with an empty line. */
  add(line: string): void {
    const first = line.charCodeAt(0)
    if (first === 0x20 || first === 0x09) {
      // RFC 9112 section 5.2 deprecated obs-fold, and every folding-aware proxy disagrees
      // with every other one about what a folded value means -- which is the disagreement.
      throw badRequest('obsolete line folding is not accepted')
    }

    const colon = line.indexOf(':')
    if (colon === -1) throw badRequest('header line has no colon')

    const name = line.slice(0, colon)
    const beforeColon = name.charCodeAt(name.length - 1)
    if (beforeColon === 0x20 || beforeColon === 0x09) {
      throw badRequest('whitespace between the header name and the colon')
    }
    if (!isToken(name)) throw badRequest('header name is not a token')

    const value = trimOWS(line.slice(colon + 1))
    if (hasForbiddenFieldByte(value)) throw badRequest('forbidden byte in header value')

    this.#count += 1
    if (this.#count > this.#config.maxHeaderCount) {
      throw headerFieldsTooLarge('too many header fields')
    }

    this.#bytes += line.length + 2
    this.guardPending(0)

    this.#store(name.toLowerCase(), value)
    this.#rawHeaders.push(name, value)
  }

  /** Checks the rules that only make sense once the whole section has been read. */
  finish(requestLine: RequestLine): HeaderSet {
    // RFC 9112 section 3.2. Without it a 1.1 request has no way to name the virtual host it
    // meant, which is why the field is mandatory rather than merely usual.
    if (requestLine.httpVersion === '1.1' && this.#headers['host'] === undefined) {
      throw badRequest('HTTP/1.1 request without a Host header')
    }

    return { headers: this.#headers, rawHeaders: this.#rawHeaders }
  }

  #store(name: string, value: string): void {
    // `headers` is an ordinary object so that it behaves like Node's for anything that
    // walks it; a field literally named __proto__ would reach the prototype setter instead
    // of becoming a key, so it is refused rather than special-cased.
    if (name === '__proto__') throw badRequest('__proto__ is not an acceptable header name')

    const existing = this.#headers[name]
    if (existing === undefined) {
      this.#headers[name] = value
      return
    }

    switch (policyFor(name)) {
      case 'first':
        return
      case 'reject':
        throw badRequest(`more than one ${name} header`)
      case 'reject-conflict':
        if (existing !== value) throw badRequest(`conflicting ${name} headers`)
        return
      case 'join-cookie':
        this.#headers[name] = `${existing}; ${value}`
        return
      case 'join':
        this.#headers[name] = `${existing}, ${value}`
        return
    }
  }
}
