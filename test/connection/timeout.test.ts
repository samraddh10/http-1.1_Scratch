// module 4.2  test/connection/timeout.test.ts -- the idle timeout, and who it is actually for

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { serveHttp, type Exchange } from '../../server/http/connection.js'
import { createTcpServer, type TcpServer } from '../../server/tcp/server.js'
import type { CloseReason } from '../../server/tcp/connection.js'
import { connect, untilClose, untilResponses, type RawConnection } from '../helpers/raw-socket.js'

/** Short enough that a stalled test fails fast, long enough to survive a loaded machine. */
const IDLE_MS = 120

function echoRequestLine(exchange: Exchange): void {
  exchange.response.end(`${exchange.head.method} ${exchange.head.path}`)
}

interface Started {
  server: TcpServer
  port: number
  closes: CloseReason[]
}

async function started(
  t: TestContext,
  listener: (exchange: Exchange) => void = echoRequestLine,
): Promise<Started> {
  const closes: CloseReason[] = []
  const server = createTcpServer({
    ...serveHttp({
      listener,
      onConnectionClose: (_connection, reason) => closes.push(reason),
    }),
    idleTimeoutMs: IDLE_MS,
  })

  const address = await server.listen(0)
  t.after(() => server.close())
  return { server, port: address.port, closes }
}

async function settled(client: RawConnection): Promise<string> {
  const received = await client.read(untilClose, { timeoutMs: 10 * IDLE_MS })
  return received.toString('latin1')
}

/**
 * The client seeing the close is not the server having finished with it: `end()` sends a
 * FIN and the server's own teardown runs when the peer answers with its own. Every
 * assertion about the server side has to wait for that second half.
 */
async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10 * IDLE_MS
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('a connection idle between requests is told 408 rather than just dropped', async (t) => {
  const { server, port, closes } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  await client.write('GET /one HTTP/1.1\r\nHost: x\r\n\r\n')
  await client.read(untilResponses(1))

  const received = await settled(client)

  assert.match(received, /HTTP\/1\.1 408 Request Timeout\r\n/)
  // RFC 9110 section 15.5.9: a 408 implies the server has decided to stop waiting, so the
  // close is part of the answer rather than something the client has to infer.
  assert.match(received.slice(received.indexOf('408')), /\r\nConnection: close\r\n/)
  await waitFor(() => closes.length > 0, 'the server never tore the connection down')
  assert.deepEqual(closes, ['idle-timeout'])
  assert.equal(server.connectionCount, 0, 'the connection outlived its own timeout')
})

test('a request that stops halfway is timed out too -- the slowloris case', async (t) => {
  const { port, closes } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  // A request line, a header, and then silence. The header section never ends, so without
  // a timeout this connection is held for free until the server runs out of slots.
  await client.write('GET /slow HTTP/1.1\r\nHost: x\r\nX-Half: ')

  const received = await settled(client)

  assert.match(received, /^HTTP\/1\.1 408 Request Timeout\r\n/)
  await waitFor(() => closes.length > 0, 'the server never tore the connection down')
  assert.deepEqual(closes, ['idle-timeout'])
})

test('a body that stops halfway is timed out on the same rule', async (t) => {
  const { port } = await started(t, (exchange) => {
    exchange.onRequestComplete = () => exchange.response.end('never reached')
  })
  const client = await connect(port)
  t.after(() => client.close())

  await client.write('POST /slow HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nab')

  assert.match(await settled(client), /^HTTP\/1\.1 408 Request Timeout\r\n/)
})

test('a slow application is not a slow client, and is not timed out', async (t) => {
  const { port, closes } = await started(t, (exchange) => {
    // Longer than the idle timeout: the socket is silent for the whole of it, but the
    // silence belongs to the server. Timing this out would report the server's own latency
    // to the client as a timeout, and would kill every route slower than the limit.
    setTimeout(() => exchange.response.end('slow but fine'), IDLE_MS * 2).unref()
  })
  const client = await connect(port)
  t.after(() => client.close())

  await client.write('GET /slow HTTP/1.1\r\nHost: x\r\n\r\n')
  const received = (await client.read(untilResponses(1), { timeoutMs: 10 * IDLE_MS })).toString(
    'latin1',
  )

  assert.match(received, /^HTTP\/1\.1 200 OK\r\n/)
  assert.equal(received.endsWith('slow but fine'), true, received)
  assert.equal(client.closed, false)
  assert.deepEqual(closes, [])
})

test('the timer is rearmed once the application answers', async (t) => {
  const { port, closes } = await started(t, (exchange) => {
    setTimeout(() => exchange.response.end('ok'), IDLE_MS * 2).unref()
  })
  const client = await connect(port)
  t.after(() => client.close())

  await client.write('GET /slow HTTP/1.1\r\nHost: x\r\n\r\n')
  await client.read(untilResponses(1), { timeoutMs: 10 * IDLE_MS })

  // Disarming while the application worked must not leave the connection unguarded: the
  // client goes quiet after the response and the timeout has to reclaim it.
  const received = await settled(client)

  assert.match(received.slice(received.indexOf('ok') + 2), /HTTP\/1\.1 408 Request Timeout\r\n/)
  await waitFor(() => closes.length > 0, 'the server never tore the connection down')
  assert.deepEqual(closes, ['idle-timeout'])
})

test('activity keeps a connection alive across what would have been a timeout', async (t) => {
  const { port, closes } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  for (let i = 1; i <= 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 0.6))
    await client.write(`GET /r${i} HTTP/1.1\r\nHost: x\r\n\r\n`)
    await client.read(untilResponses(i))
  }

  assert.equal(client.closed, false)
  assert.deepEqual(closes, [])
})

test('a client that stalls mid-response gets no 408, because the status line is spent', async (t) => {
  const { port, closes } = await started(t, (exchange) => {
    // Head out immediately, body never finished: the response has already claimed the only
    // status line this exchange has, and a 408 written after it would be read as body bytes.
    exchange.response.writeHead({ status: 200, framing: { kind: 'chunked' } })
    exchange.response.write('partial')
  })
  const client = await connect(port)
  t.after(() => client.close())

  await client.write('POST /stall HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nab')

  const received = await settled(client)

  assert.match(received, /^HTTP\/1\.1 200 OK\r\n/)
  assert.equal(received.includes('408'), false, received)
  await waitFor(() => closes.length > 0, 'the server never tore the connection down')
  assert.deepEqual(closes, ['idle-timeout'])
})

test('the connection registry empties however the timeout lands', async (t) => {
  const { server, port } = await started(t)

  const clients = await Promise.all([connect(port), connect(port), connect(port)])
  t.after(() => Promise.all(clients.map((client) => client.close())))
  await clients[0]?.write('GET /one HTTP/1.1\r\nHost: x\r\n\r\n')
  await clients[1]?.write('GET /half HTTP/1.1\r\nHost: ')

  await Promise.all(clients.map((client) => settled(client)))
  await waitFor(() => server.connectionCount === 0, 'a timed-out connection stayed registered')

  assert.equal(server.connectionCount, 0)
})
