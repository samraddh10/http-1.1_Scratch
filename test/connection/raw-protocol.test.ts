// module 9.2  test/connection/raw-protocol.test.ts -- the rules that were only ever asserted
// one layer down
//
// Keep-alive reuse, the Content-Length/Transfer-Encoding rejection and the bodyless statuses
// each already have a test against the function that decides them -- `decidePersistence()`,
// `parser.push()` and `decideResponseFraming()`. Those prove the decision is right. None of
// them proves it reaches the wire, and a break anywhere between a decision and the writer
// passes all three while showing up as bytes a client can see. So everything here goes
// through a real socket over the whole stack and asserts on the literal response.
//
// The 408 and the `100-continue` interim, which this subphase also covers, are already
// asserted this way in timeout.test.ts and expect-continue.test.ts and are not repeated.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { createServer, type RequestListener, type WireServer } from '../../server/index.js'
import { connect, untilClose, untilResponses } from '../helpers/raw-socket.js'

interface Started {
  readonly port: number
  readonly server: WireServer
}

async function started(t: TestContext, listener: RequestListener): Promise<Started> {
  const server = createServer(listener)
  server.listen(0)
  const address = await server.ready()

  t.after(() => new Promise<void>((done) => void server.close(done)))
  return { port: address.port, server }
}

function get(path: string): string {
  return `GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`
}

/**
 * Head and body, split on the empty line between them. The head keeps the CRLF ending its
 * last header line, so every field in it matches with a delimiter on both sides and an
 * assertion does not have to know which header the writer happened to put last.
 */
function split(response: string): { head: string; body: string } {
  const at = response.indexOf('\r\n\r\n')
  assert.notEqual(at, -1, `no header terminator in:\n${response}`)
  return { head: response.slice(0, at + 2), body: response.slice(at + 4) }
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

// -- keep-alive reuse ---------------------------------------------------------------------

test('one socket serves twenty requests in order and stays open', async (t) => {
  const { port, server } = await started(t, (request, response) => {
    response.setHeader('Content-Type', 'text/plain')
    response.end(request.url ?? '')
  })

  const client = await connect(port)
  t.after(() => client.close())

  for (let i = 1; i <= 20; i++) {
    await client.write(get(`/r${i}`))
    await client.read(untilResponses(i))
  }

  const received = (await client.read(untilResponses(20))).toString('latin1')

  assert.equal(countOf(received, 'HTTP/1.1 200 OK\r\n'), 20, received)
  assert.equal(countOf(received, 'Connection: close'), 0, received)

  // Order is the point, not just the count. A writer that let two exchanges interleave
  // would still produce twenty responses, just not these twenty in this sequence.
  let from = 0
  for (let i = 1; i <= 20; i++) {
    const at = received.indexOf(`/r${i}`, from)
    assert.notEqual(at, -1, `response ${i} is missing or out of order in:\n${received}`)
    from = at
  }

  assert.equal(client.closed, false, 'the server closed a connection it should have kept')
  assert.equal(server.tcp.connectionCount, 1, 'twenty requests did not run over one socket')
})

// -- the smuggling rejection --------------------------------------------------------------

test('Content-Length with Transfer-Encoding is refused on the wire and the socket closed', async (t) => {
  const seen: string[] = []
  const { port } = await started(t, (request, response) => {
    seen.push(request.url ?? '')
    response.end('ok')
  })

  const client = await connect(port)
  t.after(() => client.close())

  // The attack shape, not just the header pair (RFC 9112 section 6.1). A front end that
  // honours Content-Length reads six bytes and treats the rest as a second request; a back
  // end that honours Transfer-Encoding stops at the zero chunk and treats the rest as a
  // fresh one. The bytes after the zero chunk are what an attacker prepends to whoever
  // uses this connection next.
  await client.write(
    'POST /front HTTP/1.1\r\n' +
      'Host: x\r\n' +
      'Content-Length: 6\r\n' +
      'Transfer-Encoding: chunked\r\n' +
      '\r\n' +
      '0\r\n\r\n' +
      'GET /smuggled HTTP/1.1\r\nHost: x\r\n\r\n',
  )

  const received = (await client.read(untilClose)).toString('latin1')

  assert.ok(received.startsWith('HTTP/1.1 400 Bad Request\r\n'), received)
  assert.match(split(received).head, /\r\nConnection: close\r\n/)
  assert.equal(countOf(received, 'HTTP/1.1'), 1, `a second response reached the wire:\n${received}`)
  assert.equal(client.closed, true, 'the connection outlived the request that poisoned it')
  assert.deepEqual(seen, [], 'the application ran on a request that should never have parsed')
})

// -- bodyless responses -------------------------------------------------------------------

const DOCUMENT = 'twenty-three bytes here'

test('a HEAD carries the full header block the GET would, and no body bytes', async (t) => {
  const { port } = await started(t, (_request, response) => {
    response.setHeader('Content-Type', 'text/plain')
    response.end(DOCUMENT)
  })

  const client = await connect(port)
  t.after(() => client.close())

  await client.write(`HEAD /doc HTTP/1.1\r\nHost: x\r\n\r\n`)
  const { head, body } = split((await client.read(untilResponses(1))).toString('latin1'))

  assert.ok(head.startsWith('HTTP/1.1 200 OK\r\n'), head)
  // The length describes the GET this HEAD is asking about, so it is present and it is the
  // real one -- the whole reason to send a HEAD is to read it without paying for the body.
  assert.match(head, new RegExp(`\r\nContent-Length: ${DOCUMENT.length}\r\n`))
  assert.match(head, /\r\nContent-Type: text\/plain/)
  assert.equal(body, '', `a HEAD returned ${body.length} body byte(s)`)
})

for (const status of [204, 304] as const) {
  test(`a ${status} carries neither a body nor a framing header, and the next response still lands`, async (t) => {
    const { port } = await started(t, (request, response) => {
      if (request.url === '/empty') {
        response.statusCode = status
        response.end()
        return
      }
      response.end('after')
    })

    const client = await connect(port)
    t.after(() => client.close())

    await client.write(get('/empty'))
    const first = (await client.read(untilResponses(1))).toString('latin1')

    assert.ok(first.startsWith(`HTTP/1.1 ${status} `), first)
    assert.equal(/\r\nContent-Length:/.test(split(first).head), false, first)
    assert.equal(/\r\nTransfer-Encoding:/.test(split(first).head), false, first)

    // The claim in RFC 9112 section 6.3 is that the empty line alone frames these, and the
    // only way to see whether the client agreed about where the response ended is to send
    // another one. A stray framing header or a stray body byte desynchronises this.
    await client.write(get('/next'))
    const both = (await client.read(untilResponses(2))).toString('latin1')
    const second = both.slice(first.length)

    assert.ok(second.startsWith('HTTP/1.1 200 OK\r\n'), `second response misaligned:\n${both}`)
    assert.equal(split(second).body, 'after', both)
  })
}
