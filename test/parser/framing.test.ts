// module 2.4  test/parser/framing.test.ts -- where the body ends, and refusing to guess

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
  readonly body: Buffer
  readonly chunkCount: number
  readonly completed: number
}

function run(chunks: readonly Buffer[], config = loadConfig({})): Run {
  const heads: RequestHead[] = []
  const parts: Buffer[] = []
  let completed = 0

  const parser = new RequestParser({
    config,
    onHead: (head) => void heads.push(head),
    onBodyChunk: (chunk) => void parts.push(chunk),
    onComplete: () => void (completed += 1),
  })
  for (const chunk of chunks) parser.push(chunk)

  return {
    parser,
    heads,
    get body() {
      return Buffer.concat(parts)
    },
    get chunkCount() {
      return parts.length
    },
    get completed() {
      return completed
    },
  }
}

function statusOf(bytes: Buffer): number {
  try {
    run([bytes])
  } catch (error) {
    assert.ok(error instanceof ProtocolError, 'expected a ProtocolError')
    return error.status
  }
  return 200
}

function post(...fields: string[]): Buffer {
  return crlf('POST /submit HTTP/1.1', 'Host: a', ...fields, '')
}

// -- the decision -----------------------------------------------------------------------------

test('no framing header means no body', () => {
  const { heads, completed } = run([crlf('GET / HTTP/1.1', 'Host: a', '')])

  assert.deepEqual(heads[0]?.framing, { kind: 'none' })
  assert.equal(completed, 1)
})

test('Content-Length gives a length framing, and zero means no body at all', () => {
  assert.deepEqual(run([post('Content-Length: 16')]).heads[0]?.framing, {
    kind: 'length',
    length: 16,
  })
  assert.deepEqual(run([post('Content-Length: 0')]).heads[0]?.framing, { kind: 'none' })
})

test('Transfer-Encoding: chunked gives a chunked framing', () => {
  const heads: RequestHead[] = []
  const parser = new RequestParser({ onHead: (head) => void heads.push(head) })

  // The decoder itself lands in 2.5; the decision is what 2.4 owns.
  assert.throws(() => parser.push(post('Transfer-Encoding: chunked')), ProtocolError)
  assert.deepEqual(heads[0]?.framing, { kind: 'chunked' })
})

// -- the smuggling rule -----------------------------------------------------------------------

test('both Content-Length and Transfer-Encoding is 400 with the connection closed', () => {
  // RFC 9112 section 6.1. A proxy framing by one header and this server framing by the
  // other disagree about where the request ends, and the gap becomes a prefix on somebody
  // else's next request. There is no safe reconciliation, only refusal.
  const parser = new RequestParser()

  assert.throws(
    () => parser.push(post('Content-Length: 6', 'Transfer-Encoding: chunked')),
    (error: unknown) =>
      error instanceof ProtocolError && error.status === 400 && error.closeAfter,
  )
  assert.equal(parser.state, State.Error)
})

test('the order the two headers arrive in does not change the answer', () => {
  assert.equal(statusOf(post('Transfer-Encoding: chunked', 'Content-Length: 6')), 400)
  assert.equal(statusOf(post('Content-Length: 6', 'Transfer-Encoding: chunked')), 400)
})

test('chunked must be the final transfer coding', () => {
  assert.equal(statusOf(post('Transfer-Encoding: chunked, gzip')), 400)
  assert.equal(statusOf(post('Transfer-Encoding: identity')), 400)
})

test('a coding stacked under chunked is 501, not a guess', () => {
  assert.equal(statusOf(post('Transfer-Encoding: gzip, chunked')), 501)
})

test('Transfer-Encoding on an HTTP/1.0 request is 400', () => {
  assert.equal(
    statusOf(crlf('POST / HTTP/1.0', 'Host: a', 'Transfer-Encoding: chunked', '')),
    400,
  )
})

test('an empty Transfer-Encoding is 400', () => {
  assert.equal(statusOf(post('Transfer-Encoding:')), 400)
  assert.equal(statusOf(post('Transfer-Encoding: ,')), 400)
})

// -- Content-Length validity ------------------------------------------------------------------

test('Content-Length must be a plain decimal number', () => {
  assert.equal(statusOf(post('Content-Length: +6')), 400)
  assert.equal(statusOf(post('Content-Length: -6')), 400)
  assert.equal(statusOf(post('Content-Length: 0x10')), 400)
  assert.equal(statusOf(post('Content-Length: 1e3')), 400)
  assert.equal(statusOf(post('Content-Length: 6, 6')), 400)
  assert.equal(statusOf(post('Content-Length: six')), 400)
  assert.equal(statusOf(post('Content-Length:')), 400)
})

test('a length past what a number can hold is 400, not a silent rounding', () => {
  assert.equal(statusOf(post('Content-Length: 99999999999999999999')), 400)
})

test('a declared length over the cap is 413 before a body byte is buffered', () => {
  const config = loadConfig({ WIREHTTP_MAX_BODY_BYTES: '16' })

  assert.throws(
    () => run([post('Content-Length: 17')], config),
    (error: unknown) => error instanceof ProtocolError && error.status === 413,
  )
})

// -- reading the body -------------------------------------------------------------------------

const BODY = '{"name":"shriy"}'
const POST = Buffer.concat([post(`Content-Length: ${BODY.length}`), Buffer.from(BODY, 'latin1')])

test('a body of exactly N bytes is read and the request completes', () => {
  for (const strategy of splitStrategies) {
    const { parser, body, completed } = run(strategy.split(POST))

    assert.equal(body.toString('latin1'), BODY, strategy.name)
    assert.equal(completed, 1, strategy.name)
    assert.equal(parser.state, State.RequestLine, strategy.name)
    assert.equal(parser.buffered, 0, strategy.name)
  }
})

test('one chunk per arrival, and nothing emitted before the body starts', () => {
  const parts: Buffer[] = []
  const parser = new RequestParser({ onBodyChunk: (chunk) => void parts.push(chunk) })

  parser.push(post(`Content-Length: ${BODY.length}`))
  assert.equal(parts.length, 0, 'the header section produced no body bytes')

  for (const byte of Buffer.from(BODY, 'latin1')) parser.push(Buffer.from([byte]))
  assert.equal(parts.length, BODY.length, 'every arrival was emitted, not accumulated')
  assert.equal(Buffer.concat(parts).toString('latin1'), BODY)
})

test('a body chunk is a copy, not a window onto the parser buffer', () => {
  const parts: Buffer[] = []
  const parser = new RequestParser({ onBodyChunk: (chunk) => void parts.push(chunk) })

  parser.push(POST)
  const first = parts[0] as Buffer
  const before = first.toString('latin1')

  // Whatever the parser does with its backing store afterwards, the handed-out bytes stand.
  parser.push(Buffer.from('GET /later HTTP/1.1\r\nHost: b\r\n\r\n', 'latin1'))
  assert.equal(first.toString('latin1'), before)
})

test('a pipelined request behind a body is not eaten by it', () => {
  const next = crlf('GET /after HTTP/1.1', 'Host: b', '')
  const both = Buffer.concat([POST, next])

  for (const strategy of splitStrategies) {
    const { heads, body, completed } = run(strategy.split(both))

    assert.equal(completed, 2, strategy.name)
    assert.equal(body.toString('latin1'), BODY, `${strategy.name}: exactly N bytes were taken`)
    assert.equal(heads[1]?.target, '/after', strategy.name)
    assert.deepEqual(heads[1]?.framing, { kind: 'none' }, strategy.name)
  }
})

test('a request that stops mid-body does not complete', () => {
  const short = Buffer.concat([
    post(`Content-Length: ${BODY.length}`),
    Buffer.from(BODY.slice(0, 4), 'latin1'),
  ])
  const { parser, body, completed } = run([short])

  assert.equal(completed, 0)
  assert.equal(body.toString('latin1'), '{"na')
  assert.equal(parser.state, State.Body)
})
