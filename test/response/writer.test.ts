// module 3.1  test/response/writer.test.ts -- the status line, the header block, the Date
//
// Weighted at the two things that are silent when wrong. The first is header injection: a
// CR, an LF or a code unit above 0xff in a value an application supplied splits the
// response into two, and the wire still looks like valid HTTP -- so the failure is a
// smuggled response, not an error. The second is the Date cache, which is indistinguishable
// from a correct one for the first second of the process's life.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { createTcpServer, type TcpServer } from '../../server/tcp/server.js'
import type { Connection } from '../../server/tcp/connection.js'
import {
  ResponseWriter,
  imfFixdate,
  serialiseHead,
  type ByteSink,
} from '../../server/http/response/writer.js'
import { REQUIRED_STATUSES, STATUS_CODES, reasonPhrase } from '../../server/http/response/status.js'
import { connect, untilIncludes } from '../helpers/raw-socket.js'

const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/

/** 1994-11-06T08:49:37Z, the example date RFC 9110 section 5.6.7 uses. */
const PINNED = Date.UTC(1994, 10, 6, 8, 49, 37)

function head(options: Parameters<typeof serialiseHead>[0]): string {
  return serialiseHead(options, { now: PINNED, serverName: 'wirehttp' }).toString('latin1')
}

/** Collects everything written, so a response can be asserted on without a socket. */
function recorder(): ByteSink & { bytes(): string } {
  const chunks: Buffer[] = []
  return {
    write(data) {
      chunks.push(typeof data === 'string' ? Buffer.from(data, 'latin1') : data)
      return true
    },
    bytes: () => Buffer.concat(chunks).toString('latin1'),
  }
}

test('every status this server has to produce has a reason phrase', () => {
  for (const code of REQUIRED_STATUSES) {
    assert.ok(STATUS_CODES[code], `${code} is in REQUIRED_STATUSES but has no reason phrase`)
  }
  assert.equal(reasonPhrase(599), 'Unknown')
})

test('a status outside the three-digit range is refused', () => {
  assert.throws(() => head({ status: 99 }), RangeError)
  assert.throws(() => head({ status: 1000 }), RangeError)
  assert.throws(() => head({ status: 200.5 }), RangeError)
})

test('a head serialises to exactly the bytes HTTP/1.1 defines', () => {
  assert.equal(
    head({ status: 404, headers: { 'Content-Type': 'text/plain', 'Content-Length': 9 } }),
    'HTTP/1.1 404 Not Found\r\n' +
      'Date: Sun, 06 Nov 1994 08:49:37 GMT\r\n' +
      'Server: wirehttp\r\n' +
      'Content-Type: text/plain\r\n' +
      'Content-Length: 9\r\n' +
      '\r\n',
  )
})

test('a caller-supplied reason phrase replaces the table', () => {
  assert.match(head({ status: 200, reason: 'Totally Fine' }), /^HTTP\/1\.1 200 Totally Fine\r\n/)
})

test('the Date is IMF-fixdate and is recomputed once a second, not once a response', () => {
  const first = imfFixdate(PINNED)
  assert.match(first, IMF_FIXDATE)

  // Same second, different millisecond: the cached string is returned by identity, which is
  // the only way to tell a working cache from one that reformats every time.
  assert.equal(imfFixdate(PINNED + 999), first)

  const next = imfFixdate(PINNED + 1_000)
  assert.match(next, IMF_FIXDATE)
  assert.notEqual(next, first)
  assert.equal(next, 'Sun, 06 Nov 1994 08:49:38 GMT')
})

test('a caller that sets Date or Server itself gets one of each, not two', () => {
  const bytes = head({ status: 200, headers: { date: 'Thu, 01 Jan 1970 00:00:00 GMT', SERVER: 'x' } })

  assert.equal(bytes.match(/^date: /gim)?.length, 1)
  assert.equal(bytes.match(/^server: /gim)?.length, 1)
  assert.match(bytes, /^date: Thu, 01 Jan 1970 00:00:00 GMT\r$/m)
  assert.match(bytes, /^SERVER: x\r$/m)
})

test('an array value sends one field line per element', () => {
  const bytes = head({ status: 200, headers: { 'Set-Cookie': ['a=1', 'b=2'] } })

  assert.match(bytes, /Set-Cookie: a=1\r\nSet-Cookie: b=2\r\n/)
})

test('a header that would split the response is refused, including via latin1 truncation', () => {
  assert.throws(() => head({ status: 200, headers: { 'X-A': 'a\r\nInjected: yes' } }), TypeError)
  assert.throws(() => head({ status: 200, headers: { 'X-A': 'a\nb' } }), TypeError)

  // U+010A is not a control character, but latin1 encoding truncates it to 0x0A.
  assert.throws(() => head({ status: 200, headers: { 'X-A': 'aĊb' } }), TypeError)

  assert.throws(() => head({ status: 200, headers: { 'Bad Name': 'v' } }), TypeError)
  assert.throws(() => head({ status: 200, headers: { 'X-A:': 'v' } }), TypeError)
  assert.throws(() => head({ status: 200, reason: 'OK\r\nX-Injected: yes' }), TypeError)
})

test('an interim response is a bare status line, with no Date and no Server', () => {
  assert.equal(head({ status: 100 }), 'HTTP/1.1 100 Continue\r\n\r\n')
})

test('the writer refuses the orderings that would corrupt a response', () => {
  const sink = recorder()
  const response = new ResponseWriter(sink)

  assert.throws(() => response.write('early'), /before writeHead/)

  response.writeHead({ status: 200 })
  assert.equal(response.headersSent, true)
  assert.throws(() => response.writeHead({ status: 500 }), /twice/)

  response.end('done')
  assert.equal(response.finished, true)
  assert.throws(() => response.write('late'), /after end/)
  assert.match(sink.bytes(), /\r\n\r\ndone$/)
})

async function started(t: TestContext, onData: (connection: Connection) => void): Promise<number> {
  const server: TcpServer = createTcpServer({ onData: (connection) => onData(connection) })
  const address = await server.listen(0)
  t.after(() => server.close())
  return address.port
}

test('a response written through the writer reaches a raw socket intact', async (t) => {
  const port = await started(t, (connection) => {
    const response = new ResponseWriter(connection)
    response.writeHead({
      status: 200,
      headers: { 'Content-Type': 'text/plain', 'Content-Length': 5 },
    })
    response.end('hello')
  })

  const client = await connect(port)
  t.after(() => client.close())
  await client.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')
  const raw = (await client.read(untilIncludes('hello'))).toString('latin1')

  const [headSection, body] = raw.split('\r\n\r\n')
  const lines = (headSection ?? '').split('\r\n')

  assert.equal(lines[0], 'HTTP/1.1 200 OK')
  assert.match(lines[1] ?? '', /^Date: (.+)$/)
  assert.match((lines[1] ?? '').slice('Date: '.length), IMF_FIXDATE)
  assert.equal(lines[2], 'Server: wirehttp')
  assert.equal(lines[3], 'Content-Type: text/plain')
  assert.equal(lines[4], 'Content-Length: 5')
  assert.equal(body, 'hello')
})
