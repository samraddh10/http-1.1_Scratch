// module 2.5  test/parser/chunked.test.ts -- a body that declares its own length as it goes

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Config } from '../../server/config.js'
import { loadConfig } from '../../server/config.js'
import { ProtocolError } from '../../server/http/errors.js'
import { RequestParser } from '../../server/http/parser/request-parser.js'
import { State } from '../../server/http/parser/states.js'
import { crlf, everyTwoWaySplit, splitStrategies } from '../helpers/feed-bytes.js'

interface Run {
  readonly parser: RequestParser
  readonly body: Buffer
  readonly chunkCount: number
  readonly completed: number
  readonly trailers: Record<string, string>[]
}

function run(chunks: readonly Buffer[], config: Config = loadConfig({})): Run {
  const parts: Buffer[] = []
  const trailers: Record<string, string>[] = []
  let completed = 0

  const parser = new RequestParser({
    config,
    onBodyChunk: (chunk) => void parts.push(chunk),
    onComplete: (seen) => {
      completed += 1
      trailers.push({ ...seen })
    },
  })
  for (const chunk of chunks) parser.push(chunk)

  return {
    parser,
    trailers,
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

const HEAD = crlf('POST /upload HTTP/1.1', 'Host: a', 'Transfer-Encoding: chunked', '')

/** Builds a chunked request from literal body lines, so the wire bytes stay visible here. */
function chunked(...lines: string[]): Buffer {
  return Buffer.concat([HEAD, crlf(...lines)])
}

function statusOf(bytes: Buffer, config: Config = loadConfig({})): number {
  try {
    run([bytes], config)
  } catch (error) {
    assert.ok(error instanceof ProtocolError, 'expected a ProtocolError')
    return error.status
  }
  return 200
}

// -- the happy path ---------------------------------------------------------------------------

const REQUEST = chunked('4', 'Wiki', '5', 'pedia', 'e', ' in\r\n\r\nchunks.', '0', '')
const DECODED = 'Wikipedia in\r\n\r\nchunks.'

test('a chunked body decodes to the same bytes however it is split', () => {
  for (const strategy of splitStrategies) {
    const { parser, body, completed } = run(strategy.split(REQUEST))

    assert.equal(body.toString('latin1'), DECODED, strategy.name)
    assert.equal(completed, 1, strategy.name)
    assert.equal(parser.state, State.RequestLine, strategy.name)
    assert.equal(parser.buffered, 0, strategy.name)
  }
})

test('the size line itself surviving a split is the point of the sub-machine', () => {
  // A two-byte size line cut between its digits, or between the digit and its CR, or
  // between CR and LF, is the case a counter-based decoder gets wrong.
  const request = chunked('1f', 'a'.repeat(31), '0', '')

  for (const chunks of everyTwoWaySplit(request)) {
    const { body, completed } = run(chunks)
    assert.equal(body.toString('latin1'), 'a'.repeat(31), `cut after ${chunks[0]?.length ?? 0}`)
    assert.equal(completed, 1)
  }
})

test('the zero chunk terminates and an empty line closes an absent trailer section', () => {
  const { body, completed, trailers } = run([chunked('0', '')])

  assert.equal(body.length, 0)
  assert.equal(completed, 1)
  assert.deepEqual(trailers[0], {})
})

test('chunk sizes are hexadecimal, upper or lower case', () => {
  assert.equal(run([chunked('A', '0123456789', '0', '')]).body.toString('latin1'), '0123456789')
  assert.equal(run([chunked('a', '0123456789', '0', '')]).body.toString('latin1'), '0123456789')
})

test('chunk extensions are ignored, not mistaken for the size', () => {
  const { body } = run([chunked('4;name=value', 'Wiki', '0;done', '')])

  assert.equal(body.toString('latin1'), 'Wiki')
})

test('whitespace before the extension semicolon is tolerated', () => {
  assert.equal(run([chunked('4 ;x', 'Wiki', '0', '')]).body.toString('latin1'), 'Wiki')
})

test('bytes are emitted as they arrive rather than accumulated per chunk', () => {
  const { chunkCount, body } = run(
    Array.from(chunked('4', 'Wiki', '0', ''), (byte) => Buffer.from([byte])),
  )

  assert.equal(body.toString('latin1'), 'Wiki')
  assert.equal(chunkCount, 4, 'one emission per byte that arrived')
})

// -- trailers ---------------------------------------------------------------------------------

test('a trailer section lands on the completion event', () => {
  const request = chunked('4', 'Wiki', '0', 'X-Checksum: abc123', 'X-Rows: 7', '')

  for (const strategy of splitStrategies) {
    const { trailers, body, completed } = run(strategy.split(request))

    assert.equal(completed, 1, strategy.name)
    assert.equal(body.toString('latin1'), 'Wiki', strategy.name)
    assert.deepEqual(trailers[0], { 'x-checksum': 'abc123', 'x-rows': '7' }, strategy.name)
  }
})

test('a trailer section is held to the same grammar as the header section', () => {
  assert.equal(statusOf(chunked('0', 'X-Bad : v', '')), 400, 'space before the colon')
  assert.equal(statusOf(chunked('0', 'X-Fold: a', ' b', '')), 400, 'obsolete line folding')
  assert.equal(statusOf(chunked('0', 'no-colon', '')), 400)
})

test('trailers do not carry over to the next request', () => {
  const both = Buffer.concat([
    chunked('4', 'Wiki', '0', 'X-Checksum: abc', ''),
    crlf('GET /after HTTP/1.1', 'Host: b', ''),
  ])
  const { trailers, completed } = run([both])

  assert.equal(completed, 2)
  assert.deepEqual(trailers[0], { 'x-checksum': 'abc' })
  assert.deepEqual(trailers[1], {})
})

// -- what it refuses --------------------------------------------------------------------------

test('a size that is not hexadecimal is 400', () => {
  assert.equal(statusOf(chunked('xyz', 'Wiki', '0', '')), 400)
  assert.equal(statusOf(chunked('0x4', 'Wiki', '0', '')), 400)
  assert.equal(statusOf(chunked('-4', 'Wiki', '0', '')), 400)
  assert.equal(statusOf(chunked('', 'Wiki', '0', '')), 400, 'an empty size line')
  assert.equal(statusOf(chunked(' 4', 'Wiki', '0', '')), 400, 'no whitespace before the size')
})

test('data not followed by CRLF is 400, because the size that produced it was wrong', () => {
  const bad = Buffer.concat([HEAD, Buffer.from('4\r\nWikiXX0\r\n\r\n', 'latin1')])

  assert.equal(statusOf(bad), 400)
})

test('a chunk larger than the per-chunk cap is 400 before it is allocated', () => {
  const config = loadConfig({ WIREHTTP_MAX_CHUNK_SIZE_BYTES: '16' })

  assert.equal(statusOf(chunked('ff', 'ignored', '0', ''), config), 400)
})

test('a size line that never ends is 400 rather than buffered without bound', () => {
  const config = loadConfig({ WIREHTTP_MAX_CHUNK_LINE_BYTES: '32' })
  const { parser } = run([HEAD], config)

  assert.equal(parser.state, State.Body)
  assert.throws(
    () => parser.push(Buffer.from('a'.repeat(40), 'latin1')),
    (error: unknown) => error instanceof ProtocolError && error.status === 400,
  )
})

test('a chunked body cannot outgrow the body cap that Content-Length is held to', () => {
  // The bypass this closes: chunked declares no total length, so a cap checked only against
  // Content-Length would let the same body through in pieces.
  const config = loadConfig({ WIREHTTP_MAX_BODY_BYTES: '16' })

  assert.equal(statusOf(chunked('8', 'a'.repeat(8), '0', ''), config), 200)
  assert.equal(
    statusOf(chunked('8', 'a'.repeat(8), '8', 'b'.repeat(8), '8', 'c'.repeat(8), '0', ''), config),
    413,
  )
})

test('a chunked request that stops mid-body does not complete', () => {
  const { parser, completed, body } = run([
    Buffer.concat([HEAD, Buffer.from('9\r\nWiki', 'latin1')]),
  ])

  assert.equal(completed, 0)
  assert.equal(body.toString('latin1'), 'Wiki', 'what arrived was still streamed on')
  assert.equal(parser.state, State.Body)
})

test('a pipelined request behind a chunked body is not eaten by it', () => {
  const both = Buffer.concat([REQUEST, crlf('GET /after HTTP/1.1', 'Host: b', '')])

  for (const strategy of splitStrategies) {
    const { parser, body, completed } = run(strategy.split(both))

    assert.equal(completed, 2, strategy.name)
    assert.equal(body.toString('latin1'), DECODED, strategy.name)
    assert.equal(parser.buffered, 0, strategy.name)
  }
})
