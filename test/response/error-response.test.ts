// module 3.4  test/response/error-response.test.ts -- answering a request that never was one
//
// The point of these is that nothing above the parser runs. A malformed request has no
// route, no listener and no `ServerRequest`, so the response has to come from a file that
// can be reached with a socket and a `ProtocolError` and nothing else -- which is asserted
// here on the import list itself, not just on behaviour, because behaviour would keep
// passing right up until the day someone reaches into `compat/` for a convenience.
//
// The status table below is the other half: it drives real hostile bytes through the parser
// and checks that what comes back out on the wire is the status module 2 documented. Every
// row is a rule that already has a parser test; what is new is that it now reaches a client.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../../server/config.js'
import { ProtocolError } from '../../server/http/errors.js'
import { RequestParser } from '../../server/http/parser/request-parser.js'
import type { Connection } from '../../server/tcp/connection.js'
import { createTcpServer } from '../../server/tcp/server.js'
import {
  respondToProtocolError,
  writeErrorResponse,
  type ClosableByteSink,
} from '../../server/http/response/error-response.js'
import { connect, untilClose } from '../helpers/raw-socket.js'

interface Recorder extends ClosableByteSink {
  bytes(): string
  ended: 'client-error' | undefined
}

function recorder(): Recorder {
  const chunks: Buffer[] = []
  return {
    ended: undefined,
    write(data) {
      chunks.push(typeof data === 'string' ? Buffer.from(data, 'latin1') : data)
      return true
    },
    end(reason) {
      this.ended = reason
    },
    bytes: () => Buffer.concat(chunks).toString('latin1'),
  }
}

/** Feeds bytes to a parser and returns the ProtocolError they produced. */
function refuse(bytes: string): ProtocolError {
  const parser = new RequestParser({ config: loadConfig({}) })
  try {
    parser.push(Buffer.from(bytes, 'latin1'))
  } catch (thrown) {
    if (thrown instanceof ProtocolError) return thrown
    throw thrown
  }
  return assert.fail(`expected ${JSON.stringify(bytes)} to be refused`)
}

test('the protocol-error path imports nothing from compat/', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../server/http/response/error-response.ts', import.meta.url)),
    'utf8',
  )

  // Specifiers only. Scanning the whole file would match this module's own comment about
  // not depending on Express, which is the opposite of a violation.
  const specifiers = [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((match) => match[1])

  assert.ok(specifiers.length > 0, 'expected to find some imports to check')
  for (const specifier of specifiers) {
    assert.doesNotMatch(specifier ?? '', /compat\/|express/i)
  }
})

test('a malformed request is answered with a complete 400 and an announced close', () => {
  const sink = recorder()
  const written = respondToProtocolError(sink, refuse('GET\r\n'))

  assert.deepEqual(written, { status: 400, closeAfter: true })
  assert.equal(
    sink.bytes().replace(/^Date: .*\r\n/m, ''),
    'HTTP/1.1 400 Bad Request\r\n' +
      'Server: wirehttp\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'Content-Length: 16\r\n' +
      'Connection: close\r\n' +
      '\r\n' +
      '400 Bad Request\n',
  )
  assert.equal(sink.ended, 'client-error')
})

test('the body names the status and does not report which rule was broken', () => {
  const error = new ProtocolError(431, 'header section exceeds 16384 bytes')
  const sink = recorder()
  writeErrorResponse(sink, error)

  assert.match(sink.bytes(), /\r\n\r\n431 Request Header Fields Too Large\n$/)
  assert.doesNotMatch(sink.bytes(), /16384|exceeds/)
})

test('an error the connection can survive is not sent Connection: close', () => {
  const sink = recorder()
  const written = respondToProtocolError(
    sink,
    new ProtocolError(417, 'unsupported expectation', { closeAfter: false }),
  )

  assert.deepEqual(written, { status: 417, closeAfter: false })
  assert.doesNotMatch(sink.bytes(), /Connection: close/i)
  assert.equal(sink.ended, undefined)
})

test('a HEAD that fails after its request line gets the headers and no body', () => {
  const sink = recorder()
  writeErrorResponse(sink, new ProtocolError(431, 'too many fields'), { method: 'HEAD' })

  assert.match(sink.bytes(), /^Content-Length: 36\r$/m)
  assert.ok(sink.bytes().endsWith('\r\n\r\n'), sink.bytes())
})

test('every rule module 2 refuses reaches the client as its documented status', () => {
  const cases: readonly [string, number][] = [
    ['GET\r\n', 400],
    ['GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n', 400],
    ['GET / HTTP/1.1\r\nHost: a\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n', 400],
    ['BREW / HTTP/1.1\r\n', 501],
    ['GET / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip, chunked\r\n\r\n', 501],
    ['GET / HTTP/2.0\r\n', 505],
    [`GET /${'a'.repeat(9_000)} HTTP/1.1\r\n`, 414],
    [`GET / HTTP/1.1\r\nHost: a\r\nX-Pad: ${'a'.repeat(17_000)}\r\n\r\n`, 431],
    ['POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 99999999\r\n\r\n', 413],
  ]

  for (const [bytes, status] of cases) {
    const sink = recorder()
    const written = respondToProtocolError(sink, refuse(bytes))

    assert.equal(written.status, status, `${JSON.stringify(bytes.slice(0, 40))} -> ${written.status}`)
    assert.match(sink.bytes(), new RegExp(`^HTTP/1\\.1 ${status} `))
  }
})

test('garbage bytes on a real socket produce a 400 and a closed connection', async (t) => {
  const server = createTcpServer({
    onData: (connection: Connection, chunk: Buffer) => {
      const parser = new RequestParser()
      try {
        parser.push(chunk)
      } catch (thrown) {
        if (!(thrown instanceof ProtocolError)) throw thrown
        respondToProtocolError(connection, thrown)
      }
    },
  })
  const { port } = await server.listen(0)
  t.after(() => server.close())

  const client = await connect(port)
  t.after(() => client.close())
  // A TLS ClientHello: what actually arrives when someone types https:// at a plain HTTP
  // port. Non-token bytes where the method belongs, so it fails on the first line.
  await client.write('\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03\r\n')

  // untilClose, not untilIncludes: the assertion is that the server hangs up on its own,
  // which is the half of this a response-shaped check would miss.
  const raw = (await client.read(untilClose)).toString('latin1')

  assert.match(raw, /^HTTP\/1\.1 400 Bad Request\r\n/)
  assert.match(raw, /^Connection: close\r$/m)
  assert.ok(raw.endsWith('\r\n\r\n400 Bad Request\n'), raw)
  assert.equal(client.closed, true)
})
