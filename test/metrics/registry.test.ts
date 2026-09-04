// module 7.1  test/metrics/registry.test.ts -- the counters, the rolling window, the ratio

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MetricsRegistry,
  type LiveConnections,
  type RequestSample,
} from '../../server/metrics/registry.js'

const NO_CONNECTIONS: LiveConnections = { refused: 0, connections: [] }

/** A clock the test moves by hand, so the five-second window is exercised in no time. */
function clockAt(startMs: number): { now: () => number; advance(ms: number): void } {
  let at = startMs
  return {
    now: () => at,
    advance(ms) {
      at += ms
    },
  }
}

function sampleOf(overrides: Partial<RequestSample> = {}): RequestSample {
  return {
    at: 0,
    connectionId: 1,
    sequence: 1,
    head: 'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n',
    method: 'GET',
    target: '/',
    path: '/',
    query: '',
    httpVersion: '1.1',
    headers: { host: 'localhost' },
    framing: { kind: 'none' },
    status: 200,
    durationMs: 1,
    ...overrides,
  }
}

test('an interim response is not an answered request', () => {
  const registry = new MetricsRegistry()

  registry.responseWritten(100)
  registry.responseWritten(200)

  const snapshot = registry.snapshot(NO_CONNECTIONS)
  assert.equal(snapshot.requests.total, 1)
  assert.deepEqual(snapshot.statusCounts, { '200': 1 })
})

test('status counts are per code, in ascending order', () => {
  const registry = new MetricsRegistry()

  for (const status of [404, 200, 500, 200, 404, 200]) registry.responseWritten(status)

  const { statusCounts } = registry.snapshot(NO_CONNECTIONS)
  assert.deepEqual(statusCounts, { '200': 3, '404': 2, '500': 1 })
  assert.deepEqual(Object.keys(statusCounts), ['200', '404', '500'])
})

test('requests per second averages over the five-second window', () => {
  const clock = clockAt(1_000_000)
  const registry = new MetricsRegistry({ now: clock.now })

  for (let i = 0; i < 10; i++) registry.responseWritten(200)

  assert.equal(registry.snapshot(NO_CONNECTIONS).requests.perSecond, 2)

  clock.advance(1_000)
  for (let i = 0; i < 5; i++) registry.responseWritten(200)

  assert.equal(registry.snapshot(NO_CONNECTIONS).requests.perSecond, 3)
})

/**
 * The bug this catches is silent and arithmetic: with one slot per second of the window,
 * second 1000 and second 1005 land on the same slot. A slot read without checking which
 * second it was written for reports five-second-old traffic as current, forever.
 */
test('a slot older than the window is stale, not current', () => {
  const clock = clockAt(1_000_000)
  const registry = new MetricsRegistry({ now: clock.now })

  for (let i = 0; i < 10; i++) registry.responseWritten(200)
  assert.equal(registry.snapshot(NO_CONNECTIONS).requests.perSecond, 2)

  clock.advance(5_000)
  assert.equal(registry.snapshot(NO_CONNECTIONS).requests.perSecond, 0)

  // The total is cumulative and the window is not; only one of them forgets.
  assert.equal(registry.snapshot(NO_CONNECTIONS).requests.total, 10)
})

test('requests spread across the window all count until they age out', () => {
  const clock = clockAt(1_000_000)
  const registry = new MetricsRegistry({ now: clock.now })

  for (let i = 0; i < 5; i++) {
    registry.responseWritten(200)
    clock.advance(1_000)
  }

  // Seconds 1..4 are still inside the window; the one written at second 0 has aged out.
  assert.equal(registry.snapshot(NO_CONNECTIONS).requests.perSecond, 4 / 5)
})

test('keep-alive reuse is the fraction of requests that did not cost a connection', () => {
  const reused = new MetricsRegistry()
  reused.connectionOpened()
  for (let i = 0; i < 20; i++) reused.responseWritten(200)
  assert.equal(reused.snapshot(NO_CONNECTIONS).requests.keepAliveReuse, 0.95)

  const fresh = new MetricsRegistry()
  for (let i = 0; i < 20; i++) {
    fresh.connectionOpened()
    fresh.responseWritten(200)
  }
  assert.equal(fresh.snapshot(NO_CONNECTIONS).requests.keepAliveReuse, 0)
})

test('open connections that have asked for nothing read as no reuse', () => {
  const registry = new MetricsRegistry()
  for (let i = 0; i < 10; i++) registry.connectionOpened()

  assert.equal(registry.snapshot(NO_CONNECTIONS).requests.keepAliveReuse, 0)

  registry.responseWritten(200)
  assert.equal(registry.snapshot(NO_CONNECTIONS).requests.keepAliveReuse, 0)
})

test('the live half of a snapshot is read through, not accumulated', () => {
  const registry = new MetricsRegistry()
  registry.connectionOpened()
  registry.connectionOpened()

  const live: LiveConnections = {
    refused: 7,
    connections: [
      { id: 1, requestsServed: 20, idleMs: 12, ageMs: 4_000, bytesRead: 900, bytesWritten: 4_100 },
      { id: 2, requestsServed: 1, idleMs: 3, ageMs: 40, bytesRead: 80, bytesWritten: 120 },
    ],
  }

  const snapshot = registry.snapshot(live)
  assert.equal(snapshot.connections.open, 2)
  assert.equal(snapshot.connections.accepted, 2)
  assert.equal(snapshot.connections.refused, 7)
  assert.deepEqual(snapshot.connections.rows, live.connections)
})

test('the recent ring is bounded by its configured size and reports newest first', () => {
  const registry = new MetricsRegistry({ recentRequestsBufferSize: 3 })

  for (let sequence = 1; sequence <= 10; sequence++) {
    registry.requestServed(sampleOf({ sequence, target: `/${sequence}` }))
  }

  const { recent } = registry.snapshot(NO_CONNECTIONS)
  assert.equal(recent.length, 3)
  assert.deepEqual(
    recent.map((sample) => sample.target),
    ['/10', '/9', '/8'],
  )
})
