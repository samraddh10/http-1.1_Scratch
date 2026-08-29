// module 3.3  test/response/bodyless.test.ts -- the responses that carry no body
//
// Two different rules that look like one. A HEAD keeps the whole header block, including
// the Content-Length describing the body it is not sending, because that header is the only
// reason to send a HEAD. A 204 or a 304 keeps neither: RFC 9112 section 6.3 frames them by
// the empty line, ahead of any header field.
//
// Both fail the same way when they are wrong -- a body byte that no framing accounts for,
// which the client reads as the beginning of the next response. So the last test here sends
// two responses back to back down one socket and asserts the whole byte stream, which is
// the only place a stray byte has nowhere to hide.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Connection } from '../../server/tcp/connection.js'
import { createTcpServer } from '../../server/tcp/server.js'
import { forbidsContent } from '../../server/http/response/status.js'
import {
  ResponseWriter,
  decideResponseFraming,
  type ByteSink,
} from '../../server/http/response/writer.js'
import { connect, untilIncludes } from '../helpers/raw-socket.js'

function recorder(): ByteSink & { bytes(): string; body(): string } {
  const chunks: Buffer[] = []
  const all = (): Buffer => Buffer.concat(chunks)

  return {
    write(data) {
      chunks.push(typeof data === 'string' ? Buffer.from(data, 'latin1') : data)
      return true
    },
    bytes: () => all().toString('latin1'),
    body: () => all().subarray(all().indexOf('\r\n\r\n', 0, 'latin1') + 4).toString('latin1'),
  }
}

test('the statuses that forbid content are the ones RFC 9112 section 6.3 names', () => {
  for (const code of [100, 101, 199, 204, 304]) {
    assert.equal(forbidsContent(code), true, `${code} should forbid content`)
  }
  for (const code of [200, 201, 203, 205, 300, 400, 500]) {
    assert.equal(forbidsContent(code), false, `${code} should allow content`)
  }
})

test('a 204 and a 304 are framed by the empty line and carry no framing header', () => {
  assert.deepEqual(decideResponseFraming({}, { status: 204 }), { kind: 'none' })
  assert.deepEqual(decideResponseFraming({}, { status: 304 }), { kind: 'none' })
  assert.deepEqual(decideResponseFraming({}, { status: 100 }), { kind: 'none' })

  // The status wins over the fields: on a 204 a Content-Length has nothing to describe.
  assert.deepEqual(
    decideResponseFraming({ 'Content-Length': 12 }, { status: 204 }),
    { kind: 'none' },
  )
})

test('a 204 drops a framing header the application set, and sends no body', () => {
  const sink = recorder()
  const response = new ResponseWriter(sink)

  response.writeHead({ status: 204, headers: { 'Content-Length': 12, 'X-Trace': 'abc' } })
  response.end('this body is not sent')

  assert.equal(
    sink.bytes().replace(/^Date: .*\r\n/m, ''),
    'HTTP/1.1 204 No Content\r\nServer: wirehttp\r\nX-Trace: abc\r\n\r\n',
  )
  assert.equal(response.bodyAllowed, false)
  assert.equal(response.bodyBytesWritten, 0)
})

test('a 304 keeps the validators that are the point of it', () => {
  const sink = recorder()
  const response = new ResponseWriter(sink)

  response.writeHead({
    status: 304,
    headers: { ETag: '"abc"', 'Cache-Control': 'max-age=60', 'Content-Length': 4_096 },
  })
  response.end()

  assert.match(sink.bytes(), /^ETag: "abc"\r$/m)
  assert.match(sink.bytes(), /^Cache-Control: max-age=60\r$/m)
  assert.doesNotMatch(sink.bytes(), /Content-Length|Transfer-Encoding/i)
  assert.equal(sink.body(), '')
})

test('a HEAD keeps the full header block and sends zero body bytes', () => {
  const sink = recorder()
  const response = new ResponseWriter(sink, { method: 'HEAD' })

  response.writeHead({ status: 200, headers: { 'Content-Type': 'text/html', 'Content-Length': 1_234 } })
  response.end()

  // The length describes the body the equivalent GET would return. Dropping it here is the
  // bug that makes a HEAD useless for the thing it exists for.
  assert.match(sink.bytes(), /^Content-Length: 1234\r$/m)
  assert.match(sink.bytes(), /^Content-Type: text\/html\r$/m)
  assert.equal(sink.body(), '')
})

test('a HEAD discards a body the application sends anyway, without complaining', () => {
  const sink = recorder()
  const response = new ResponseWriter(sink, { method: 'head' })

  // Express calls res.end(body) without knowing the request was a HEAD, and sets a
  // Content-Length that then disagrees with the zero bytes actually sent. Neither the
  // over-length guard nor the short-body guard may fire on that.
  response.writeHead({ status: 200, headers: { 'Content-Length': 5 } })
  response.write('hello')
  response.end('and more')

  assert.equal(sink.body(), '')
  assert.equal(response.bodyBytesWritten, 0)
})

test('a HEAD framed chunked writes no terminal chunk', () => {
  const sink = recorder()
  const response = new ResponseWriter(sink, { method: 'HEAD' })

  response.write('hello')
  response.end()

  assert.match(sink.bytes(), /^Transfer-Encoding: chunked\r$/m)
  assert.equal(sink.body(), '')
})

test('two bodyless responses down one socket leave no byte between them', async (t) => {
  const responses = [
    { status: 200, headers: { 'Content-Length': 1_234 }, method: 'HEAD' },
    { status: 204, headers: {}, method: 'GET' },
  ]

  const server = createTcpServer({
    onData: (connection: Connection) => {
      for (const each of responses) {
        const response = new ResponseWriter(connection, { method: each.method })
        response.writeHead({ status: each.status, headers: each.headers })
        response.end('body bytes that must not appear')
      }
    },
  })
  const { port } = await server.listen(0)
  t.after(() => server.close())

  const client = await connect(port)
  t.after(() => client.close())
  await client.write('HEAD / HTTP/1.1\r\nHost: localhost\r\n\r\n')
  const raw = (await client.read(untilIncludes('204'))).toString('latin1')

  assert.equal(
    raw.replace(/^Date: .*\r\n/gm, ''),
    'HTTP/1.1 200 OK\r\nServer: wirehttp\r\nContent-Length: 1234\r\n\r\n' +
      'HTTP/1.1 204 No Content\r\nServer: wirehttp\r\n\r\n',
  )
})
