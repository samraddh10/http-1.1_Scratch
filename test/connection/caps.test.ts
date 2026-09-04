// module 4.3  test/connection/caps.test.ts -- the two ceilings: sockets, and requests per socket

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { defaults, type Config } from '../../server/config.js'
import { serveHttp, type Exchange } from '../../server/http/connection.js'
import { createTcpServer, type TcpServer } from '../../server/tcp/server.js'
import type { CloseReason } from '../../server/tcp/connection.js'
import { connect, untilClose, untilResponses, type RawConnection } from '../helpers/raw-socket.js'

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
  overrides: { maxConnections?: number; maxRequestsPerConnection?: number } = {},
): Promise<Started> {
  const closes: CloseReason[] = []
  const config: Config = { ...defaults, ...overrides }

  const server = createTcpServer({
    ...serveHttp({
      listener: echoRequestLine,
      config,
      onConnectionClose: (_connection, reason) => closes.push(reason),
    }),
    ...(overrides.maxConnections === undefined ? {} : { maxConnections: overrides.maxConnections }),
  })

  const address = await server.listen(0)
  t.after(() => server.close())
  return { server, port: address.port, closes }
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function request(client: RawConnection, path: string, count: number): Promise<string> {
  await client.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`)
  return (await client.read(untilResponses(count))).toString('latin1')
}

test('a socket past the connection cap is closed on arrival, unread and unanswered', async (t) => {
  const { server, port } = await started(t, { maxConnections: 2 })

  const held = await Promise.all([connect(port), connect(port)])
  t.after(() => Promise.all(held.map((client) => client.close())))
  await waitFor(() => server.connectionCount === 2, 'the first two connections were not accepted')

  const refused = await connect(port)
  t.after(() => refused.close())

  // Nothing is written back. At the accept limit there is no capacity to read a request or
  // frame a 503 either, so the client is told the only way that costs the server nothing.
  const received = await refused.read(untilClose, { timeoutMs: 2_000 })

  assert.equal(received.length, 0, received.toString('latin1'))
  assert.equal(refused.closed, true)
  assert.equal(server.connectionCount, 2, 'a refused socket was registered anyway')
  assert.equal(server.refusedConnections, 1)
})

test('connections already accepted keep working while the server is at its cap', async (t) => {
  const { server, port } = await started(t, { maxConnections: 1 })

  const held = await connect(port)
  t.after(() => held.close())
  await waitFor(() => server.connectionCount === 1, 'the first connection was not accepted')

  const refused = await connect(port)
  t.after(() => refused.close())
  await refused.read(untilClose, { timeoutMs: 2_000 })

  assert.match(await request(held, '/still-fine', 1), /GET \/still-fine$/)
})

test('a freed slot is given to the next connection', async (t) => {
  const { server, port } = await started(t, { maxConnections: 1 })

  const first = await connect(port)
  await waitFor(() => server.connectionCount === 1, 'the first connection was not accepted')
  await first.close()
  await waitFor(() => server.connectionCount === 0, 'the slot was never released')

  const second = await connect(port)
  t.after(() => second.close())

  assert.match(await request(second, '/mine-now', 1), /GET \/mine-now$/)
  assert.equal(server.refusedConnections, 0)
})

test('the last request the cap allows is answered, and carries the close', async (t) => {
  const { port, closes } = await started(t, { maxRequestsPerConnection: 3 });
  const client = await connect(port)
  t.after(() => client.close())

  const first = await request(client, '/one', 1)
  const second = await request(client, '/two', 2)
  assert.equal(/^connection:/im.test(first), false, first)
  assert.equal(/^connection:/im.test(second), false, second)

  // The third is served in full -- the cap bounds how long one client holds a slot, it does
  // not cut a request short -- and says on that response that it was the last.
  const third = (await request(client, '/three', 3)).slice(second.length)
  assert.match(third, /^HTTP\/1\.1 200 OK\r\n/)
  assert.match(third, /\r\nConnection: close\r\n/)
  assert.equal(third.endsWith('GET /three'), true, third)

  await client.read(untilClose, { timeoutMs: 2_000 })
  await waitFor(() => closes.length > 0, 'the server never tore the connection down')
  assert.deepEqual(closes, ['end-of-exchange'])
})

test('the cap counts requests opened, so pipelining cannot slip past it', async (t) => {
  const { port } = await started(t, { maxRequestsPerConnection: 2 })
  const client = await connect(port)
  t.after(() => client.close())

  // Three at once against a cap of two: the first two are answered, the third is not read.
  await client.write(
    'GET /one HTTP/1.1\r\nHost: x\r\n\r\nGET /two HTTP/1.1\r\nHost: x\r\n\r\n' +
      'GET /three HTTP/1.1\r\nHost: x\r\n\r\n',
  )

  const received = (await client.read(untilClose, { timeoutMs: 2_000 })).toString('latin1')

  assert.deepEqual(received.match(/GET \/[a-z]+(?=HTTP\/|$)/g), ['GET /one', 'GET /two'])
  assert.equal(received.match(/\r\nConnection: close\r\n/g)?.length, 1, received)
})

test('a cap of one closes after the very first request', async (t) => {
  const { port } = await started(t, { maxRequestsPerConnection: 1 })
  const client = await connect(port)
  t.after(() => client.close())

  const received = await request(client, '/only', 1)

  assert.match(received, /\r\nConnection: close\r\n/)
  assert.equal(received.endsWith('GET /only'), true, received)
  assert.equal(await client.read(untilClose, { timeoutMs: 2_000 }).then(() => client.closed), true)
})
