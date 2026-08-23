// module 1.4  test/tcp/backpressure.test.ts -- a peer that stops reading must not cost memory

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { createTcpServer, type TcpServer } from '../../server/tcp/server.js'
import type { CloseReason, Connection } from '../../server/tcp/connection.js'
import { connect, untilBytes, untilClose, type RawConnection } from '../helpers/raw-socket.js'

const CHUNK_BYTES = 64 * 1024
const TOTAL_BYTES = 8 * 1024 * 1024

interface Started {
  server: TcpServer
  port: number
  closes: { connection: Connection; reason: CloseReason }[]
}

/** A server that hands the accepted connection back and never writes on its own. */
async function started(t: TestContext, idleTimeoutMs?: number): Promise<Started> {
  const closes: Started['closes'] = []
  const options = {
    onData: () => undefined,
    onClose: (connection: Connection, reason: CloseReason) => void closes.push({ connection, reason }),
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
  }

  const server = createTcpServer(options)
  const address = await server.listen(0)
  t.after(() => server.close())
  return { server, port: address.port, closes }
}

/** The accepted connection for a client, once the accept callback has run. */
async function accepted(server: TcpServer, timeoutMs = 1_000): Promise<Connection> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [connection] = server.connections()
    if (connection) return connection
    if (Date.now() > deadline) assert.fail('the server never accepted the connection')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function waitFor(condition: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`${message} (timed out after ${timeoutMs}ms)`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A recognisable byte pattern, so a reordered or dropped chunk is visible in the output. */
function pattern(offset: number, length: number): Buffer {
  return Buffer.from(Array.from({ length }, (_, i) => (offset + i) % 251))
}

async function pausedClient(t: TestContext, port: number): Promise<RawConnection> {
  const client = await connect(port, '127.0.0.1', { paused: true })
  t.after(() => client.close())
  return client
}

test('a peer that stops reading makes write() refuse', async (t) => {
  const { server, port } = await started(t)
  const client = await pausedClient(t, port)
  const connection = await accepted(server)

  let written = 0
  while (connection.write(pattern(written, CHUNK_BYTES))) {
    written += CHUNK_BYTES
    assert.ok(written < TOTAL_BYTES, 'write() never refused; the send buffer cannot be infinite')
  }

  assert.ok(connection.needsDrain, 'a refused write must leave the connection waiting on drain')
  assert.ok(connection.pendingBytes > 0, 'the refused bytes are queued, not lost')
})

test('a producer that parks on false keeps memory bounded and bytes in order', async (t) => {
  // The claim this whole subphase exists for. 8 MB goes through a socket whose peer is not
  // reading at all; the only thing keeping it out of memory is the producer honouring the
  // false return and waiting for drain.
  const { server, port } = await started(t)
  const client = await pausedClient(t, port)
  const connection = await accepted(server)

  let peakPending = 0
  let parked = 0

  const produce = (async () => {
    for (let offset = 0; offset < TOTAL_BYTES; offset += CHUNK_BYTES) {
      const accepting = connection.write(pattern(offset, CHUNK_BYTES))
      peakPending = Math.max(peakPending, connection.pendingBytes)
      if (!accepting) {
        parked++
        await connection.whenDrained()
      }
    }
    connection.end('server-shutdown')
  })()

  // Nothing drains until the client starts reading, so the producer is genuinely blocked
  // rather than racing ahead of a fast reader.
  await waitFor(() => parked > 0, 'the producer should have been parked by the paused peer')
  client.resume()

  await produce
  const received = await client.read(untilClose, { timeoutMs: 30_000 })

  assert.equal(received.length, TOTAL_BYTES, 'every byte written must arrive')
  assert.deepEqual(received, pattern(0, TOTAL_BYTES), 'bytes must arrive in the order written')
  assert.ok(parked > 1, `the producer parked only ${parked} time(s); the test proved nothing`)
  assert.ok(
    peakPending < TOTAL_BYTES / 8,
    `queued ${peakPending} bytes of an ${TOTAL_BYTES} byte stream; memory is tracking volume`,
  )
})

test('whenDrained resolves once, and immediately when there is nothing to wait for', async (t) => {
  const { server, port } = await started(t)
  const client = await pausedClient(t, port)
  const connection = await accepted(server)

  await connection.whenDrained()
  assert.equal(connection.needsDrain, false, 'an idle connection is not waiting on anything')

  let written = 0
  while (connection.write(pattern(written, CHUNK_BYTES))) written += CHUNK_BYTES
  written += CHUNK_BYTES

  const first = connection.whenDrained()
  const second = connection.whenDrained()
  client.resume()
  await Promise.all([first, second])

  assert.equal(connection.needsDrain, false)
  const received = await client.read(untilBytes(written), { timeoutMs: 10_000 })
  assert.equal(received.length, written)
})

test('flush callbacks fire in write order', async (t) => {
  const { server, port } = await started(t)
  const client = await pausedClient(t, port)
  const connection = await accepted(server)

  const flushed: number[] = []
  const errors: (Error | undefined)[] = []
  for (let i = 0; i < 40; i++) {
    connection.write(pattern(i * CHUNK_BYTES, CHUNK_BYTES), (error) => {
      flushed.push(i)
      errors.push(error)
    })
  }

  client.resume()
  await waitFor(() => flushed.length === 40, 'every chunk should have been flushed')

  assert.deepEqual(flushed, Array.from({ length: 40 }, (_, i) => i))
  assert.deepEqual(errors.filter(Boolean), [], 'no chunk should have failed')
})

test('end() flushes what is queued; destroy() does not', async (t) => {
  const graceful = await started(t)
  const readerA = await pausedClient(t, graceful.port)
  const connectionA = await accepted(graceful.server)

  const payload = pattern(0, 256 * 1024)
  connectionA.write(payload)
  connectionA.end('server-shutdown')
  readerA.resume()

  const received = await readerA.read(untilClose, { timeoutMs: 10_000 })
  assert.deepEqual(received, payload, 'end() must not truncate a response written before it')

  // The client sees the FIN before the server sees the answering one, so the server-side
  // teardown is still in flight at this point.
  await waitFor(() => graceful.closes.length > 0, 'the flushed connection should have closed')
  assert.equal(graceful.closes[0]?.reason, 'server-shutdown', 'the close reason survives the flush')

  const abrupt = await started(t)
  const readerB = await pausedClient(t, abrupt.port)
  const connectionB = await accepted(abrupt.server)

  // Enough that the queue cannot be an artefact of kernel buffer sizes: write until the
  // socket refuses, then keep going, so several megabytes are provably still held.
  let queued = 0
  while (connectionB.write(pattern(queued, CHUNK_BYTES))) queued += CHUNK_BYTES
  for (; queued < 4 * 1024 * 1024; queued += CHUNK_BYTES) {
    connectionB.write(pattern(queued, CHUNK_BYTES))
  }
  assert.ok(connectionB.pendingBytes > 0, 'the test needs a real queue to discard')

  connectionB.destroy('server-shutdown')
  readerB.resume()

  await readerB.read(untilClose, { timeoutMs: 10_000 })
  assert.equal(connectionB.pendingBytes, 0, 'destroy() reports nothing pending, it does not drain')
  assert.ok(
    readerB.received().length < queued,
    'destroy() discards the queue, so it cannot have delivered all of it',
  )
})

test('teardown mid-write settles the waiting producer instead of hanging it', async (t) => {
  const { server, port } = await started(t)
  await pausedClient(t, port)
  const connection = await accepted(server)

  const failures: Error[] = []
  let written = 0
  while (connection.write(pattern(written, CHUNK_BYTES), (error) => error && failures.push(error))) {
    written += CHUNK_BYTES
  }

  const waiting = connection.whenDrained()
  connection.destroy('client-error')

  await assert.rejects(waiting, /connection closed/, 'a parked producer must be told, not left waiting')
  assert.equal(connection.write(pattern(0, 16)), false, 'writes after teardown refuse')

  let refused: Error | undefined
  connection.write(pattern(0, 16), (error) => (refused = error))
  assert.match(String(refused), /closed/, 'a refused write reports through its flush callback')

  await waitFor(() => failures.length > 0, 'the discarded queue should have failed its callbacks')
})

test('a peer that never reads is reclaimed by the idle timeout', async (t) => {
  // Bounded memory is only half of it. Nothing ever drains here, so without the idle
  // timeout the socket and everything queued on it would be held forever.
  const { server, port, closes } = await started(t, 150)
  await pausedClient(t, port)
  const connection = await accepted(server)

  let written = 0
  while (connection.write(pattern(written, CHUNK_BYTES))) written += CHUNK_BYTES

  await waitFor(() => closes.length > 0, 'the idle timeout should have reclaimed the stalled socket')

  assert.equal(closes[0]?.reason, 'idle-timeout')
  assert.equal(connection.pendingBytes, 0, 'a closed connection reports nothing pending')
  assert.equal(server.connectionCount, 0)
})
