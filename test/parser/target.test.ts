// module 2.6  test/parser/target.test.ts -- decode once, then check, and never the other way

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ProtocolError } from '../../server/http/errors.js'
import type { RequestHead } from '../../server/http/parser/request-parser.js'
import { RequestParser } from '../../server/http/parser/request-parser.js'
import { parseTarget } from '../../server/http/parser/target.js'
import { crlf } from '../helpers/feed-bytes.js'

function statusOf(raw: string, method = 'GET'): number {
  try {
    parseTarget(raw, method)
  } catch (error) {
    assert.ok(error instanceof ProtocolError, `expected a ProtocolError for ${raw}`)
    return error.status
  }
  return 200
}

function headOf(...lines: string[]): RequestHead {
  const heads: RequestHead[] = []
  const parser = new RequestParser({ onHead: (head) => void heads.push(head) })

  parser.push(crlf(...lines, ''))
  assert.equal(heads.length, 1)
  return heads[0] as RequestHead
}

// -- splitting ------------------------------------------------------------------------------

test('the path is split from the query at the first question mark', () => {
  assert.deepEqual(parseTarget('/echo/42?debug=1', 'GET'), {
    raw: '/echo/42?debug=1',
    path: '/echo/42',
    query: 'debug=1',
    authority: undefined,
  })
})

test('a target with no query has an empty one, not an absent one', () => {
  const target = parseTarget('/health', 'GET')

  assert.equal(target.path, '/health')
  assert.equal(target.query, '')
})

test('only the first question mark splits; the rest belong to the query', () => {
  const target = parseTarget('/a?b=1?c=2', 'GET')

  assert.equal(target.path, '/a')
  assert.equal(target.query, 'b=1?c=2')
})

test('a trailing question mark is an empty query', () => {
  assert.equal(parseTarget('/a?', 'GET').query, '')
})

// -- decoding -------------------------------------------------------------------------------

test('the path is percent-decoded', () => {
  assert.equal(parseTarget('/a%20b', 'GET').path, '/a b')
  assert.equal(parseTarget('/caf%C3%A9', 'GET').path, '/caf\xc3\xa9')
  assert.equal(parseTarget('/a%2Fb', 'GET').path, '/a/b')
  assert.equal(parseTarget('/a%2fb', 'GET').path, '/a/b', 'hex digits are case-insensitive')
})

test('the query is NOT decoded -- that is the query parser\'s job', () => {
  const target = parseTarget('/search?q=a%20b&r=%3D', 'GET')

  assert.equal(target.query, 'q=a%20b&r=%3D')
})

test('the raw target survives untouched, because it is what req.url becomes', () => {
  // Node hands `req.url` over undecoded and Express's routing depends on that: a literal
  // %2F inside a segment is not a separator. Decoding into `raw` would change the match.
  const target = parseTarget('/a%2Fb?q=1', 'GET')

  assert.equal(target.raw, '/a%2Fb?q=1')
  assert.equal(target.path, '/a/b')
})

test('malformed percent-encoding is 400', () => {
  assert.equal(statusOf('/a%'), 400)
  assert.equal(statusOf('/a%2'), 400)
  assert.equal(statusOf('/a%zz'), 400)
  assert.equal(statusOf('/a%2g'), 400)
})

// -- traversal ------------------------------------------------------------------------------

test('a literal traversal segment is 400', () => {
  assert.equal(statusOf('/../etc/passwd'), 400)
  assert.equal(statusOf('/a/../../b'), 400)
  assert.equal(statusOf('/a/..'), 400)
})

test('an ENCODED traversal is 400, which is the whole reason decoding comes first', () => {
  // Checking before decoding is the classic bypass: %2e%2e passes a search for two dots and
  // becomes two dots a moment later.
  assert.equal(statusOf('/%2e%2e/etc/passwd'), 400)
  assert.equal(statusOf('/%2E%2E/b'), 400)
  assert.equal(statusOf('/a/.%2e/b'), 400)
  assert.equal(statusOf('/a%2f..%2fb'), 400, 'the separator itself was encoded too')
})

test('a backslash traversal is 400, because this server runs on Windows', () => {
  assert.equal(statusOf('/..\\etc'), 400)
  assert.equal(statusOf('/a%5c..%5cb'), 400)
})

test('a decoded NUL is 400 before it can truncate a filename downstream', () => {
  assert.equal(statusOf('/a%00.png'), 400)
})

test('dots that are not traversal are left alone', () => {
  assert.equal(parseTarget('/a/./b', 'GET').path, '/a/./b')
  assert.equal(parseTarget('/file.tar.gz', 'GET').path, '/file.tar.gz')
  assert.equal(parseTarget('/..bashrc', 'GET').path, '/..bashrc')
  assert.equal(parseTarget('/a/...', 'GET').path, '/a/...')
})

// -- the four forms -------------------------------------------------------------------------

test('asterisk-form is accepted for OPTIONS and refused for anything else', () => {
  assert.deepEqual(parseTarget('*', 'OPTIONS'), {
    raw: '*',
    path: '*',
    query: '',
    authority: undefined,
  })
  assert.equal(statusOf('*', 'GET'), 400)
})

test('absolute-form is accepted and its authority is kept', () => {
  const target = parseTarget('http://example.test:8080/a/b?q=1', 'GET')

  assert.equal(target.authority, 'example.test:8080')
  assert.equal(target.path, '/a/b')
  assert.equal(target.query, 'q=1')
  assert.equal(target.raw, 'http://example.test:8080/a/b?q=1')
})

test('absolute-form with no path is the root', () => {
  assert.equal(parseTarget('http://example.test', 'GET').path, '/')
})

test('absolute-form with no authority is 400', () => {
  assert.equal(statusOf('http:///a'), 400)
})

test('anything that is none of the forms is 400', () => {
  assert.equal(statusOf('foo'), 400)
  assert.equal(statusOf('example.test:443', 'GET'), 400, 'authority-form belongs to CONNECT')
  assert.equal(statusOf('ftp://example.test/a'), 400)
})

test('a fragment is never sent to a server', () => {
  assert.equal(statusOf('/a#b'), 400)
  assert.equal(statusOf('http://example.test/a#b'), 400)
})

// -- through the parser ---------------------------------------------------------------------

test('the head carries the decoded path and the encoded query', () => {
  const head = headOf('GET /echo/a%20b?q=%3D HTTP/1.1', 'Host: a')

  assert.equal(head.target, '/echo/a%20b?q=%3D', 'raw, for req.url')
  assert.equal(head.path, '/echo/a b')
  assert.equal(head.query, 'q=%3D')
})

test('an absolute-form target replaces the Host field it disagrees with', () => {
  // RFC 9112 section 3.2.2 names the winner rather than leaving two sources of the host.
  const head = headOf('GET http://real.test/a HTTP/1.1', 'Host: spoofed.test')

  assert.equal(head.headers['host'], 'real.test')
  assert.equal(head.path, '/a')
})

test('a bad target fails at the request line, before any header is read', () => {
  const parser = new RequestParser()

  assert.throws(
    () => parser.push(Buffer.from('GET /%2e%2e/etc HTTP/1.1\r\n', 'latin1')),
    (error: unknown) => error instanceof ProtocolError && error.status === 400,
  )
  assert.equal(parser.target, undefined)
})

test('the target does not carry over to the next pipelined request', () => {
  const heads: RequestHead[] = []
  const parser = new RequestParser({ onHead: (head) => void heads.push(head) })

  parser.push(
    Buffer.concat([
      crlf('GET /one?a=1 HTTP/1.1', 'Host: a', ''),
      crlf('GET /two HTTP/1.1', 'Host: b', ''),
    ]),
  )

  assert.equal(heads[0]?.query, 'a=1')
  assert.equal(heads[1]?.path, '/two')
  assert.equal(heads[1]?.query, '')
  assert.equal(parser.target, undefined, 'cleared once the second request completed')
})
