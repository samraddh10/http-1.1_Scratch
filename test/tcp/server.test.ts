// module 1.1  test/tcp/server.test.ts -- the accept loop and, mostly, shutdown
//
// Four of these tests are about `close()`. That is the right weighting: an accept loop
// that accepts is easy, and every one of the later phases runs its tests by starting a
// server and stopping it again. A `close()` that resolves only when the client happens to
// have disconnected does not fail here -- it fails as a test suite that hangs in phase 9
// with no indication of which server was left running.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createNetServer } from 'node:net'
import { once } from 'node:events'

import { createTcpServer, type TcpServer, type TcpServerOptions } from '../../server/tcp/server.js'
import { connect, untilIncludes, rawRequest } from '../helpers/raw-socket.js'

/**
 * Starts a server on an ephemeral port and registers its shutdown with the test context.
 *
 * Port 0 rather than a fixed port: these tests run in the same process as every other
 * suite and a hard-coded port turns an unrelated leaked server into a confusing
 * EADDRINUSE here.
 */
async function started(
  t: TestContext,
  options?: TcpServerOptions,
): Promise<{ server: TcpServer; port: number }> {
  const server = createTcpServer(options)
  const address = await server.listen(0)
  t.after(() => server.close())
  return { server, port: address.port }
}

/** Polls `condition` until it holds, for state that settles on a socket event. */
async function waitFor(condition: () => boolean, message: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`${message} (timed out after ${timeoutMs}ms)`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('listen resolves with the bound ephemeral port', async (t) => {
  const { server, port } = await started(t)

  assert.ok(port > 0, 'port 0 should have been replaced by a real one')
  assert.equal(server.listening, true)
  assert.equal(server.address()?.port, port)
})

test('address() is null and listening is false before listen', () => {
  const server = createTcpServer()

  assert.equal(server.address(), null)
  assert.equal(server.listening, false)
})

test('an accepted socket receives the bytes it is sent, and answers', async (t) => {
  const { port } = await started(t)

  const response = await rawRequest(port, 'hello', { until: untilIncludes('/') })

  // The default 1.1 handler answers `<chunk>/<total>`; five bytes in, five bytes counted.
  assert.equal(response.toString('latin1').trim(), '5/5')
})

test('byte counts accumulate across writes on one connection', async (t) => {
  const { port } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  await client.write('abc')
  await client.read(untilIncludes('3/3'))
  await client.write('de')
  const received = await client.read(untilIncludes('2/5'))

  // Proof the socket is stateful and the same handler is still on it -- the second write
  // was counted against the first one's total rather than starting over.
  assert.equal(received.toString('latin1'), '3/3\n2/5\n')
})

test('the handler passed in is the one that runs, once per socket', async (t) => {
  let accepted = 0
  const { port } = await started(t, {
    onConnection: (socket) => {
      accepted++
      socket.write('ok')
    },
  })

  const [first, second] = await Promise.all([
    rawRequest(port, '', { until: untilIncludes('ok') }),
    rawRequest(port, '', { until: untilIncludes('ok') }),
  ])

  assert.equal(first.toString('latin1'), 'ok')
  assert.equal(second.toString('latin1'), 'ok')
  assert.equal(accepted, 2)
})

test('connectionCount tracks open sockets and returns to zero when they close', async (t) => {
  const { server, port } = await started(t)

  const a = await connect(port)
  const b = await connect(port)
  await a.write('x')
  await b.write('x')
  await a.read(untilIncludes('/'))
  await b.read(untilIncludes('/'))

  assert.equal(server.connectionCount, 2)

  await a.close()
  await b.close()
  // The registry is emptied on the socket's 'close' event, which lands a tick after the
  // client's destroy, so wait for the count rather than reading it immediately.
  await waitFor(() => server.connectionCount === 0, 'connection count should return to 0')
})

test('close resolves even with an idle connection still open', async (t) => {
  // The one that matters. An idle keep-alive client will not disconnect on its own, so a
  // `close()` that merely waits for connections to end would sit here until the test
  // runner's timeout.
  const { server, port } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  await client.write('x')
  await client.read(untilIncludes('/'))
  assert.equal(server.connectionCount, 1)

  await server.close()

  assert.equal(server.listening, false)
  assert.equal(server.connectionCount, 0)
  // The client sees the server's destroy as its own connection closing.
  await waitFor(() => client.closed, 'the client socket should have been closed by the server')
})

test('close is idempotent and safe before listen', async () => {
  const never = createTcpServer()
  await never.close()

  const server = createTcpServer()
  await server.listen(0)
  await Promise.all([server.close(), server.close()])
  await server.close()

  assert.equal(server.listening, false)
})

test('a closed server stops accepting', async () => {
  const server = createTcpServer()
  const { port } = await server.listen(0)
  await server.close()

  await assert.rejects(
    () => connect(port),
    (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED',
    'the port should no longer accept connections',
  )
})

test('listen rejects when the port is already taken', async (t) => {
  const blocker = createNetServer()
  blocker.listen(0, '127.0.0.1')
  await once(blocker, 'listening')
  const taken = blocker.address()
  assert.ok(taken !== null && typeof taken !== 'string')
  t.after(() => new Promise((resolve) => blocker.close(() => resolve(undefined))))

  const server = createTcpServer()
  t.after(() => server.close())

  // A bind failure arrives as an 'error' event on the net.Server, so the only way this
  // rejects rather than crashing the process is the temporary listener in listen().
  await assert.rejects(
    () => server.listen(taken.port),
    (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE',
  )
  assert.equal(server.listening, false)
})

test('listen twice is an error, not a second bind', async (t) => {
  const { server } = await started(t)

  await assert.rejects(() => server.listen(0), /already listening/)
})

test('an abrupt client reset does not take the process down', async (t) => {
  // ECONNRESET on a socket with no 'error' listener is an uncaught exception. On Windows
  // this is the normal way a client disappearing presents, so it is not an edge case here.
  const { server, port } = await started(t)
  const client = await connect(port)

  await client.write('x')
  await client.read(untilIncludes('/'))
  await client.close()

  await waitFor(() => server.connectionCount === 0, 'the reset socket should be deregistered')
  assert.equal(server.listening, true, 'the server should still be up')

  // Still serving afterwards is the real assertion -- a crashed process cannot answer.
  const response = await rawRequest(port, 'ok', { until: untilIncludes('/') })
  assert.equal(response.toString('latin1').trim(), '2/2')
})
