// module 5.2  test/compat/server-request.test.ts -- the object Express is handed as `req`
//
// Two things are worth testing here and the rest is field copying. The first is that
// `raw-body` -- the package behind `express.json()` -- can actually drain a body off this
// object, because its failure mode is a request that hangs with no error rather than a
// stack trace. The second is that the feed methods module 4 calls still exist after
// `expressInit` has reparented the object, which is subphase 5.1's finding with a caller.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'

import express from 'express'
import getRawBody from 'raw-body'

import { ServerRequest } from '../../server/compat/server-request.js'
import type { RequestHead } from '../../server/http/parser/request-parser.js'
import { RequestParser } from '../../server/http/parser/request-parser.js'
import { crlf } from '../helpers/feed-bytes.js'
import { socketPair, type SocketPair } from '../helpers/socket-pair.js'

const app = express()

/** A head from the real parser rather than an object literal shaped like one. */
function headOf(...lines: string[]): RequestHead {
  let head: RequestHead | undefined
  new RequestParser({ onHead: (h) => void (head = h) }).push(crlf(...lines, ''))
  if (head === undefined) throw new Error('fixture produced no head')
  return head
}

const POST_HEAD = [
  'POST /echo/42?debug=1 HTTP/1.1',
  'Host: localhost:3000',
  'Content-Type: application/json',
  'Content-Length: 16',
]

async function withRequest(
  head: RequestHead,
  body: (request: ServerRequest, pair: SocketPair) => Promise<void> | void,
): Promise<void> {
  const pair = await socketPair()
  try {
    await body(new ServerRequest({ head, tcp: pair.tcp }), pair)
  } finally {
    await pair.close()
  }
}

test('raw-body drains a body off the shim, which is express.json() working', async () => {
  await withRequest(headOf(...POST_HEAD), async (request) => {
    // `raw-body/index.js:184` refuses with 500 "stream is not readable" before reading a
    // byte if this is not true, and that is the whole reason the shim is a real Readable.
    assert.equal(request.readable, true)

    const draining = getRawBody(request, { length: 16, limit: '1mb', encoding: 'utf8' })

    request.receiveBody(Buffer.from('{"name":'))
    request.receiveBody(Buffer.from('"shriy"}'))
    request.completeBody()

    assert.equal(await draining, '{"name":"shriy"}')
  })
})

test('raw-body reports an abort rather than waiting for bytes that are not coming', async () => {
  await withRequest(headOf(...POST_HEAD), async (request) => {
    const draining = getRawBody(request, { length: 16, limit: '1mb', encoding: 'utf8' })

    request.receiveBody(Buffer.from('{"name":'))
    request.abort()

    // `raw-body/index.js:204` is listening for `'aborted'`; without the event this request
    // hangs until something else times it out.
    await assert.rejects(draining, /request aborted/)
  })
})

test('the head is copied onto the object as Express expects to find it', async () => {
  await withRequest(headOf(...POST_HEAD), (request, pair) => {
    assert.equal(request.method, 'POST')
    // Raw and still encoded: `parseurl` splits it and Express's query parser decodes it.
    assert.equal(request.url, '/echo/42?debug=1')
    assert.equal(request.headers['content-type'], 'application/json')
    assert.deepEqual(request.rawHeaders.slice(0, 2), ['Host', 'localhost:3000'])
    assert.equal(request.httpVersion, '1.1')
    assert.equal(request.httpVersionMajor, 1)
    assert.equal(request.httpVersionMinor, 1)
    assert.equal(request.upgrade, false)
    assert.equal(request.socket, pair.tcp.socket)
    assert.equal(request.connection, request.socket)
  })
})

test('complete is false until the request has been read, and true before end fires', async () => {
  await withRequest(headOf(...POST_HEAD), async (request) => {
    assert.equal(request.complete, false)

    request.receiveBody(Buffer.from('{"name":"shriy"}'))
    assert.equal(request.complete, false)

    let completeAtEnd: boolean | undefined
    request.on('end', () => void (completeAtEnd = request.complete))

    request.completeBody()
    assert.equal(request.complete, true)

    request.resume()
    await once(request, 'end')

    // `on-finished` reads `msg.complete && !msg.readable` to tell a finished request from
    // an aborted one, so the flag being late by even one event would misreport it.
    assert.equal(completeAtEnd, true)
  })
})

test('a chunked body ends with its trailers on the object', async () => {
  const head = headOf('POST /upload HTTP/1.1', 'Host: x', 'Transfer-Encoding: chunked')

  await withRequest(head, async (request) => {
    request.receiveBody(Buffer.from('hello'))
    request.completeBody({ 'x-checksum': 'abc123' })

    assert.deepEqual(request.trailers, { 'x-checksum': 'abc123' })
    assert.equal(await getRawBody(request, { encoding: 'utf8' }), 'hello')
  })
})

test('the feed methods still work after expressInit reparents the object', async () => {
  await withRequest(headOf(...POST_HEAD), async (request) => {
    // express/lib/middleware/init.js:35. Everything below happens to an object whose
    // prototype chain no longer contains ServerRequest.prototype.
    Object.setPrototypeOf(request, app.request)

    assert.ok(!ServerRequest.prototype.isPrototypeOf(request))

    const draining = getRawBody(request, { encoding: 'utf8' })
    request.receiveBody(Buffer.from('still mine'))
    request.completeBody()

    assert.equal(await draining, 'still mine')
    assert.equal(request.complete, true)
  })
})

test('_read and _destroy are pinned; the rest of Readable is left on the chain', async () => {
  await withRequest(headOf(...POST_HEAD), (request) => {
    assert.ok(Object.hasOwn(request, '_read'))
    assert.ok(Object.hasOwn(request, '_destroy'))

    Object.setPrototypeOf(request, app.request)

    // Node's `_read` would call `readStart(this.socket)` behind module 4's flow control,
    // and its `_destroy` reaches for `this.socket` -- destroying a request stream would
    // take the whole keep-alive connection with it.
    assert.equal(request._read, ServerRequest.prototype._read)

    // Not pinned, and deliberately so: `IncomingMessage` extends `Readable`, so the getter
    // and the generic machinery are still reachable through the new chain.
    assert.equal(request.readable, true)
    assert.equal(typeof request.pipe, 'function')
    assert.equal(typeof request.resume, 'function')
  })
})

test('the read-demand signal reports what the consumer wants', async () => {
  const pair = await socketPair()
  const demand: boolean[] = []

  try {
    const request = new ServerRequest({
      head: headOf(...POST_HEAD),
      tcp: pair.tcp,
      onDemandChange: (wantsMore) => void demand.push(wantsMore),
    })

    // Nothing has asked for bytes yet, so nothing has been signalled.
    assert.deepEqual(demand, [])

    // `_read` is scheduled rather than called from `resume()`, so the signal lands a tick
    // later. Module 4 will be reacting to it asynchronously too.
    request.resume()
    await new Promise((settle) => setImmediate(settle))
    assert.deepEqual(demand, [true])

    // One chunk past the 16 KB high-water mark is the consumer saying "enough for now".
    request.pause()
    request.receiveBody(Buffer.alloc(64 * 1024))
    assert.deepEqual(demand, [true, false])
  } finally {
    await pair.close()
  }
})
