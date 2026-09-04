// module 7.3  test/metrics/endpoints.test.ts -- the snapshot endpoint and the SSE stream

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import express from 'express'

import { createRoutes } from '../../app/routes.js'
import { createServer } from '../../server/index.js'
import {
  MetricsRegistry,
  liveConnections,
  type MetricsSnapshot,
} from '../../server/metrics/registry.js'
import { connect, rawRequest, untilIncludes } from '../helpers/raw-socket.js'

const STREAM_INTERVAL_MS = 25

interface Started {
  port: number
  /** How many snapshots the routes have asked for, which is how a stale timer is caught. */
  taken(): number
}

async function started(t: TestContext): Promise<Started> {
  const registry = new MetricsRegistry()
  let taken = 0

  const app = express()
  app.use(express.json())

  const server = createServer({ metrics: registry }, app as never)

  const snapshot = (): MetricsSnapshot => {
    taken++
    return registry.snapshot(liveConnections(server.tcp))
  }
  app.use(createRoutes({ snapshot, intervalMs: STREAM_INTERVAL_MS }))

  server.listen(0)
  const address = await server.ready()
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))

  return { port: address.port, taken: () => taken }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The `data:` payloads out of an SSE body, decoded. */
function events(received: Buffer): MetricsSnapshot[] {
  const out: MetricsSnapshot[] = []
  for (const line of received.toString('latin1').split('\n')) {
    if (line.startsWith('data: ')) out.push(JSON.parse(line.slice(6)) as MetricsSnapshot)
  }
  return out
}

test('GET /api/metrics answers with the snapshot as JSON', async (t) => {
  const { port } = await started(t)

  await rawRequest(port, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
  const received = await rawRequest(
    port,
    'GET /api/metrics HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
  )

  const text = received.toString('latin1')
  assert.ok(text.startsWith('HTTP/1.1 200 '), text)
  assert.match(text, /Content-Type: application\/json/i)

  const body = text.slice(text.indexOf('\r\n\r\n') + 4)
  const snapshot = JSON.parse(body) as MetricsSnapshot

  // The demo request above is already in it, which is the point of a live endpoint.
  assert.equal(snapshot.requests.total, 1)
  assert.deepEqual(snapshot.statusCounts, { '200': 1 })
  assert.equal(snapshot.connections.accepted, 2)
  assert.equal(snapshot.recent.length, 1)
})

/**
 * The claim of the subphase: an open-ended response, framed by my own chunked encoding,
 * pushing repeatedly. A Content-Length here would mean the whole thing had been buffered.
 */
test('the stream is chunked, unbounded, and pushes more than once', async (t) => {
  const { port } = await started(t)

  const client = await connect(port)
  t.after(() => client.close())

  await client.write('GET /api/metrics/stream HTTP/1.1\r\nHost: x\r\n\r\n')
  const head = await client.read(untilIncludes('\r\n\r\n'))
  const headText = head.toString('latin1')

  assert.ok(headText.startsWith('HTTP/1.1 200 '), headText)
  assert.match(headText, /Content-Type: text\/event-stream/i)
  assert.match(headText, /Transfer-Encoding: chunked/i)
  assert.doesNotMatch(headText, /Content-Length:/i)

  await client.read((received) => events(received).length >= 3)

  const seen = events(client.received())
  assert.ok(seen.length >= 3, `only ${seen.length} events arrived`)
  assert.ok(seen[1] !== undefined && seen[1].at >= (seen[0]?.at ?? 0))

  // Still open: nothing has framed an end to this response.
  assert.equal(client.closed, false)
})

/**
 * A timer per tab ever opened, each writing into a socket that is gone, is the failure this
 * catches -- and it is silent, because writing to a dead response throws nothing.
 */
test('the interval stops when the viewer disconnects', async (t) => {
  const { port, taken } = await started(t)

  const client = await connect(port)
  await client.write('GET /api/metrics/stream HTTP/1.1\r\nHost: x\r\n\r\n')
  await client.read((received) => events(received).length >= 2)

  await client.close()
  await sleep(STREAM_INTERVAL_MS * 4)

  const afterClose = taken()
  await sleep(STREAM_INTERVAL_MS * 4)

  assert.equal(taken(), afterClose, 'the interval kept firing after the viewer left')
})
