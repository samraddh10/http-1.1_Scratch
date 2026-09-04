// module 7.2  test/metrics/instrumentation.test.ts -- the numbers move under real traffic

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { serveHttp, type Exchange } from '../../server/http/connection.js'
import {
  MetricsRegistry,
  liveConnections,
  type MetricsSnapshot,
} from '../../server/metrics/registry.js'
import { createTcpServer } from '../../server/tcp/server.js'
import {
  connect,
  rawRequest,
  untilClose,
  untilIncludes,
  untilResponses,
} from '../helpers/raw-socket.js'

/** Answers with the path it read, so a response can be tied back to its request. */
function echoPath(exchange: Exchange): void {
  exchange.response.end(exchange.head.path)
}

/** Reads the whole body before answering, which is what a 100-continue client waits for. */
function echoBody(exchange: Exchange): void {
  const chunks: Buffer[] = []
  exchange.onBodyChunk = (chunk) => chunks.push(chunk)
  exchange.onRequestComplete = () => exchange.response.end(Buffer.concat(chunks))
}

interface Started {
  port: number
  snapshot(): MetricsSnapshot
  /** Resolves the next time a connection closes, so `open` can be asserted after one does. */
  nextClose(): Promise<void>
}

async function started(
  t: TestContext,
  options: { listener?: (exchange: Exchange) => void; maxConnections?: number } = {},
): Promise<Started> {
  const registry = new MetricsRegistry()
  const waiting: Array<() => void> = []

  const server = createTcpServer({
    ...serveHttp({
      listener: options.listener ?? echoPath,
      metrics: registry,
      onConnectionClose: () => {
        for (const resolve of waiting.splice(0)) resolve()
      },
    }),
    ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
  })

  const address = await server.listen(0)
  t.after(() => server.close())

  return {
    port: address.port,
    snapshot: () => registry.snapshot(liveConnections(server)),
    nextClose: () => new Promise<void>((resolve) => waiting.push(resolve)),
  }
}

function get(path: string, headers = ''): string {
  return `GET ${path} HTTP/1.1\r\nHost: x\r\n${headers}\r\n`
}

/**
 * The claim the dashboard's connection panel makes: one socket, many requests. Every number
 * on the panel is asserted from the same snapshot, because the failure worth catching is one
 * counter moving while another does not.
 */
test('one connection serving five requests moves every counter it should', async (t) => {
  const { port, snapshot, nextClose } = await started(t)

  const client = await connect(port)
  for (let i = 1; i <= 5; i++) await client.write(get(`/r${i}`))
  await client.read(untilResponses(5))

  const busy = snapshot()
  assert.equal(busy.connections.accepted, 1)
  assert.equal(busy.connections.open, 1)
  assert.equal(busy.connections.refused, 0)
  assert.equal(busy.requests.total, 5)
  assert.deepEqual(busy.statusCounts, { '200': 5 })

  // Five requests, one connection: four of them did not cost one.
  assert.equal(busy.requests.keepAliveReuse, 0.8)
  assert.ok(busy.requests.perSecond > 0, 'the rolling window was never fed')

  const [row] = busy.connections.rows
  assert.ok(row !== undefined, 'the open connection is missing from the snapshot')
  assert.equal(row.requestsServed, 5)
  assert.ok(row.idleMs >= 0 && row.ageMs >= row.idleMs)
  assert.ok(row.bytesRead > 0 && row.bytesWritten > 0)

  assert.deepEqual(
    busy.recent.map((sample) => sample.target),
    ['/r5', '/r4', '/r3', '/r2', '/r1'],
  )
  assert.deepEqual(
    busy.recent.map((sample) => sample.sequence),
    [5, 4, 3, 2, 1],
  )
  assert.equal(new Set(busy.recent.map((sample) => sample.connectionId)).size, 1)

  const closed = nextClose()
  await client.close()
  await closed

  // The gauge is live and the totals are not: one forgets the socket, the other does not.
  const idle = snapshot()
  assert.equal(idle.connections.open, 0)
  assert.deepEqual(idle.connections.rows, [])
  assert.equal(idle.connections.accepted, 1)
  assert.equal(idle.requests.total, 5)
})

/**
 * A malformed request never opens an exchange, so module 4 has nothing to record. Counting
 * responses in module 3 instead is what keeps it visible -- and the status panel showing
 * nothing while a client hammers the server with garbage is exactly the failure that would
 * matter.
 */
test('a protocol error is counted even though no exchange opened', async (t) => {
  const { port, snapshot } = await started(t)

  const received = await rawRequest(port, 'GET / HTTP/1.11\r\nHost: x\r\n\r\n')
  assert.ok(received.toString('latin1').startsWith('HTTP/1.1 400 '), received.toString('latin1'))

  const snap = snapshot()
  assert.deepEqual(snap.statusCounts, { '400': 1 })
  assert.equal(snap.requests.total, 1)
  assert.deepEqual(snap.recent, [], 'the inspector shows answered requests, and this was not one')
})

test('an interim response is not a second request', async (t) => {
  const { port, snapshot } = await started(t, { listener: echoBody })

  const client = await connect(port)
  await client.write(
    'POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n',
  )
  await client.read(untilIncludes('100 Continue'))
  await client.write('hi')
  await client.read(untilIncludes('200 OK'))

  const snap = snapshot()
  assert.deepEqual(snap.statusCounts, { '200': 1 }, 'the 100 was counted as a request')
  assert.equal(snap.requests.total, 1)
  assert.equal(snap.recent.length, 1)

  await client.close()
})

test('a socket refused at the cap is counted by the TCP layer, not as an accepted one', async (t) => {
  const { port, snapshot } = await started(t, { maxConnections: 1 })

  const held = await connect(port)
  t.after(() => held.close())
  await held.write(get('/'))
  await held.read(untilResponses(1))

  const refused = await connect(port)
  t.after(() => refused.close())
  assert.equal((await refused.read(untilClose)).length, 0)

  const snap = snapshot()
  assert.equal(snap.connections.refused, 1)
  assert.equal(snap.connections.accepted, 1, 'a refused socket was counted as accepted')
  assert.equal(snap.connections.open, 1)
})

/** The inspector's two panes: the head on the left, what the parser made of it on the right. */
test('a recorded sample carries the head and the parsed output', async (t) => {
  const { port, snapshot } = await started(t)

  const request =
    'GET /echo/42?debug=1 HTTP/1.1\r\nHost: x\r\nX-Trace: abc\r\nConnection: close\r\n\r\n'
  await rawRequest(port, request)

  const [sample] = snapshot().recent
  assert.ok(sample !== undefined, 'nothing was recorded')

  assert.equal(sample.head, request, 'the head does not match the bytes the client sent')

  assert.equal(sample.method, 'GET')
  assert.equal(sample.target, '/echo/42?debug=1')
  assert.equal(sample.path, '/echo/42')
  assert.equal(sample.query, 'debug=1')
  assert.equal(sample.httpVersion, '1.1')
  assert.deepEqual(sample.framing, { kind: 'none' })
  assert.equal(sample.headers['x-trace'], 'abc')
  assert.equal(sample.status, 200)
  assert.equal(sample.sequence, 1)
  assert.ok(sample.connectionId > 0)
  assert.ok(sample.durationMs >= 0)
})
