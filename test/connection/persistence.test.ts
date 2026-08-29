// module 4.1  test/connection/persistence.test.ts -- one socket, many requests, over real bytes

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { serveHttp, type Exchange } from '../../server/http/connection.js'
import { createTcpServer } from '../../server/tcp/server.js'
import type { CloseReason } from '../../server/tcp/connection.js'
import { connect, untilResponses, describe, type RawConnection } from '../helpers/raw-socket.js'

/** Answers with the request line it read, so a response can be tied to its request. */
function echoRequestLine(exchange: Exchange): void {
  exchange.response.end(`${exchange.head.method} ${exchange.head.path}`)
}

interface Started {
  port: number
  closes: CloseReason[]
}

async function started(
  t: TestContext,
  listener: (exchange: Exchange) => void = echoRequestLine,
): Promise<Started> {
  const closes: CloseReason[] = []
  const server = createTcpServer({
    ...serveHttp({ listener }),
    onClose: (_connection, reason) => closes.push(reason),
  })

  const address = await server.listen(0)
  t.after(() => server.close())
  return { port: address.port, closes }
}

function get(path: string, version = '1.1', headers = ''): string {
  return `GET ${path} ${version === '1.1' ? 'HTTP/1.1' : 'HTTP/1.0'}\r\nHost: x\r\n${headers}\r\n`
}

async function exchange(client: RawConnection, bytes: string, count: number): Promise<string> {
  await client.write(bytes)
  const received = await client.read(untilResponses(count))
  return received.toString('latin1')
}

async function closedWithin(client: RawConnection, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!client.closed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return client.closed
}

test('an HTTP/1.1 socket serves request after request without being asked to', async (t) => {
  const { port } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  for (let i = 1; i <= 3; i++) {
    const received = await exchange(client, get(`/r${i}`), i)
    assert.match(received, new RegExp(`GET /r${i}$`), describe(Buffer.from(received, 'latin1')))
  }

  assert.equal(client.closed, false)
  // Persistence is the default in 1.1, so saying so would be noise on every response.
  assert.equal(/^connection:/im.test(await exchange(client, get('/last'), 4)), false)
})

test('Connection: close from the client is answered and then obeyed', async (t) => {
  const { port, closes } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  const received = await exchange(client, get('/one', '1.1', 'Connection: close\r\n'), 1)

  assert.match(received, /^HTTP\/1\.1 200 OK\r\n/)
  assert.match(received, /\r\nConnection: close\r\n/)
  assert.equal(received.endsWith('GET /one'), true, describe(Buffer.from(received, 'latin1')))
  assert.equal(await closedWithin(client, 1_000), true, 'the server never closed the socket')
  assert.deepEqual(closes, ['end-of-exchange'])
})

test('an HTTP/1.0 request closes the connection unless it asks not to', async (t) => {
  const { port } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  const received = await exchange(client, get('/one', '1.0'), 1)

  assert.match(received, /\r\nConnection: close\r\n/)
  assert.equal(await closedWithin(client, 1_000), true)
})

test('an HTTP/1.0 client that asks for keep-alive gets it, and is told so', async (t) => {
  const { port } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  const first = await exchange(client, get('/one', '1.0', 'Connection: keep-alive\r\n'), 1)
  assert.match(first, /\r\nConnection: keep-alive\r\n/)

  const second = await exchange(client, get('/two', '1.0', 'Connection: keep-alive\r\n'), 2)
  assert.match(second, /GET \/two$/)
  assert.equal(client.closed, false)
})

test('a close the application asked for is a close that happens', async (t) => {
  const { port, closes } = await started(t, (exchange) => {
    exchange.response.writeHead({ status: 200, headers: { Connection: 'close' } })
    exchange.response.end('bye')
  })
  const client = await connect(port)
  t.after(() => client.close())

  const received = await exchange(client, get('/one'), 1)

  assert.equal(received.match(/\r\nConnection: close\r\n/g)?.length, 1, received)
  assert.equal(await closedWithin(client, 1_000), true)
  assert.deepEqual(closes, ['end-of-exchange'])
})

test('the connection counts the requests it served', async (t) => {
  const served: number[] = []
  const { port } = await started(t, (exchange) => {
    served.push(exchange.connection.requestsServed)
    exchange.response.end('ok')
  })
  const client = await connect(port)
  t.after(() => client.close())

  await exchange(client, get('/one'), 1)
  await exchange(client, get('/two'), 2)
  await exchange(client, get('/three'), 3)

  assert.deepEqual(served, [0, 1, 2])
})

test('two pipelined requests in one write are answered in order, once each', async (t) => {
  const { port } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  const received = await exchange(client, get('/one') + get('/two'), 2)
  // A pipelined body runs straight into the next status line, so the match has to stop
  // where the head begins rather than at the first non-word byte.
  const bodies = received.match(/GET \/[a-z0-9]+(?=HTTP\/|$)/g)

  assert.deepEqual(bodies, ['GET /one', 'GET /two'], describe(Buffer.from(received, 'latin1')))
})

test('a pipelined Connection: close ends the connection after its own response', async (t) => {
  const { port } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  await client.write(get('/one') + get('/two', '1.1', 'Connection: close\r\n') + get('/three'))
  assert.equal(await closedWithin(client, 1_000), true)

  const received = client.received().toString('latin1')
  assert.deepEqual(received.match(/GET \/[a-z0-9]+(?=HTTP\/|$)/g), ['GET /one', 'GET /two'])
})

test('a request body is delivered to the listener before its response is written', async (t) => {
  const { port } = await started(t, (exchange) => {
    const chunks: Buffer[] = []
    exchange.onBodyChunk = (chunk) => chunks.push(chunk)
    exchange.onRequestComplete = () => exchange.response.end(Buffer.concat(chunks))
  })
  const client = await connect(port)
  t.after(() => client.close())

  const post = (body: string): string =>
    `POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: ${body.length}\r\n\r\n${body}`

  assert.match(await exchange(client, post('first'), 1), /first$/)
  assert.match(await exchange(client, post('second'), 2), /second$/)
  assert.equal(client.closed, false)
})

test('a malformed request on a live connection is answered 400 and closed', async (t) => {
  const { port, closes } = await started(t)
  const client = await connect(port)
  t.after(() => client.close())

  await exchange(client, get('/one'), 1)
  await client.write('GET /two HTTP/1.1\r\nHost x\r\n\r\n')
  assert.equal(await closedWithin(client, 1_000), true)

  const received = client.received().toString('latin1')
  assert.match(received, /HTTP\/1\.1 400 Bad Request\r\n/)
  assert.deepEqual(closes, ['client-error'])
})

test('a listener that throws yields 500 rather than a hung socket', async (t) => {
  const { port } = await started(t, () => {
    throw new Error('listener blew up')
  })
  const client = await connect(port)
  t.after(() => client.close())

  const received = await exchange(client, get('/one'), 1)

  assert.match(received, /^HTTP\/1\.1 500 Internal Server Error\r\n/)
  assert.equal(await closedWithin(client, 1_000), true)
})
