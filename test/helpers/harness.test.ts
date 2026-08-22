// module 0.3  test/helpers/harness.test.ts -- the harness is tested before the server is
//
// If these helpers are wrong, every protocol test built on them is wrong in a way that
// looks like a server bug. They get their own tests first.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { once } from 'node:events'

import {
  crlf,
  everyTwoWaySplit,
  forEachSplit,
  join,
  oneByteAtATime,
  randomSplits,
  splitStrategies,
  whole,
} from './feed-bytes.js'
import {
  connect,
  describe as describeBytes,
  rawRequest,
  untilBytes,
  untilIncludes,
  untilResponses,
} from './raw-socket.js'

// -- feed-bytes ------------------------------------------------------------------------

const FIXTURE = crlf('GET /echo/42?debug=1 HTTP/1.1', 'Host: localhost:3000', '')

test('crlf terminates every line, including the blank one that ends a header section', () => {
  assert.equal(
    FIXTURE.toString('latin1'),
    'GET /echo/42?debug=1 HTTP/1.1\r\nHost: localhost:3000\r\n\r\n',
  )
})

test('every split strategy preserves the bytes exactly', () => {
  // The property the whole harness rests on: chopping changes only the delivery, never
  // the content. If this were false the parser tests would be comparing different inputs.
  forEachSplit(FIXTURE, (chunks, name) => {
    assert.deepEqual(join(chunks), FIXTURE, `strategy ${name} altered the bytes`)
  })
})

test('one-byte-at-a-time really is one byte at a time', () => {
  const chunks = oneByteAtATime.split(FIXTURE)
  assert.equal(chunks.length, FIXTURE.length)
  assert.ok(
    chunks.every((c) => c.length === 1),
    'every chunk should be a single byte',
  )
})

test('whole is a single chunk, and empty input yields no chunks', () => {
  assert.equal(whole.split(FIXTURE).length, 1)
  assert.deepEqual(whole.split(Buffer.alloc(0)), [])
  assert.deepEqual(oneByteAtATime.split(Buffer.alloc(0)), [])
})

test('random splits are reproducible from their seed', () => {
  // The point of seeding: a failure can be re-run. Same seed, same chopping, every time.
  const a = randomSplits(7).split(FIXTURE).map((c) => c.length)
  const b = randomSplits(7).split(FIXTURE).map((c) => c.length)
  const other = randomSplits(8).split(FIXTURE).map((c) => c.length)

  assert.deepEqual(a, b, 'same seed should produce the same chunk sizes')
  assert.notDeepEqual(a, other, 'different seeds should produce different chunk sizes')
  assert.ok(a.every((n) => n >= 1 && n <= 8))
})

test('the strategy set includes the two that matter and names each one', () => {
  const names = splitStrategies.map((s) => s.name)
  assert.ok(names.includes('whole'))
  assert.ok(names.includes('one-byte-at-a-time'))
  // Names appear in assertion messages, so a failure says which chopping caused it.
  assert.ok(names.every((n) => n.length > 0))
})

test('everyTwoWaySplit covers every boundary, including inside a CRLF pair', () => {
  const cases = everyTwoWaySplit(FIXTURE)
  assert.equal(cases.length, FIXTURE.length + 1)
  for (const chunks of cases) {
    assert.deepEqual(join(chunks), FIXTURE)
  }

  // The boundary most likely to be mishandled: a chunk ending on CR with the LF in the
  // next one. Assert such a case is actually generated rather than assuming it.
  const firstCr = FIXTURE.indexOf(0x0d)
  const splitInsideCrlf = cases[firstCr + 1]
  assert.ok(splitInsideCrlf !== undefined)
  assert.equal(splitInsideCrlf[0]?.at(-1), 0x0d, 'first chunk should end with CR')
  assert.equal(splitInsideCrlf[1]?.at(0), 0x0a, 'second chunk should start with LF')
})

// -- raw-socket ------------------------------------------------------------------------

const servers: Server[] = []
after(async () => {
  for (const server of servers) {
    server.close()
    for (const socket of openSockets) socket.destroy()
    await once(server, 'close').catch(() => undefined)
  }
})
const openSockets: Socket[] = []

/** Starts a throwaway TCP server on an ephemeral port. */
async function startServer(onConnection: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    openSockets.push(socket)
    onConnection(socket)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

test('rawRequest sends literal bytes and collects the reply until close', async () => {
  const port = await startServer((socket) => {
    socket.on('data', (chunk: Buffer) => {
      socket.end(Buffer.concat([Buffer.from('echo:', 'latin1'), chunk]))
    })
  })

  const reply = await rawRequest(port, FIXTURE)
  assert.deepEqual(reply, Buffer.concat([Buffer.from('echo:', 'latin1'), FIXTURE]))
})

test('bytes are sent verbatim: no newline translation, no encoding', async () => {
  // This is the property that makes the harness usable for a protocol whose delimiters
  // are CR and LF. If anything here normalised line endings the tests would be fiction.
  const port = await startServer((socket) => {
    socket.on('data', (chunk: Buffer) => socket.end(chunk))
  })

  const odd = Buffer.from('a\rb\nc\r\nd\0e\xff', 'latin1')
  assert.deepEqual(await rawRequest(port, odd), odd)
})

test('read waits for a condition rather than for close, which keep-alive needs', async () => {
  // A server that answers but never closes. Waiting for close here would hang.
  const port = await startServer((socket) => {
    socket.on('data', () => socket.write('HTTP/1.1 204 No Content\r\n\r\n'))
  })

  const connection = await connect(port)
  try {
    await connection.write(FIXTURE)
    const first = await connection.read(untilIncludes('\r\n\r\n'))
    assert.ok(first.toString('latin1').startsWith('HTTP/1.1 204'))
    assert.equal(connection.closed, false, 'connection should still be open')

    // Second request on the same socket: this is what proves reuse.
    await connection.write(FIXTURE)
    const both = await connection.read(untilResponses(2))
    assert.equal(both.toString('latin1').match(/HTTP\/1\.1 204/g)?.length, 2)
  } finally {
    await connection.close()
  }
})

test('untilBytes waits for a byte count', async () => {
  const port = await startServer((socket) => {
    socket.on('data', () => {
      socket.write('12345')
      setTimeout(() => socket.write('67890'), 10).unref()
    })
  })

  const connection = await connect(port)
  try {
    await connection.write('go')
    assert.equal((await connection.read(untilBytes(10))).toString('latin1'), '1234567890')
  } finally {
    await connection.close()
  }
})

test('a read that times out reports what it did receive', async () => {
  // The difference between a debuggable harness and a frustrating one: a timeout that
  // shows the partial bytes tells you the server stalled mid-header; a bare "timeout"
  // tells you nothing.
  const port = await startServer((socket) => {
    socket.on('data', () => socket.write('HTTP/1.1 200 OK\r\n'))
  })

  const connection = await connect(port)
  try {
    await connection.write('go')
    await assert.rejects(
      () => connection.read(untilIncludes('\r\n\r\n'), { timeoutMs: 120 }),
      (error: Error) => {
        assert.match(error.message, /timed out after 120ms with 17 byte\(s\)/)
        assert.match(error.message, /HTTP\/1\.1 200 OK\[CRLF\]/)
        return true
      },
    )
  } finally {
    await connection.close()
  }
})

test('describe makes CRLF visible instead of printing it', () => {
  // A bare LF where the spec requires CRLF is a real bug in this project, and a printed
  // newline hides it completely.
  assert.equal(describeBytes(Buffer.from('a\r\nb', 'latin1')), 'a[CRLF]\nb')
  assert.equal(describeBytes(Buffer.from('a\nb', 'latin1')), 'a[LF]\nb')
  assert.equal(describeBytes(Buffer.from('a\rb', 'latin1')), 'a[CR]b')
})
