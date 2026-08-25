// module 2.1  test/parser/state-machine.test.ts -- the skeleton: it buffers, or it refuses

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadConfig } from '../../server/config.js'
import {
  ProtocolError,
  badRequest,
  contentTooLarge,
  headerFieldsTooLarge,
  notImplemented,
  uriTooLong,
  versionNotSupported,
} from '../../server/http/errors.js'
import { RequestParser } from '../../server/http/parser/request-parser.js'
import { State, assertTransition, canTransition } from '../../server/http/parser/states.js'
import { splitStrategies } from '../helpers/feed-bytes.js'

// No CRLF anywhere: the machine cannot advance off REQUEST_LINE, so what is under test is
// the accumulation contract on its own rather than anything subphase 2.2 parses.
const PARTIAL = Buffer.from('GET /health HTTP/1.1', 'latin1')

test('ProtocolError carries the status, the reason and the close-after flag', () => {
  const error = new ProtocolError(400, 'space before colon in header name')

  assert.ok(error instanceof Error)
  assert.equal(error.name, 'ProtocolError')
  assert.equal(error.status, 400)
  assert.equal(error.reason, 'space before colon in header name')
  assert.match(error.message, /^400 space before colon/)
})

test('ProtocolError closes the connection unless told otherwise', () => {
  assert.equal(new ProtocolError(400, 'malformed').closeAfter, true)
  assert.equal(new ProtocolError(417, 'expectation', { closeAfter: false }).closeAfter, false)
})

test('each factory raises the status its rule is documented with', () => {
  assert.equal(badRequest('malformed request line').status, 400)
  assert.equal(contentTooLarge('body exceeds the limit').status, 413)
  assert.equal(uriTooLong().status, 414)
  assert.equal(headerFieldsTooLarge('too many fields').status, 431)
  assert.equal(notImplemented('BREW').status, 501)
  assert.equal(versionNotSupported('HTTP/2.0').status, 505)
})

test('the transition table allows exactly the moves in the diagram', () => {
  assert.ok(canTransition(State.RequestLine, State.Headers))
  assert.ok(canTransition(State.Headers, State.Body))
  assert.ok(canTransition(State.Headers, State.Complete))
  assert.ok(canTransition(State.Body, State.Complete))
  assert.ok(canTransition(State.Complete, State.RequestLine))

  assert.ok(!canTransition(State.RequestLine, State.Body))
  assert.ok(!canTransition(State.RequestLine, State.Complete))
  assert.ok(!canTransition(State.Body, State.Headers))
  assert.ok(!canTransition(State.Complete, State.Headers))
})

test('every state but Error can fail; Error is terminal', () => {
  for (const from of [State.RequestLine, State.Headers, State.Body]) {
    assert.ok(canTransition(from, State.Error), `${from} must be able to fail`)
  }
  for (const to of Object.values(State)) {
    assert.ok(!canTransition(State.Error, to), `error -> ${to} must not be reachable`)
  }
})

test('an illegal transition is a bug and throws a plain Error', () => {
  assert.throws(
    () => assertTransition(State.RequestLine, State.Body),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof ProtocolError) &&
      /illegal transition request-line -> body/.test(error.message),
  )
})

test('a parser starts on the request line holding nothing', () => {
  const parser = new RequestParser()

  assert.equal(parser.state, State.RequestLine)
  assert.equal(parser.buffered, 0)
  assert.equal(parser.error, undefined)
})

test('bytes accumulate however they are split, and none are consumed', () => {
  for (const strategy of splitStrategies) {
    const parser = new RequestParser()
    let fed = 0

    for (const chunk of strategy.split(PARTIAL)) {
      parser.push(chunk)
      fed += chunk.length
      assert.equal(parser.buffered, fed, strategy.name)
      assert.equal(parser.state, State.RequestLine, strategy.name)
    }

    assert.equal(parser.buffered, PARTIAL.length, strategy.name)
  }
})

test('an empty chunk changes nothing', () => {
  const parser = new RequestParser()

  parser.push(Buffer.alloc(0))
  assert.equal(parser.buffered, 0)

  parser.push(Buffer.from('GET ', 'latin1'))
  parser.push(Buffer.alloc(0))
  assert.equal(parser.buffered, 4)
  assert.equal(parser.state, State.RequestLine)
})

test('a request line with no end in sight is 414, not unbounded buffering', () => {
  const config = loadConfig({ WIREHTTP_MAX_REQUEST_LINE_BYTES: '64' })
  const parser = new RequestParser({ config })

  parser.push(Buffer.alloc(64, 0x41))
  assert.equal(parser.state, State.RequestLine, 'exactly at the cap is still fine')

  assert.throws(
    () => parser.push(Buffer.alloc(1, 0x41)),
    (error: unknown) =>
      error instanceof ProtocolError && error.status === 414 && error.closeAfter,
  )

  assert.equal(parser.state, State.Error)
  assert.equal(parser.error?.status, 414)
})

test('a parser that has failed refuses further bytes', () => {
  const config = loadConfig({ WIREHTTP_MAX_REQUEST_LINE_BYTES: '8' })
  const parser = new RequestParser({ config })

  assert.throws(() => parser.push(Buffer.alloc(9, 0x41)), ProtocolError)

  assert.throws(
    () => parser.push(Buffer.from('more', 'latin1')),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof ProtocolError) &&
      /the connection must close/.test(error.message),
  )
  assert.equal(parser.error?.status, 414, 'the first failure is the one that is reported')
})
