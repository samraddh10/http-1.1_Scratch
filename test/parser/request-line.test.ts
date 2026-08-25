// module 2.2  test/parser/request-line.test.ts -- one line, one meaning, however it arrives

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadConfig } from '../../server/config.js'
import { ProtocolError } from '../../server/http/errors.js'
import { RequestParser } from '../../server/http/parser/request-parser.js'
import type { RequestLine } from '../../server/http/parser/request-line.js'
import { parseRequestLine } from '../../server/http/parser/request-line.js'
import { State } from '../../server/http/parser/states.js'
import { everyTwoWaySplit, splitStrategies } from '../helpers/feed-bytes.js'

function statusOf(line: string): number {
  try {
    parseRequestLine(line)
  } catch (error) {
    assert.ok(error instanceof ProtocolError, `expected a ProtocolError for ${line}`)
    return error.status
  }
  return 200
}

test('a well-formed line yields method, target and version', () => {
  assert.deepEqual(parseRequestLine('GET / HTTP/1.1'), {
    method: 'GET',
    target: '/',
    httpVersion: '1.1',
    httpVersionMajor: 1,
    httpVersionMinor: 1,
  })

  assert.deepEqual(parseRequestLine('POST /echo/42?debug=1 HTTP/1.0'), {
    method: 'POST',
    target: '/echo/42?debug=1',
    httpVersion: '1.0',
    httpVersionMajor: 1,
    httpVersionMinor: 0,
  })
})

test('the target is handed on untouched for subphase 2.6', () => {
  // Percent escapes, absolute-form and asterisk-form all survive verbatim: deciding what
  // they mean is target.ts's job, and decoding twice is how a traversal check gets bypassed.
  assert.equal(parseRequestLine('GET /a%2Fb%20c?q=%3D HTTP/1.1').target, '/a%2Fb%20c?q=%3D')
  assert.equal(parseRequestLine('GET http://x.test/a HTTP/1.1').target, 'http://x.test/a')
  assert.equal(parseRequestLine('OPTIONS * HTTP/1.1').target, '*')
  assert.equal(parseRequestLine('GET /caf\xe9 HTTP/1.1').target, '/caf\xe9')
})

test('every method with ordinary request semantics is accepted', () => {
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    assert.equal(parseRequestLine(`${method} / HTTP/1.1`).method, method)
  }
})

test('a well-formed method this server does not implement is 501', () => {
  assert.equal(statusOf('BREW / HTTP/1.1'), 501)
  assert.equal(statusOf('PROPFIND / HTTP/1.1'), 501)
  assert.equal(statusOf('CONNECT x.test:443 HTTP/1.1'), 501)
  assert.equal(statusOf('TRACE / HTTP/1.1'), 501)
  assert.equal(statusOf('get / HTTP/1.1'), 501, 'methods are case-sensitive')
})

test('a malformed line is 400, not 501', () => {
  assert.equal(statusOf(''), 400)
  assert.equal(statusOf('GET'), 400)
  assert.equal(statusOf('GET /'), 400)
  assert.equal(statusOf(' GET / HTTP/1.1'), 400, 'no leading whitespace')
  assert.equal(statusOf('GET  / HTTP/1.1'), 400, 'exactly one SP between fields')
  assert.equal(statusOf('GET / HTTP/1.1 '), 400, 'nothing after the version')
  assert.equal(statusOf('GET / HTTP/1.1 extra'), 400)
  assert.equal(statusOf('GE(T) / HTTP/1.1'), 400, 'method must be a token')
  assert.equal(statusOf('GET /a\x7fb HTTP/1.1'), 400, 'DEL in the target')
  assert.equal(statusOf('GET /a\x01b HTTP/1.1'), 400, 'control byte in the target')
  assert.equal(statusOf('GET /a\rb HTTP/1.1'), 400, 'a bare CR is not a terminator')
})

test('a version that is well-formed but unsupported is 505', () => {
  assert.equal(statusOf('GET / HTTP/2.0'), 505)
  assert.equal(statusOf('GET / HTTP/0.9'), 505)
  assert.equal(statusOf('GET / HTTP/1.2'), 505)
})

test('a version that is not a version at all is 400', () => {
  assert.equal(statusOf('GET / HTTP/1.11'), 400, 'the grammar is one digit each')
  assert.equal(statusOf('GET / HTTP1.1'), 400)
  assert.equal(statusOf('GET / http/1.1'), 400, 'HTTP-name is case-sensitive')
  assert.equal(statusOf('GET / HTTP/1.'), 400)
  assert.equal(statusOf('GET / XYZ'), 400)
})

// -- the incremental half -----------------------------------------------------------------

const LINE = Buffer.from('GET /health?deep=1 HTTP/1.1\r\n', 'latin1')

const EXPECTED: RequestLine = {
  method: 'GET',
  target: '/health?deep=1',
  httpVersion: '1.1',
  httpVersionMajor: 1,
  httpVersionMinor: 1,
}

function feed(chunks: readonly Buffer[]): RequestParser {
  const parser = new RequestParser()
  for (const chunk of chunks) parser.push(chunk)
  return parser
}

test('the same line yields the same result however it is split', () => {
  for (const strategy of splitStrategies) {
    const parser = feed(strategy.split(LINE))

    assert.deepEqual(parser.requestLine, EXPECTED, strategy.name)
    assert.equal(parser.state, State.Headers, strategy.name)
    assert.equal(parser.buffered, 0, `${strategy.name}: the line and its CRLF are consumed`)
  }
})

test('splitting between the CR and the LF does not lose the delimiter', () => {
  // The resume-one-byte-back rule in indexOfCRLF exists for exactly this cut, and every
  // other cut in the line comes along for free.
  for (const chunks of everyTwoWaySplit(LINE)) {
    const parser = feed(chunks)
    assert.deepEqual(parser.requestLine, EXPECTED, `cut after ${chunks[0]?.length ?? 0} bytes`)
    assert.equal(parser.state, State.Headers)
  }
})

test('exactly the line and its CRLF are consumed, and not one byte more', () => {
  const rest = Buffer.from('Host: localhost\r\n', 'latin1')
  const parser = feed([Buffer.concat([LINE, rest])])

  assert.equal(parser.state, State.Headers)
  assert.equal(parser.buffered, rest.length, 'what follows is left for the header reader')
})

test('a bare LF does not terminate the line', () => {
  const parser = feed([Buffer.from('GET / HTTP/1.1\n', 'latin1')])

  assert.equal(parser.state, State.RequestLine)
  assert.equal(parser.requestLine, undefined)
  assert.equal(parser.buffered, 15)
})

test('a request line error surfaces from push and latches the parser', () => {
  const parser = new RequestParser()

  assert.throws(
    () => parser.push(Buffer.from('GET / HTTP/9.9\r\n', 'latin1')),
    (error: unknown) =>
      error instanceof ProtocolError && error.status === 505 && error.closeAfter,
  )

  assert.equal(parser.state, State.Error)
  assert.equal(parser.requestLine, undefined, 'nothing half-parsed is left behind')
})

test('a completed line over the cap is 414, not accepted because it ended in time', () => {
  const config = loadConfig({ WIREHTTP_MAX_REQUEST_LINE_BYTES: '32' })
  const parser = new RequestParser({ config })

  assert.throws(
    () => parser.push(Buffer.from(`GET /${'a'.repeat(40)} HTTP/1.1\r\n`, 'latin1')),
    (error: unknown) => error instanceof ProtocolError && error.status === 414,
  )
})

test('a line at exactly the cap is accepted', () => {
  const line = 'GET /aaaaaaaaaaaaaaaa HTTP/1.1'
  const config = loadConfig({ WIREHTTP_MAX_REQUEST_LINE_BYTES: String(line.length) })
  const parser = new RequestParser({ config })

  parser.push(Buffer.from(`${line}\r\n`, 'latin1'))
  assert.equal(parser.state, State.Headers)
  assert.equal(parser.requestLine?.target, '/aaaaaaaaaaaaaaaa')
})
