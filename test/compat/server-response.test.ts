// module 5.3  test/compat/server-response.test.ts -- the object Express is handed as `res`
//
// These write through a real `ResponseWriter` onto a real socket and read the bytes off the
// other end, because the claim being tested is about what reaches the client. The header
// store, `_header` and `'finish'` could each be asserted against the object alone; the
// framing decisions could not, and they are the half that goes wrong quietly.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { Socket } from 'node:net'

import express from 'express'

import { ServerResponse } from '../../server/compat/server-response.js'
import { ResponseWriter, type ResponseWriterOptions } from '../../server/http/response/writer.js'
import { socketPair, type SocketPair } from '../helpers/socket-pair.js'

const app = express()

interface Received {
  /** Everything the client has read so far. */
  text(): string
  waitFor(needle: string, timeoutMs?: number): Promise<void>
}

function reading(socket: Socket): Received {
  let received = ''
  socket.on('data', (chunk: Buffer) => {
    received += chunk.toString('latin1')
  })

  return {
    text: () => received,
    async waitFor(needle, timeoutMs = 2_000): Promise<void> {
      const deadline = Date.now() + timeoutMs
      while (!received.includes(needle)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${JSON.stringify(needle)} in ${received}`)
        }
        await new Promise((settle) => setTimeout(settle, 5))
      }
    },
  }
}

interface Response {
  readonly statusLine: string
  readonly headers: readonly string[]
  readonly body: string
}

function parse(raw: string): Response {
  const split = raw.indexOf('\r\n\r\n')
  assert.notEqual(split, -1, `no header terminator in ${JSON.stringify(raw)}`)

  const [statusLine, ...headers] = raw.slice(0, split).split('\r\n')
  return { statusLine: statusLine ?? '', headers, body: raw.slice(split + 4) }
}

async function withResponse(
  body: (response: ServerResponse, client: Received, pair: SocketPair) => Promise<void> | void,
  options: ResponseWriterOptions = { httpVersion: '1.1' },
): Promise<void> {
  const pair = await socketPair()
  try {
    const response = new ServerResponse({
      writer: new ResponseWriter(pair.tcp, options),
      tcp: pair.tcp,
    })
    await body(response, reading(pair.client), pair)
  } finally {
    await pair.close()
  }
}

test('setHeader then end(body) puts a correct response on the wire', async () => {
  await withResponse(async (response, client) => {
    response.setHeader('Content-Type', 'text/plain')
    response.end('hi')

    await client.waitFor('\r\n\r\nhi')
    const { statusLine, headers, body } = parse(client.text())

    assert.equal(statusLine, 'HTTP/1.1 200 OK')
    assert.ok(headers.includes('Content-Type: text/plain'), headers.join(' | '))
    // Not chunked: `end(body)` with nothing written yet is the one moment the whole length
    // is known, and it is the moment Node declares it too.
    assert.ok(headers.includes('Content-Length: 2'), headers.join(' | '))
    assert.ok(!headers.some((h) => h.startsWith('Transfer-Encoding')), headers.join(' | '))
    assert.equal(body, 'hi')
  })
})

test('headersSent and _header both flip when the head goes out', async () => {
  await withResponse(async (response, client) => {
    assert.equal(response.headersSent, false)
    // Read into a local: `assert.equal` is typed `asserts actual is T`, so asserting on the
    // getter directly would narrow it to `null` for the rest of the test.
    const beforeFlush = response._header
    assert.equal(beforeFlush, null)

    response.end('hi')
    await client.waitFor('\r\n\r\nhi')

    assert.equal(response.headersSent, true)

    // `finalhandler/index.js:259` and `send/index.js:1048` read this to decide whether a
    // response has already started, so what matters is that it is truthy and is the head.
    const header = response._header ?? ''
    assert.ok(header.startsWith('HTTP/1.1 200 OK\r\n'), header)
    assert.ok(header.endsWith('\r\n\r\n'), header)
  })
})

test('finish fires, and finished is true from the call to end()', async () => {
  await withResponse(async (response) => {
    assert.equal(response.finished, false)

    const finished = once(response, 'finish')
    response.end('hi')

    // `on-finished/index.js:69` classifies the object by `typeof msg.finished === 'boolean'`
    // and then trusts the value, so it flips when end() is called, not when it flushes.
    assert.equal(response.finished, true)
    await finished
  })
})

test('setting a header after the head has gone out is refused, as Node refuses it', async () => {
  await withResponse(async (response, client) => {
    response.end('hi')
    await client.waitFor('\r\n\r\nhi')

    assert.throws(() => response.setHeader('X-Late', 'yes'), /ERR_HTTP_HEADERS_SENT|after they are sent/)
    assert.throws(() => response.removeHeader('Content-Length'), /after they are sent/)
  })
})

test('the header store is case-insensitive and keeps the casing it was given', async () => {
  await withResponse(async (response, client) => {
    response.setHeader('X-Powered-By', 'Express')
    response.setHeader('Set-Cookie', ['a=1', 'b=2'])

    assert.equal(response.hasHeader('x-powered-by'), true)
    assert.equal(response.getHeader('X-POWERED-BY'), 'Express')
    // Node returns lowercased names from both of these, and `send/index.js:893` walks them
    // to clear a response before writing an error over it.
    assert.deepEqual(response.getHeaderNames(), ['x-powered-by', 'set-cookie'])
    assert.deepEqual(Object.keys(response.getHeaders()), ['x-powered-by', 'set-cookie'])

    // Handed out detached: sorting what you were given must not reorder what is still to be
    // sent, and Node types this return as a mutable array while `setHeader` takes a readonly.
    const cookies = response.getHeader('set-cookie') as string[]
    cookies.reverse()

    response.removeHeader('X-Powered-By')
    assert.equal(response.hasHeader('X-Powered-By'), false)

    response.end()
    await client.waitFor('\r\n\r\n')

    const { headers } = parse(client.text())
    assert.ok(!headers.some((h) => h.startsWith('X-Powered-By')), headers.join(' | '))
    // One field line per array entry, in the order they were set.
    assert.deepEqual(
      headers.filter((h) => h.startsWith('Set-Cookie')),
      ['Set-Cookie: a=1', 'Set-Cookie: b=2'],
    )
  })
})

test('writeHead sets the status, merges its headers over the store, and chains', async () => {
  await withResponse(async (response, client) => {
    response.setHeader('X-Kept', 'yes')
    response.setHeader('Content-Type', 'text/plain')

    const chained = response.writeHead(404, 'Nope', { 'Content-Type': 'application/json' })
    assert.equal(chained, response)

    response.end('{}')
    await client.waitFor('0\r\n\r\n')

    const { statusLine, headers, body } = parse(client.text())
    assert.equal(statusLine, 'HTTP/1.1 404 Nope')
    assert.ok(headers.includes('X-Kept: yes'), headers.join(' | '))
    assert.ok(headers.includes('Content-Type: application/json'), headers.join(' | '))

    // Chunked rather than `Content-Length: 2`, and Node does the same: `writeHead` commits
    // to a framing before the body exists, so the length is no longer knowable at end().
    assert.ok(headers.includes('Transfer-Encoding: chunked'), headers.join(' | '))
    assert.equal(body, '2\r\n{}\r\n0\r\n\r\n')
  })
})

test('a response written in pieces is chunked and terminated', async () => {
  await withResponse(async (response, client) => {
    // No head yet and no length in hand: this is the SSE path module 7 needs.
    response.write('a')
    response.write('bc')
    response.end()

    await client.waitFor('0\r\n\r\n')
    const { headers, body } = parse(client.text())

    assert.ok(headers.includes('Transfer-Encoding: chunked'), headers.join(' | '))
    assert.equal(body, '1\r\na\r\n2\r\nbc\r\n0\r\n\r\n')
  })
})

test('a 204 carries neither a body nor a length describing one', async () => {
  await withResponse(async (response, client) => {
    response.statusCode = 204
    response.end()

    await client.waitFor('\r\n\r\n')
    const { statusLine, headers, body } = parse(client.text())

    assert.equal(statusLine, 'HTTP/1.1 204 No Content')
    // The implicit `Content-Length: 0` this shim adds for `end()` must not survive module
    // 3's framing rules, which say a 204 is framed by the empty line and nothing else.
    assert.ok(!headers.some((h) => h.startsWith('Content-Length')), headers.join(' | '))
    assert.equal(body, '')
  })
})

test('a HEAD response keeps the length of the body it does not send', async () => {
  await withResponse(
    async (response, client) => {
      response.setHeader('Content-Length', 11)
      response.end('hello world')

      await client.waitFor('\r\n\r\n')
      const { headers, body } = parse(client.text())

      assert.ok(headers.includes('Content-Length: 11'), headers.join(' | '))
      assert.equal(body, '')
    },
    { httpVersion: '1.1', method: 'HEAD' },
  )
})

test('the whole Writable surface survives expressInit', async () => {
  await withResponse(async (response, client) => {
    // express/lib/middleware/init.js:36. `OutgoingMessage` extends `Stream`, not `Writable`,
    // so after this line nothing below `ServerResponse.prototype` is left in the chain --
    // which is why the pin list is the whole of `Writable.prototype`.
    Object.setPrototypeOf(response, app.response)

    assert.ok(!ServerResponse.prototype.isPrototypeOf(response))

    const finished = once(response, 'finish')
    response.setHeader('X-Still', 'mine')
    response.end('hi')
    await finished

    await client.waitFor('\r\n\r\nhi')
    const { statusLine, headers, body } = parse(client.text())

    assert.equal(statusLine, 'HTTP/1.1 200 OK')
    assert.ok(headers.includes('X-Still: mine'), headers.join(' | '))
    assert.equal(body, 'hi')
    assert.equal(response.finished, true)
  })
})

test('write() reports backpressure when the client stops reading', async () => {
  const pair = await socketPair()

  try {
    const response = new ServerResponse({
      writer: new ResponseWriter(pair.tcp, { httpVersion: '1.1' }),
      tcp: pair.tcp,
    })

    // No 'data' listener on the client, so nothing is read and the send buffer fills.
    const chunk = Buffer.alloc(64 * 1024, 0x61)
    let refused = false

    for (let sent = 0; sent < 64 && !refused; sent++) refused = !response.write(chunk)

    // `send/index.js:791` pipes an `fs.ReadStream` into this object. If write() never
    // returns false, pipe never pauses the file and the whole thing lands in memory.
    assert.equal(refused, true)

    const client = reading(pair.client)
    response.end()
    await client.waitFor('0\r\n\r\n')
  } finally {
    await pair.close()
  }
})
