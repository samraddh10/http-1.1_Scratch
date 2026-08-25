// module 2.4  server/http/parser/framing.ts -- Content-Length vs Transfer-Encoding, smuggling rejection

import type { Config } from '../../config.js'
import { badRequest, contentTooLarge, unsupportedTransferCoding } from '../errors.js'
import type { RequestLine } from './request-line.js'
import { trimOWS } from './tokens.js'

/** How the end of this request's body is found -- or that there is not one. */
export type Framing =
  | { readonly kind: 'none' }
  | { readonly kind: 'length'; readonly length: number }
  | { readonly kind: 'chunked' }

const NO_BODY: Framing = { kind: 'none' }

/** RFC 9112 section 6.2: Content-Length is 1*DIGIT. Not signed, not hex, not a list. */
const DECIMAL = /^\d+$/

/**
 * Decides the body framing from the header section, before a single body byte is read.
 *
 * The order of the checks is the point. Both framing headers together is refused before
 * either is interpreted, because the whole attack is that interpreting one of them is
 * itself the choice an attacker wants me to make.
 */
export function decideFraming(
  requestLine: RequestLine,
  headers: Readonly<Record<string, string>>,
  config: Config,
): Framing {
  const transferEncoding = headers['transfer-encoding']
  const contentLength = headers['content-length']

  if (transferEncoding !== undefined && contentLength !== undefined) {
    throw badRequest('both Content-Length and Transfer-Encoding are present')
  }

  if (transferEncoding !== undefined) {
    return decideTransferEncoding(requestLine, transferEncoding)
  }

  if (contentLength !== undefined) {
    return decideContentLength(contentLength, config)
  }

  return NO_BODY
}

function decideTransferEncoding(requestLine: RequestLine, value: string): Framing {
  if (requestLine.httpVersion === '1.0') {
    throw badRequest('Transfer-Encoding on an HTTP/1.0 request')
  }

  const codings = value
    .split(',')
    .map((coding) => trimOWS(coding).toLowerCase())
    .filter((coding) => coding.length > 0)

  if (codings.length === 0) throw badRequest('empty Transfer-Encoding')

  if (codings[codings.length - 1] !== 'chunked') {
    throw badRequest('chunked is not the final transfer coding')
  }

  // Anything stacked underneath chunked (`gzip, chunked`) would have to be decoded to find
  // the body, and none of them are implemented. 501 is what RFC 9112 section 6.1 asks for.
  if (codings.length > 1) {
    throw unsupportedTransferCoding(codings.slice(0, -1).join(', '))
  }

  return { kind: 'chunked' }
}

function decideContentLength(value: string, config: Config): Framing {
  if (!DECIMAL.test(value)) throw badRequest('Content-Length is not a decimal number')

  const length = Number(value)
  if (!Number.isSafeInteger(length)) throw badRequest('Content-Length is out of range')

  // Refused on the declared length, before a byte of the body is buffered.
  if (length > config.maxBodyBytes) throw contentTooLarge('body exceeds the configured limit')

  return length === 0 ? NO_BODY : { kind: 'length', length }
}
