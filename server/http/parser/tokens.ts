// module 2.3  server/http/parser/tokens.ts -- the field grammar shared by names and values

/** tchar, RFC 9110 section 5.6.2. Method names and header field names are both tokens. */
const TCHAR = (() => {
  const table = new Uint8Array(256)
  const mark = (from: number, to: number): void => {
    for (let code = from; code <= to; code++) table[code] = 1
  }
  //marks 0-9 (ASCII codes 48-57) as valid.
  mark(0x30, 0x39)
  //marks A-Z (65-90) as valid.
  mark(0x41, 0x5a)
  //marks a-z (97-122) as valid.
  mark(0x61, 0x7a)
  for (const character of "!#$%&'*+-.^_`|~") table[character.charCodeAt(0)] = 1
  return table
})()

//Purpose: Checks whether a whole string is a valid HTTP token -- used for the method name
// and for every header field name.
export function isToken(value: string): boolean {
  if (value.length === 0) return false
  for (let i = 0; i < value.length; i++) {
    if (TCHAR[value.charCodeAt(i)] !== 1) return false
  }
  return true
}

/**
 * OWS is any run of SP and HTAB, and only those two -- RFC 9110 section 5.6.3. A CR or LF
 * is not whitespace here; it is a field that has been split, and trimming it away would
 * hide the split rather than reject it.
 */
export function trimOWS(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '')
}

/**
 * field-vchar is VCHAR / obs-text, with SP and HTAB permitted inside the value
 * (RFC 9110 section 5.5). Everything below SP except HTAB, and DEL, is refused: a CR or LF
 * smuggled into a value is a response-splitting or request-splitting primitive, and NUL
 * ends the string for anything downstream written in C.
 *
 * Anything above 0xff is refused for the same reason one step later. Request bytes are
 * decoded latin1 so they cannot reach here, but module 3 runs this over strings an
 * application supplied, and a field value goes onto the wire as latin1: U+010A would
 * encode to 0x0A and split the response, having passed a check that only looked at the
 * code point.
 */
export function hasForbiddenFieldByte(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 0x09) continue
    if (code < 0x20 || code === 0x7f || code > 0xff) return true
  }
  return false
}

/**
 * The members of a comma-separated list field, lowercased -- the `#rule` of RFC 9110
 * section 5.6.1. Empty elements are legal there and carry no meaning, so they are dropped.
 *
 * Repeated field lines have already been joined with ", " by the header section, so one
 * split covers `Connection: close` and `Connection: keep-alive, close` alike.
 */
export function listTokens(value: string | undefined): Set<string> {
  const tokens = new Set<string>()
  if (value === undefined) return tokens

  for (const part of value.split(',')) {
    const token = trimOWS(part).toLowerCase()
    if (token.length > 0) tokens.add(token)
  }
  return tokens
}
