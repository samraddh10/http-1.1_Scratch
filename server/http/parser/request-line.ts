// module 2.2  server/http/parser/request-line.ts -- method / target / version

import { badRequest, notImplemented, versionNotSupported } from '../errors.js'

export interface RequestLine {
  /** Case-sensitive, exactly as sent. */
  readonly method: string
  /** Still percent-encoded and unvalidated in form; subphase 2.6 takes it apart. */
  readonly target: string
  readonly httpVersion: '1.0' | '1.1'
  readonly httpVersionMajor: number
  readonly httpVersionMinor: number
}

/**
 * Methods this server implements. Anything else well-formed is 501.
 *
 * CONNECT and TRACE are deliberately absent -- see DECISIONS.md. The list is hard-coded
 * rather than taken from `http.METHODS` because nothing in `server/` may import node:http.
 */
const IMPLEMENTED = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'])

/** RFC 9112 section 2.3: HTTP-name "/" DIGIT "." DIGIT. One digit each, case-sensitive. */
const VERSION = /^HTTP\/\d\.\d$/

/** tchar, RFC 9110 section 5.6.2. */
const TCHAR = (() => {
  const table = new Uint8Array(256)
  const mark = (from: number, to: number): void => {
    for (let code = from; code <= to; code++) table[code] = 1
  }
  //marks 0–9 (ASCII codes 48–57) as valid.
  mark(0x30, 0x39)
  //marks A–Z (65–90) as valid.
  mark(0x41, 0x5a)
  //marks a–z (97–122) as valid.
  mark(0x61, 0x7a)
  for (const character of "!#$%&'*+-.^_`|~") table[character.charCodeAt(0)] = 1
  return table
})()

//Purpose: Checks whether a whole string is a valid HTTP token — used to validate the method name.
function isToken(value: string): boolean {
  if (value.length === 0) return false
  for (let i = 0; i < value.length; i++) {
    if (TCHAR[value.charCodeAt(i)] !== 1) return false
  }
  return true
}

///Purpose: Checks the request target (the path/query part) for bytes that must never appear there — control characters, space, and DEL. 
// Note this function is named for what it rejects, and it deliberately does not reject bytes above 0x7f.
function hasForbiddenByte(target: string): boolean {
  for (let i = 0; i < target.length; i++) {
    const code = target.charCodeAt(i)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}

//Purpose: Takes the full request-line string (already stripped of its CRLF by the caller) and returns a validated RequestLine object, or throws an HTTP error if anything is wrong.
export function parseRequestLine(line: string): RequestLine {
  const firstSpace = line.indexOf(' ')
  if (firstSpace === -1) throw badRequest('request line has no space')

  const secondSpace = line.indexOf(' ', firstSpace + 1)
  if (secondSpace === -1) throw badRequest('request line has only one space')

  const method = line.slice(0, firstSpace)
  const target = line.slice(firstSpace + 1, secondSpace)
  const version = line.slice(secondSpace + 1)

  // Exactly one SP between fields. A tolerated run of spaces is a smuggling primitive:
  // two parsers disagreeing about where the target ends is the whole attack.
  if (!isToken(method)) throw badRequest('method is not a token')
  if (!IMPLEMENTED.has(method)) throw notImplemented(method)

  if (target.length === 0) throw badRequest('empty request target')
  if (hasForbiddenByte(target)) throw badRequest('forbidden byte in request target')

  if (!VERSION.test(version)) throw badRequest('malformed HTTP version')
  if (version !== 'HTTP/1.1' && version !== 'HTTP/1.0') throw versionNotSupported(version)

  const minor = version === 'HTTP/1.1' ? 1 : 0
  return {
    method,
    target,
    httpVersion: version === 'HTTP/1.1' ? '1.1' : '1.0',
    httpVersionMajor: 1,
    httpVersionMinor: minor,
  }
}
