// module 4.4  test/connection/expect-continue.test.ts -- asking before uploading

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { serveHttp, type Exchange } from '../../server/http/connection.js'
import { createTcpServer } from '../../server/tcp/server.js'
import type { CloseReason } from '../../server/tcp/connection.js'
import {
  connect,
  untilClose,
  untilIncludes,
  untilResponses,
  type RawConnection,
} from '../helpers/raw-socket.js'

/** Reads the whole body and echoes it, which is what a client asking permission expects. */
function echoBody(exchange: Exchange): void {
  const chunks: Buffer[] = []
  exchange.onBodyChunk = (chunk) => chunks.push(chunk)
  exchange.onRequestComplete = () => exchange.response.end(Buffer.concat(chunks))
}

interface Started {
  port: number
  closes: CloseReason[]
}

async function started(
  t: TestContext,
  listener: (exchange: Exchange) => void = echoBody,
): Promise<Started> {
  const closes: CloseReason[] = []
  const server = createTcpServer({
    ...serveHttp({
      listener,
      onConnectionClose: (_connection, reason) => closes.push(reason),
    }),
  })

  const address = await server.listen(0)
  t.after(() => server.close())
  return { port: address.port, closes }
}

function head(body: string, expect = '100-continue', version = '1.1'): string {
  return (
    `POST /upload HTTP/${version}\r\nHost: x\r\n` +
    `Content-Length: ${body.length}\r\n` +
    (expect === '' ? '' : `Expect: ${expect}\r\n`) +
    '\r\n'
  )
}

/**
 * Waits for the nth occurrence, not the first. On a reused connection an earlier interim is
 * still in the buffer, and matching it again would let the body go out before the 100 that
 * permits it -- which the client is allowed to do, so the test would pass by testing
 * nothing.
 */
function untilCount(needle: string, n: number): (received: Buffer) => boolean {
  return (received) => received.toString('latin1').split(needle).length - 1 >= n
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('a client that asks permission gets 100 Continue before it sends the body', async (t) => {
  const { port } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  await client.write(head('payload'))
  const interim = (await client.read(untilIncludes('\r\n\r\n'))).toString('latin1')

  // A bare status line and the empty line that ends it. An interim response carries no
  // Date, no Server and no framing: it is not the response, and the real one follows it.
  assert.equal(interim, 'HTTP/1.1 100 Continue\r\n\r\n')

  await client.write('payload')
  const full = (await client.read(untilResponses(2))).toString('latin1')

  assert.match(full.slice(interim.length), /^HTTP\/1\.1 200 OK\r\n/)
  assert.equal(full.endsWith('payload'), true, full)
  assert.equal(client.closed, false)
})

test('the connection is reused after a 100-continue exchange', async (t) => {
  const { port } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  await client.write(head('first'))
  await client.read(untilCount('100 Continue', 1))
  await client.write('first')
  await client.read(untilResponses(2))

  await client.write(head('second'))
  await client.read(untilCount('100 Continue', 2), { timeoutMs: 2_000 })
  await client.write('second')
  const received = (await client.read(untilResponses(4))).toString('latin1')

  assert.equal(received.endsWith('second'), true, received)
  assert.equal(received.match(/HTTP\/1\.1 100 Continue/g)?.length, 2)
})

test('an application that answers first is the answer, and no 100 is sent', async (t) => {
  const { port } = await started(t, (exchange) => {
    // Refusing on the headers alone -- the case the whole mechanism exists for. The client
    // reads a final status instead of the 100 and never uploads.
    exchange.response.writeHead({ status: 401, headers: { 'Content-Length': 0 } })
    exchange.response.end()
  })
  const client = await connect(port)
  t.after(() => client.close())

  await client.write(head('a body that is never sent'))
  const received = (await client.read(untilResponses(1))).toString('latin1')

  assert.match(received, /^HTTP\/1\.1 401 Unauthorized\r\n/)
  assert.equal(received.includes('100 Continue'), false, received)
})

test('a client that does not wait is not sent a 100 it no longer needs', async (t) => {
  const { port } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  // Head and body in one write: the client asked, then went ahead anyway, which it is
  // entitled to do. Permission for something already done is noise on the wire.
  await client.write(head('impatient') + 'impatient')
  const received = (await client.read(untilResponses(1))).toString('latin1')

  assert.match(received, /^HTTP\/1\.1 200 OK\r\n/)
  assert.equal(received.includes('100 Continue'), false, received)
  assert.equal(received.endsWith('impatient'), true, received)
})

test('an HTTP/1.0 client is not sent an interim response it cannot use', async (t) => {
  const { port } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  // 1.0 has no interim responses, so the expectation is ignored rather than refused: the
  // client is not waiting, and it sends its body regardless.
  await client.write(head('one-oh', '100-continue', '1.0') + 'one-oh')
  const received = (await client.read(untilResponses(1))).toString('latin1')

  assert.match(received, /^HTTP\/1\.0 200 OK\r\n|^HTTP\/1\.1 200 OK\r\n/)
  assert.equal(received.includes('100 Continue'), false, received)
  assert.equal(received.endsWith('one-oh'), true, received)
})

test('a GET asking to continue gets no 100, because there is no body to permit', async (t) => {
  const { port } = await started(t, (exchange) => exchange.response.end('no body here'))
  const client = await connect(port)
  t.after(() => client.close())

  await client.write('GET /nothing HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\n\r\n')
  const received = (await client.read(untilResponses(1))).toString('latin1')

  assert.match(received, /^HTTP\/1\.1 200 OK\r\n/)
  assert.equal(received.includes('100 Continue'), false, received)
})

test('an expectation this server cannot meet is refused 417, not ignored', async (t) => {
  const seen: string[] = []
  const { port, closes } = await started(t, (exchange) => {
    seen.push(exchange.head.path)
    echoBody(exchange)
  })
  const client = await connect(port)
  t.after(() => client.close())

  await client.write(head('never sent', 'the-moon-on-a-stick'))
  const received = (await client.read(untilResponses(1))).toString('latin1')

  assert.match(received, /^HTTP\/1\.1 417 Expectation Failed\r\n/)
  assert.deepEqual(seen, [], 'the application was asked to honour an unmet expectation')

  // The client is holding a body back for a permission that is never coming, so there is no
  // finding where the next request would start.
  assert.match(received, /\r\nConnection: close\r\n/)
  await client.read(untilClose, { timeoutMs: 2_000 })
  await waitFor(() => closes.length > 0, 'the server never tore the connection down')
  assert.deepEqual(closes, ['end-of-exchange'])
})

test('a refused expectation on a bodyless request keeps the connection', async (t) => {
  const { port } = await started(t, (exchange) => exchange.response.end('ok'))
  const client = await connect(port)
  t.after(() => client.close())

  await client.write('GET /odd HTTP/1.1\r\nHost: x\r\nExpect: something-else\r\n\r\n')
  const first = (await client.read(untilResponses(1))).toString('latin1')

  assert.match(first, /^HTTP\/1\.1 417 Expectation Failed\r\n/)
  // Nothing was being held back, so the stream position is still known and the socket lives.
  assert.equal(/^connection:/im.test(first), false, first)

  await client.write('GET /after HTTP/1.1\r\nHost: x\r\n\r\n')
  const second = (await client.read(untilResponses(2))).toString('latin1')

  assert.match(second.slice(first.length), /^HTTP\/1\.1 200 OK\r\n/)
  assert.equal(client.closed, false)
})

test('the interim response does not disturb a pipelined request behind it', async (t) => {
  const { port } = await started(t, (exchange) => {
    if (exchange.head.method === 'GET') exchange.response.end(`GET ${exchange.head.path}`)
    else echoBody(exchange)
  })
  const client = await connect(port)
  t.after(() => client.close())

  // The GET is answered first; only then may the 100 for the POST go out, or it would land
  // in front of a response the client is still reading.
  await client.write('GET /first HTTP/1.1\r\nHost: x\r\n\r\n' + head('later'))
  await client.read(untilIncludes('100 Continue'), { timeoutMs: 2_000 })

  await client.write('later')
  const received = (await client.read(untilResponses(3))).toString('latin1')

  assert.equal(received.indexOf('GET /first') < received.indexOf('100 Continue'), true, received)
  assert.equal(received.endsWith('later'), true, received)
})
