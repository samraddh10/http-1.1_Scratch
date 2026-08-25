// module 2.3  test/parser/headers.test.ts -- the field section: what is kept, and what is refused

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadConfig } from '../../server/config.js'
import { ProtocolError } from '../../server/http/errors.js'
import type { RequestHead } from '../../server/http/parser/request-parser.js'
import { RequestParser } from '../../server/http/parser/request-parser.js'
import { State } from '../../server/http/parser/states.js'
import { crlf, splitStrategies } from '../helpers/feed-bytes.js'

interface Run {
  readonly parser: RequestParser
  readonly heads: RequestHead[]
  readonly completed: number
}

function run(bytes: Buffer, chunks: readonly Buffer[] = [bytes]): Run {
  const heads: RequestHead[] = []
  let completed = 0

  const parser = new RequestParser({
    onHead: (head) => void heads.push(head),
    onComplete: () => void (completed += 1),
  })
  for (const chunk of chunks) parser.push(chunk)

  return { parser, heads, get completed() { return completed } }
}

/** Feeds a request and returns its single head, failing if it did not parse exactly one. */
function headOf(bytes: Buffer): RequestHead {
  const { heads } = run(bytes)
  assert.equal(heads.length, 1)
  return heads[0] as RequestHead
}

function statusOf(bytes: Buffer): number {
  try {
    run(bytes)
  } catch (error) {
    assert.ok(error instanceof ProtocolError, 'expected a ProtocolError')
    return error.status
  }
  return 200
}

const GET = crlf(
  'GET /health HTTP/1.1',
  'Host: localhost:3000',
  'User-Agent: curl/8.4.0',
  'Accept: */*',
  '',
)

test('a whole request parses the same however it is split', () => {
  for (const strategy of splitStrategies) {
    const { parser, heads, completed } = run(GET, strategy.split(GET))

    assert.equal(heads.length, 1, strategy.name)
    assert.equal(completed, 1, strategy.name)
    assert.deepEqual(
      heads[0]?.headers,
      { host: 'localhost:3000', 'user-agent': 'curl/8.4.0', accept: '*/*' },
      strategy.name,
    )
    assert.equal(parser.state, State.RequestLine, `${strategy.name}: ready for the next one`)
    assert.equal(parser.buffered, 0, strategy.name)
  }
})

test('names are lowercased in the map and kept verbatim in rawHeaders', () => {
  const head = headOf(crlf('GET / HTTP/1.1', 'HOST: a', 'X-Mixed-Case: b', ''))

  assert.equal(head.headers['host'], 'a')
  assert.equal(head.headers['x-mixed-case'], 'b')
  assert.deepEqual(head.rawHeaders, ['HOST', 'a', 'X-Mixed-Case', 'b'])
})

test('optional whitespace is trimmed from both ends but not from inside', () => {
  const head = headOf(crlf('GET / HTTP/1.1', 'Host: a', 'X-Pad: \t  two words  \t', ''))

  assert.equal(head.headers['x-pad'], 'two words')
})

test('an empty value is a value', () => {
  const head = headOf(crlf('GET / HTTP/1.1', 'Host: a', 'X-Empty:', ''))

  assert.equal(head.headers['x-empty'], '')
  assert.deepEqual(head.rawHeaders, ['Host', 'a', 'X-Empty', ''])
})

test('a request with no fields at all is legal on HTTP/1.0', () => {
  const head = headOf(crlf('GET / HTTP/1.0', ''))

  assert.deepEqual(head.headers, {})
  assert.deepEqual(head.rawHeaders, [])
})

// -- what the section refuses ---------------------------------------------------------------

test('obsolete line folding is 400', () => {
  assert.equal(statusOf(crlf('GET / HTTP/1.1', 'Host: a', 'X-Long: one', ' two', '')), 400)
  assert.equal(statusOf(crlf('GET / HTTP/1.1', 'Host: a', 'X-Long: one', '\ttwo', '')), 400)
})

test('whitespace before the colon is 400', () => {
  assert.equal(statusOf(crlf('GET / HTTP/1.1', 'Host : a', '')), 400)
  assert.equal(statusOf(crlf('GET / HTTP/1.1', 'Host\t: a', '')), 400)
})

test('a line that is not a field is 400', () => {
  assert.equal(statusOf(crlf('GET / HTTP/1.1', 'Host: a', 'no-colon-here', '')), 400)
  assert.equal(statusOf(crlf('GET / HTTP/1.1', ': empty-name', '')), 400)
  assert.equal(statusOf(crlf('GET / HTTP/1.1', 'X Bad: a', '')), 400)
  assert.equal(statusOf(crlf('GET / HTTP/1.1', 'X(Bad): a', '')), 400)
})

test('a control byte in a value is 400', () => {
  assert.equal(statusOf(crlf('GET / HTTP/1.1', 'Host: a', 'X-Nul: a\x00b', '')), 400)
  assert.equal(statusOf(crlf('GET / HTTP/1.1', 'Host: a', 'X-Del: a\x7fb', '')), 400)
  assert.equal(statusOf(crlf('GET / HTTP/1.1', 'Host: a', 'X-Cr: a\rb', '')), 400)
})

test('a header named __proto__ is 400 rather than a prototype write', () => {
  assert.equal(statusOf(crlf('GET / HTTP/1.1', 'Host: a', '__proto__: x', '')), 400)
})

test('HTTP/1.1 without a Host is 400; HTTP/1.0 without one is fine', () => {
  assert.equal(statusOf(crlf('GET / HTTP/1.1', 'Accept: */*', '')), 400)
  assert.equal(statusOf(crlf('GET / HTTP/1.0', 'Accept: */*', '')), 200)
})

// -- the duplicate policy -------------------------------------------------------------------

test('a repeated list-valued field is joined with a comma', () => {
  const head = headOf(
    crlf('GET / HTTP/1.1', 'Host: a', 'Accept-Encoding: gzip', 'Accept-Encoding: br', ''),
  )

  assert.equal(head.headers['accept-encoding'], 'gzip, br')
  assert.deepEqual(head.rawHeaders.slice(2), ['Accept-Encoding', 'gzip', 'Accept-Encoding', 'br'])
})

test('a repeated singleton keeps the first and drops the rest', () => {
  const head = headOf(
    crlf('GET / HTTP/1.1', 'Host: a', 'User-Agent: first', 'User-Agent: second', ''),
  )

  assert.equal(head.headers['user-agent'], 'first')
  assert.equal(head.rawHeaders.length, 6, 'rawHeaders still records every line as sent')
})

test('repeated cookies join with a semicolon, not a comma', () => {
  const head = headOf(crlf('GET / HTTP/1.1', 'Host: a', 'Cookie: a=1', 'Cookie: b=2', ''))

  assert.equal(head.headers['cookie'], 'a=1; b=2')
})

test('more than one Host is 400 whatever the values are', () => {
  assert.equal(statusOf(crlf('GET / HTTP/1.1', 'Host: a', 'Host: b', '')), 400)
  assert.equal(statusOf(crlf('GET / HTTP/1.1', 'Host: a', 'Host: a', '')), 400)
})

test('two Content-Lengths collapse if identical and are 400 if they disagree', () => {
  const head = headOf(
    crlf('POST / HTTP/1.1', 'Host: a', 'Content-Length: 5', 'Content-Length: 5', ''),
  )
  assert.equal(head.headers['content-length'], '5')

  assert.equal(
    statusOf(crlf('POST / HTTP/1.1', 'Host: a', 'Content-Length: 5', 'Content-Length: 6', '')),
    400,
  )
})

// -- the caps -------------------------------------------------------------------------------

test('too many fields is 431', () => {
  const config = loadConfig({ WIREHTTP_MAX_HEADER_COUNT: '3' })
  const parser = new RequestParser({ config })

  assert.throws(
    () => parser.push(crlf('GET / HTTP/1.1', 'Host: a', 'A: 1', 'B: 2', 'C: 3', '')),
    (error: unknown) => error instanceof ProtocolError && error.status === 431,
  )
})

test('too many header bytes is 431', () => {
  const config = loadConfig({ WIREHTTP_MAX_HEADER_BYTES: '64' })
  const parser = new RequestParser({ config })

  assert.throws(
    () => parser.push(crlf('GET / HTTP/1.1', 'Host: a', `X-Big: ${'a'.repeat(80)}`, '')),
    (error: unknown) => error instanceof ProtocolError && error.status === 431,
  )
})

test('a field that never ends is 431 before it is buffered without bound', () => {
  // The header bomb: the section does not close until an empty line, so an unterminated
  // line has to be capped on what is held, not only on what has been read to a CRLF.
  const config = loadConfig({ WIREHTTP_MAX_HEADER_BYTES: '64' })
  const parser = new RequestParser({ config })

  parser.push(crlf('GET / HTTP/1.1'))
  assert.equal(parser.state, State.Headers)

  assert.throws(
    () => parser.push(Buffer.from(`X-Big: ${'a'.repeat(80)}`, 'latin1')),
    (error: unknown) => error instanceof ProtocolError && error.status === 431,
  )
})

// -- pipelining -----------------------------------------------------------------------------

test('two requests in one chunk both parse, and neither leaks into the other', () => {
  const two = Buffer.concat([
    crlf('GET /one HTTP/1.1', 'Host: a', 'X-Only-First: yes', ''),
    crlf('GET /two HTTP/1.1', 'Host: b', ''),
  ])

  for (const strategy of splitStrategies) {
    const { parser, heads, completed } = run(two, strategy.split(two))

    assert.equal(completed, 2, strategy.name)
    assert.equal(heads[0]?.target, '/one', strategy.name)
    assert.equal(heads[1]?.target, '/two', strategy.name)
    assert.equal(heads[1]?.headers['host'], 'b', strategy.name)
    assert.equal(
      heads[1]?.headers['x-only-first'],
      undefined,
      `${strategy.name}: the section did not carry over`,
    )
    assert.equal(parser.buffered, 0, strategy.name)
  }
})
