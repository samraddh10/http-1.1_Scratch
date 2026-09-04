// module 5.4  test/compat/create-server.test.ts -- the whole stack, driven by raw bytes
//
// Everything below goes through a real socket into module 1, out through module 2's parser,
// module 4's exchange queue, the two shims, and module 3's writer. Nothing is stubbed,
// because what is being tested is the wiring between them.
//
// The last test is the one this subphase exists for: 50 MB piped into a response that a
// client is not reading. The plan calls this the project's highest risk, and its failure
// mode is silence -- a server that works perfectly until the file is big enough and the
// reader slow enough, and then holds the whole thing in memory.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { closeSync, createReadStream, ftruncateSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import getRawBody from 'raw-body'

import { createServer, type RequestListener, type WireServer } from '../../server/index.js'
import { connect, untilResponses, type RawConnection } from '../helpers/raw-socket.js'

async function started(t: TestContext, listener: RequestListener): Promise<number> {
  const server: WireServer = createServer(listener)
  server.listen(0)
  const address = await server.ready()

  t.after(() => new Promise<void>((done) => void server.close(done)))
  return address.port
}

function get(path: string): string {
  return `GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`
}

test('createServer(listener).listen(port, callback) answers a request', async (t) => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/plain')
    response.end(`${request.method} ${request.url}`)
  })

  // Node's own shape: a port, a callback, and the server back for chaining.
  const listening = new Promise<void>((resolve) => {
    const returned = server.listen(0, () => resolve())
    assert.equal(returned, server)
  })
  await listening
  t.after(() => new Promise<void>((done) => void server.close(done)))

  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(server.listening, true)

  const received = await connect(address?.port ?? 0).then(async (client) => {
    await client.write(get('/echo/42?x=1'))
    const bytes = await client.read(untilResponses(1))
    await client.close()
    return bytes.toString('latin1')
  })

  assert.ok(received.startsWith('HTTP/1.1 200 OK\r\n'), received)
  assert.ok(received.includes('Content-Length: 16'), received)
  assert.ok(received.endsWith('GET /echo/42?x=1'), received)
})

test('createServer() without a listener is refused rather than left unanswerable', () => {
  // Node allows one and expects an `on('request')` handler later. There is no such event
  // here, so a server built this way could never answer anything.
  assert.throws(
    () => (createServer as (...args: unknown[]) => WireServer)(),
    /needs a request listener/,
  )
})

test('a request body arrives through the shim, which is the express.json() path', async (t) => {
  const bodies: string[] = []

  const port = await started(t, (request, response) => {
    void getRawBody(request, { encoding: 'utf8' }).then((body) => {
      bodies.push(body)
      response.end(`read ${body.length}`)
    })
  })

  const payload = '{"name":"shriy"}'
  const client = await connect(port)
  t.after(() => client.close())

  await client.write(
    `POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`,
  )
  const received = (await client.read(untilResponses(1))).toString('latin1')

  assert.deepEqual(bodies, [payload])
  assert.ok(received.endsWith('read 16'), received)
})

test('one socket serves request after request through the shims', async (t) => {
  const port = await started(t, (request, response) => response.end(request.url))

  const client = await connect(port)
  t.after(() => client.close())

  for (let i = 1; i <= 3; i++) {
    await client.write(get(`/r${i}`))
    const received = (await client.read(untilResponses(i))).toString('latin1')
    assert.ok(received.endsWith(`/r${i}`), received)
  }
})

test('a client that vanishes mid-body aborts the request rather than leaving it hanging', async (t) => {
  let aborted: (() => void) | undefined
  const wasAborted = new Promise<void>((resolve) => {
    aborted = resolve
  })

  const port = await started(t, (request) => {
    request.on('aborted', () => aborted?.())
    // Deliberately never answered: the point is that the request ends by itself.
    request.resume()
  })

  const client = await connect(port)
  await client.write('POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\npartial')
  await new Promise((settle) => setTimeout(settle, 50))
  await client.close()

  await wasAborted
})

test('a body the listener stops reading pauses the socket instead of buffering it', async (t) => {
  const SIZE = 512 * 1024

  let serverSocket: Socket | undefined
  let resumeReading: (() => void) | undefined
  const paused = new Promise<void>((resolve) => {
    resumeReading = resolve
  })

  const port = await started(t, (request, response) => {
    serverSocket = request.socket
    // Left unread on purpose. The shim fills, tells module 4 it wants no more, and module
    // 4's throttle stops reading -- the bytes stay in the client's send buffer, where they
    // cost the client memory rather than this process.
    void paused.then(async () => {
      const body = await getRawBody(request)
      response.end(`read ${body.length}`)
    })
  })

  const client = await connect(port)
  t.after(() => client.close())

  await client.write(`POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: ${SIZE}\r\n\r\n`)
  await client.write(Buffer.alloc(SIZE, 0x61))

  const wentQuiet = async (): Promise<boolean> => {
    for (let i = 0; i < 100; i++) {
      if (serverSocket?.isPaused() === true) return true
      await new Promise((settle) => setTimeout(settle, 10))
    }
    return false
  }
  assert.equal(await wentQuiet(), true, 'the server kept reading a body nobody was consuming')

  resumeReading?.()
  const received = (await client.read(untilResponses(1))).toString('latin1')
  assert.ok(received.endsWith(`read ${SIZE}`), received)
})

/** A client that counts bytes and throws them away, so the test process holds none of them. */
async function countingClient(port: number): Promise<{
  received(): number
  startReading(): void
  socket: Socket
}> {
  const socket = createConnection({ port, host: '127.0.0.1' })
  await once(socket, 'connect')

  let received = 0
  socket.on('data', (chunk: Buffer) => {
    received += chunk.length
  })
  // Attaching the listener put the socket in flowing mode, so the pause comes after it.
  socket.pause()

  return {
    received: () => received,
    startReading: () => void socket.resume(),
    socket,
  }
}

test('50 MB piped into a response completes with bounded memory over a slow reader', async (t) => {
  const SIZE = 50 * 1024 * 1024

  const directory = mkdtempSync(join(tmpdir(), 'wirehttp-'))
  const file = join(directory, 'big.bin')
  // Sized rather than written: 50 MB of zeros costs nothing to create this way, and what is
  // under test is the transfer, not the contents.
  const fd = openSync(file, 'w')
  ftruncateSync(fd, SIZE)
  closeSync(fd)
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  let serverSocket: Socket | undefined
  let responseBuffered = 0

  const port = await started(t, (request, response) => {
    serverSocket = request.socket
    response.setHeader('Content-Type', 'application/octet-stream')
    response.setHeader('Content-Length', SIZE)
    // `send/index.js:791` does exactly this with the file behind `res.sendFile`.
    createReadStream(file).pipe(response)

    const sample = setInterval(() => {
      responseBuffered = Math.max(responseBuffered, response.writableLength)
    }, 5)
    response.on('finish', () => clearInterval(sample))
    response.on('close', () => clearInterval(sample))
  })

  const client = await countingClient(port)
  t.after(() => void client.socket.destroy())

  const before = process.memoryUsage().arrayBuffers
  client.socket.write(get('/big'))

  // The reader is asleep. Whatever the server does in this window, it does against a socket
  // that is not draining, so this is the window in which an unbounded server fills up.
  let socketBuffered = 0
  for (let i = 0; i < 40; i++) {
    await new Promise((settle) => setTimeout(settle, 10))
    socketBuffered = Math.max(socketBuffered, serverSocket?.writableLength ?? 0)
  }

  const held = process.memoryUsage().arrayBuffers - before
  assert.ok(
    socketBuffered + responseBuffered < 4 * 1024 * 1024,
    `held ${socketBuffered} socket + ${responseBuffered} stream bytes against a stalled reader`,
  )
  assert.ok(held < 16 * 1024 * 1024, `array buffers grew by ${held} bytes with nobody reading`)
  assert.equal(client.received(), 0, 'the client read nothing, so nothing should have drained')

  client.startReading()
  for (let i = 0; i < 2_000 && client.received() < SIZE; i++) {
    await new Promise((settle) => setTimeout(settle, 10))
  }

  // Headers as well as the body, so the count is over rather than exactly SIZE.
  assert.ok(client.received() >= SIZE, `only ${client.received()} of ${SIZE} bytes arrived`)
})

test('ready() rejects before listen() rather than resolving with nothing', async () => {
  const server = createServer((_request, response) => response.end())
  await assert.rejects(server.ready(), /listen\(\) has not been called/)
})

test('close() reports through its callback', async () => {
  const server = createServer((_request, response) => response.end())
  server.listen(0)
  await server.ready()

  await new Promise<void>((done) => void server.close(done))
  assert.equal(server.listening, false)
})
