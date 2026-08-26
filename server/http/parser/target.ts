// module 2.6  server/http/parser/target.ts -- path/query split, percent-decode, traversal rejection

import { badRequest } from '../errors.js'

export interface Target {
  readonly raw: string
  readonly path: string
  readonly query: string
  readonly authority: string | undefined
}

//This regex detects the "absolute-form" target — a full URL sent as the target instead of just a path, e.g. http://example.com:8080/search?q=test.
const ABSOLUTE_FORM = /^(https?):\/\/([^/?#]*)([^#]*)$/i

//Purpose: Convert a single character's code (e.g. the code for 'A' or '9') into the numeric value it represents as a hex digit, 0 through 15. Returns -1 if the character isn't a valid hex digit.
function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30
  if (code >= 0x41 && code <= 0x46) return code - 0x37
  if (code >= 0x61 && code <= 0x66) return code - 0x57
  return -1
}

//Purpose: Take a string that may contain %XX escape sequences (where XX is two hex digits) and convert each one into the single byte it represents. Runs the decode exactly once — it does not decode the result of decoding again.
function percentDecode(value: string): string {
  if (!value.includes('%')) return value

  let decoded = ''
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '%') {
      decoded += value[i]
      continue
    }

    const high = hexValue(value.charCodeAt(i + 1))
    const low = hexValue(value.charCodeAt(i + 2))
    if (high < 0 || low < 0) throw badRequest('malformed percent-encoding in the request target')

    decoded += String.fromCharCode(high * 16 + low)
    i += 2
  }
  return decoded
}

function rejectTraversal(path: string): void {
  // A decoded NUL truncates the string for anything downstream that reaches C, so a path
  // that passes every check here can name a different file by the time it is opened.
  if (path.includes('\0')) throw badRequest('NUL byte in the request target')

  // Backslash counts as a separator as well as slash. This server runs on Windows, where
  // the filesystem treats the two alike, and a check that only knew about `/` would miss
  // half of the traversals that actually work there.
  for (const segment of path.split(/[/\\]/)) {
    if (segment === '..') throw badRequest('path traversal in the request target')
  }
}


export function parseTarget(raw: string, method: string): Target {
  if (raw === '*') {
    // asterisk-form, RFC 9112 section 3.2.4: a server-wide OPTIONS and nothing else.
    if (method !== 'OPTIONS') throw badRequest('asterisk-form target on a non-OPTIONS request')
    return { raw, path: '*', query: '', authority: undefined }
  }

  let authority: string | undefined
  let rest = raw

  const absolute = ABSOLUTE_FORM.exec(raw)
  if (absolute !== null) {
    authority = absolute[2] ?? ''
    if (authority.length === 0) throw badRequest('absolute-form target with no authority')

    rest = absolute[3] ?? ''
    if (rest.length === 0) rest = '/'
  }

  // Everything left has to be origin-form. authority-form belongs to CONNECT, which is 501
  // at the request line, so anything else reaching here is malformed.
  if (!rest.startsWith('/')) throw badRequest('request target is not an absolute path')

  // RFC 9112 section 3.2: a fragment is never sent to a server. One that arrives came from
  // something that will also disagree about where the path ends.
  if (rest.includes('#')) throw badRequest('fragment in the request target')

  const question = rest.indexOf('?')
  const encodedPath = question === -1 ? rest : rest.slice(0, question)
  const query = question === -1 ? '' : rest.slice(question + 1)

  const path = percentDecode(encodedPath)
  rejectTraversal(path)

  return { raw, path, query, authority }
}
