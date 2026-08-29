// module 3.2  test/response/framing.test.ts -- how the client is told where the body ends
//
// Every failure here is silent on the sending side and only visible to the reader. A hex
// size written as decimal, a Content-Length counting characters instead of bytes, or a
// zero-length chunk emitted mid-body all produce a response this server considers sent and
// a client either truncates or hangs on. So the assertions are on literal bytes, and the
// chunked case is round-tripped through module 2.5's decoder, which was written without
// reference to this encoder.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import type { Connection } from '../../server/tcp/connection.js'
import { createTcpServer } from '../../server/tcp/server.js'
import { RequestParser } from '../../server/http/parser/request-parser.js'
import {
  ResponseWriter,
  decideResponseFraming,
  encodeChunk,
  type ByteSink,
} from '../../server/http/response/writer.js'
import { connect, untilIncludes } from '../helpers/raw-socket.js'

interface Recorder extends ByteSink {
  head(): string
  body(): Buffer
}

function recorder(): Recorder {
  const chunks: Buffer[] = []
  const all = (): Buffer => Buffer.concat(chunks)
  const boundary = (): number => all().indexOf('\r\n\r\n', 0, 'latin1')

  return {
    write(data) {
      chunks.push(typeof data === 'string' ? Buffer.from(data, 'latin1') : data)
      return true
    },
    // Includes the CRLF that ends the last field line, so every header line in `head()`
    // looks the same to a trailing-CR anchor.
    head: () => all().subarray(0, boundary() + 2).toString('latin1'),
    body: () => all().subarray(boundary() + 4),
  }
}

test('a body known at end() is framed by Content-Length', () => {
  const sink = recorder()
  new ResponseWriter(sink).end('hello')

  assert.match(sink.head(), /^Content-Length: 5\r$/m)
  assert.doesNotMatch(sink.head(), /Transfer-Encoding/i)
  assert.equal(sink.body().toString('latin1'), 'hello')
})

test('Content-Length counts bytes, not characters', () => {
  const sink = recorder()
  new ResponseWriter(sink).end('héllo')

  // Five characters, six utf8 bytes. Declaring five leaves a byte on the wire that the
  // client reads as the start of the next response.
  assert.match(sink.head(), /^Content-Length: 6\r$/m)
  assert.equal(sink.body().length, 6)
})

test('a body not known at head time is chunked, with hex sizes and a terminal zero chunk', () => {
  const sink = recorder()
  const response = new ResponseWriter(sink)

  response.write('hello')
  response.write('x'.repeat(255))
  response.end()

  assert.match(sink.head(), /^Transfer-Encoding: chunked\r$/m)
  assert.doesNotMatch(sink.head(), /Content-Length/i)

  // ff, not 255: a decimal size line is the bug that reads as valid HTTP right up to the
  // point the client counts out 255 bytes of a 255-byte chunk and finds no CRLF.
  assert.equal(
    sink.body().toString('latin1'),
    `5\r\nhello\r\nff\r\n${'x'.repeat(255)}\r\n0\r\n\r\n`,
  )
})

test('an empty write is dropped rather than encoded as a zero chunk', () => {
  const sink = recorder()
  const response = new ResponseWriter(sink)

  response.write('a')
  response.write('')
  response.write(Buffer.alloc(0))
  response.end()

  assert.equal(sink.body().toString('latin1'), '1\r\na\r\n0\r\n\r\n')
  assert.throws(() => encodeChunk(Buffer.alloc(0)), RangeError)
})

test('a chunked response decodes back to the bytes it was given', () => {
  const parts = [Buffer.from('hello '), Buffer.from('world'), Buffer.from('x'.repeat(4_096))]

  const sink = recorder()
  const response = new ResponseWriter(sink)
  for (const part of parts) response.write(part)
  response.end()

  const decoded: Buffer[] = []
  const parser = new RequestParser({ onBodyChunk: (chunk) => void decoded.push(chunk) })
  parser.push(Buffer.from('POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n'))
  parser.push(sink.body())

  assert.deepEqual(Buffer.concat(decoded), Buffer.concat(parts))
})

test('an application-supplied Content-Length is honoured and not duplicated', () => {
  const sink = recorder()
  const response = new ResponseWriter(sink)

  response.writeHead({ status: 200, headers: { 'Content-Length': 5 } })
  assert.deepEqual(response.framing, { kind: 'length', length: 5 })
  assert.equal(sink.head().match(/^content-length: /gim)?.length, 1)

  response.end('hello')
  assert.equal(sink.body().toString('latin1'), 'hello')
})

test('a body that disagrees with its declared length is refused in both directions', () => {
  const over = new ResponseWriter(recorder())
  over.writeHead({ status: 200, headers: { 'Content-Length': 2 } })
  assert.throws(() => over.write('too long'), /tried to send more/)

  const under = new ResponseWriter(recorder())
  under.writeHead({ status: 200, headers: { 'Content-Length': 10 } })
  assert.throws(() => under.end('short'), /but sent 5/)
})

test('a response carrying both framing headers is refused, as a request would be', () => {
  assert.throws(
    () => decideResponseFraming({ 'Content-Length': 5, 'Transfer-Encoding': 'chunked' }),
    /cannot carry both/,
  )
  assert.throws(() => decideResponseFraming({ 'Transfer-Encoding': 'gzip' }), /unsupported/)
  assert.throws(() => decideResponseFraming({ 'Content-Length': 'five' }), /is not a length/)
})

test('framing defaults to chunked on 1.1 and to close-delimited on 1.0', () => {
  assert.deepEqual(decideResponseFraming({}), { kind: 'chunked' })
  assert.deepEqual(decideResponseFraming({}, { httpVersion: '1.0' }), { kind: 'close' })
  assert.deepEqual(decideResponseFraming({}, { knownLength: 0 }), { kind: 'length', length: 0 })
  assert.throws(
    () => decideResponseFraming({ 'Transfer-Encoding': 'chunked' }, { httpVersion: '1.0' }),
    /HTTP\/1\.0 client cannot be sent a chunked response/,
  )
})

test('an HTTP/1.0 client with an unknown length gets the body raw and loses the connection', () => {
  const sink = recorder()
  const response = new ResponseWriter(sink, { httpVersion: '1.0' })

  response.write('hello')
  response.end()

  assert.deepEqual(response.framing, { kind: 'close' })
  assert.equal(response.mustCloseAfter, true)
  assert.doesNotMatch(sink.head(), /Content-Length|Transfer-Encoding/i)
  assert.equal(sink.body().toString('latin1'), 'hello')
})

test('a chunked response reaches a raw socket as the bytes a client has to read', async (t) => {
  const server = createTcpServer({
    onData: (connection: Connection) => {
      const response = new ResponseWriter(connection)
      response.writeHead({ status: 200, headers: { 'Content-Type': 'text/plain' } })
      response.write('one')
      response.write('two')
      response.end()
    },
  })
  const { port } = await server.listen(0)
  t.after(() => server.close())

  const client = await connect(port)
  t.after(() => client.close())
  await client.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')
  const raw = (await client.read(untilIncludes('0\r\n\r\n'))).toString('latin1')

  assert.match(raw, /^HTTP\/1\.1 200 OK\r\n/)
  assert.match(raw, /^Transfer-Encoding: chunked\r$/m)
  assert.ok(raw.endsWith('\r\n\r\n3\r\none\r\n3\r\ntwo\r\n0\r\n\r\n'), raw)
})
