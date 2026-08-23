// module 1.2  test/tcp/connection.test.ts -- one teardown path, however the socket dies

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { createTcpServer, type TcpServer, type TcpServerOptions } from '../../server/tcp/server.js'
import { Connection, type CloseReason } from '../../server/tcp/connection.js'
import { connect, untilIncludes } from '../helpers/raw-socket.js'

interface Started {
  server: TcpServer
  port: number
  closes: { connection: Connection; reason: CloseReason }[]
  opened: Connection[]
}

async function started(t: TestContext, options: TcpServerOptions = {}): Promise<Started> {
  const closes: Started['closes'] = []
  const opened: Connection[] = []

  const server = createTcpServer({
    ...options,
    onConnection: (connection) => {
      opened.push(connection)
      options.onConnection?.(connection)
    },
    onClose: (connection, reason) => {
      closes.push({ connection, reason })
      options.onClose?.(connection, reason)
    },
  })

  const address = await server.listen(0)
  t.after(() => server.close())
  return { server, port: address.port, closes, opened }
}

async function waitFor(condition: () => boolean, message: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`${message} (timed out after ${timeoutMs}ms)`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('byte accounting is per connection and counts both directions', async (t) => {
  const { port, opened } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  await client.write('abcde')
  await client.read(untilIncludes('/'))

  const connection = opened[0]
  assert.ok(connection)
  assert.equal(connection.bytesRead, 5)
  assert.equal(connection.bytesWritten, 4)
})
test('a clean client FIN tears the connection down exactly once', async (t) => {
  const { server, port, closes, opened } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  await client.write('x')
  await client.read(untilIncludes('/'))
  await client.end()

  await waitFor(() => closes.length > 0, 'onClose should have fired')
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(closes.length, 1, 'teardown ran more than once')
  assert.equal(closes[0]?.reason, 'client-end')
  assert.equal(closes[0]?.connection, opened[0])
  assert.equal(server.connectionCount, 0)
  assert.equal(opened[0]?.closed, true)
})

test('an abrupt reset tears down once, and records the error', async (t) => {
  // 'error' and 'close' both fire here, and on Windows the error arrives where Linux
  // delivers a FIN. Whichever lands first, teardown must run once.
  const { server, port, closes } = await started(t)
  const client = await connect(port)

  await client.write('x')
  await client.read(untilIncludes('/'))
  await client.close()

  await waitFor(() => closes.length > 0, 'onClose should have fired')
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(closes.length, 1)
  assert.ok(
    closes[0]?.reason === 'client-end' || closes[0]?.reason === 'client-error',
    `unexpected close reason ${String(closes[0]?.reason)}`,
  )
  assert.equal(server.connectionCount, 0)
})

test('server shutdown tears down open connections with its own reason', async (t) => {
  const { server, port, closes } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  await client.write('x')
  await client.read(untilIncludes('/'))
  assert.equal(server.connectionCount, 1)

  await server.close()

  assert.equal(closes.length, 1)
  assert.equal(closes[0]?.reason, 'server-shutdown')
  assert.equal(server.connectionCount, 0, 'the registry empties synchronously with teardown')
})

test('destroy is idempotent and the first reason wins', async (t) => {
  const { port, opened, closes } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  await client.write('x')
  await client.read(untilIncludes('/'))
  const connection = opened[0]
  assert.ok(connection)

  connection.destroy('idle-timeout')
  connection.destroy('server-shutdown')
  connection.destroy('client-end')

  assert.equal(closes.length, 1)
  assert.equal(connection.closeReason, 'idle-timeout')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(closes.length, 1, 'the socket close event must not re-run teardown')
})

test('the idle timeout fires teardown and leaves no handle behind', async (t) => {
  const { server, port, closes } = await started(t, { idleTimeoutMs: 60 })
  const client = await connect(port)
  t.after(() => client.close())

  await client.write('x')
  await client.read(untilIncludes('/'))

  await waitFor(() => closes.length > 0, 'the idle timeout should have torn the connection down', 2_000)

  assert.equal(closes[0]?.reason, 'idle-timeout')
  assert.equal(server.connectionCount, 0)

  // A live socket timer keeps the event loop alive; the test runner would hang rather
  // than fail if this were wrong, so assert the socket is finished with instead.
  assert.equal(closes[0]?.connection.socket.destroyed, true)
})

test('no data or writes reach a closed connection', async (t) => {
  const received: number[] = []
  const { port, opened } = await started(t, {
    onData: (connection, chunk) => {
      received.push(chunk.length)
      connection.write('ack')
    },
  })
  const client = await connect(port)
  t.after(() => client.close())

  await client.write('x')
  await client.read(untilIncludes('ack'))
  const connection = opened[0]
  assert.ok(connection)

  const writtenBefore = connection.bytesWritten
  connection.destroy('server-shutdown')

  assert.equal(connection.write('more'), false, 'write after teardown should refuse')
  assert.equal(connection.bytesWritten, writtenBefore, 'a refused write must not be counted')

  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(received, [1], 'no further data should have been dispatched')
})