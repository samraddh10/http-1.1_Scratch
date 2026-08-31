// module 5.1  test/compat/own-props.test.ts -- the shims survive what expressInit does to them
//
// `express/lib/middleware/init.js:35-36` runs `setPrototypeOf(req, app.request)` and
// `setPrototypeOf(res, app.response)` on every request. Each test here performs that exact
// move -- against the real `app.request`/`app.response` from the pinned Express, not a
// hand-built stand-in for them -- and then asserts on what is left of the object.
//
// The shims themselves are deliberately not under test: 5.2 and 5.3 do not exist yet, and
// what is being proven belongs to the pinning helper rather than to either of them. The two
// classes below are the smallest things shaped like the real ones -- a `Readable` whose
// `_read` must keep control of the socket, and a `Writable` whose write path must keep
// running through `_write`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Readable, Writable } from 'node:stream'

import express from 'express'

import { pinToInstance } from '../../server/compat/own-props.js'

const app = express()

/** The two lines of `expressInit`, on their own. */
function reparentAsExpressDoes(request: object, response: object): void {
  Object.setPrototypeOf(request, app.request)
  Object.setPrototypeOf(response, app.response)
}

/** What Express's prototype supplies for a name -- which is to say, Node's implementation. */
function expressSupplies(proto: object, name: string): unknown {
  return (proto as unknown as Record<string, unknown>)[name]
}

const REQUEST_PINS = ['_read'] as const satisfies readonly (keyof ShimRequest & string)[]

// `write`, `end`, `_write` and `_final` are inherited from `Writable` rather than declared
// here, and are pinned all the same: `Writable.prototype` is not in Node's outgoing chain,
// so reparenting drops them as surely as it drops anything this class declares itself.
const RESPONSE_PINS = ['write', 'end', '_write', '_final', 'headersSent'] as const satisfies
  readonly (keyof ShimResponse & string)[]

class ShimRequest extends Readable {
  reads = 0

  constructor(pin = true) {
    super()
    if (pin) pinToInstance(this, REQUEST_PINS)
  }

  override _read(): void {
    this.reads += 1
    this.push(null)
  }
}

class ShimResponse extends Writable {
  body: string[] = []
  finalCalled = false
  #flushed = false

  constructor(pin = true) {
    super()
    if (pin) pinToInstance(this, RESPONSE_PINS)
  }

  get headersSent(): boolean {
    return this.#flushed
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    this.#flushed = true
    this.body.push(chunk.toString('latin1'))
    done()
  }

  override _final(done: (error?: Error | null) => void): void {
    this.finalCalled = true
    done()
  }
}

test('a pinned response still writes through the shim after Express reparents it', async () => {
  const request = new ShimRequest()
  const response = new ShimResponse()

  reparentAsExpressDoes(request, response)

  response.end('hi')
  await once(response, 'finish')

  assert.deepEqual(response.body, ['hi'])
  assert.equal(response.finalCalled, true)
})

test('the same move decapitates an unpinned response', () => {
  const response = new ShimResponse(false)

  reparentAsExpressDoes(new ShimRequest(false), response)

  assert.equal(response.end, expressSupplies(app.response, 'end'))
  assert.notEqual(response.end, Writable.prototype.end)

  // Node's `OutgoingMessage.prototype.end` reaching for `this.outputData`, which a shim has
  // no reason to have. Loud here only because nothing else was pinned either -- the failure
  // this helper exists to prevent is the quiet half, one method at a time.
  assert.throws(() => response.end('hi'), TypeError)
})

test('reparenting drops stream.Writable.prototype out of the response chain entirely', () => {
  const response = new ShimResponse()

  assert.ok(Writable.prototype.isPrototypeOf(response))
  reparentAsExpressDoes(new ShimRequest(), response)
  assert.ok(!Writable.prototype.isPrototypeOf(response))

  // Which is why the inherited members are pinned and not merely the declared ones.
  for (const name of RESPONSE_PINS) assert.ok(Object.hasOwn(response, name), name)
})

test('the request keeps its own _read rather than the one that resumes the socket', async () => {
  const request = new ShimRequest()

  reparentAsExpressDoes(request, new ShimResponse())

  request.resume()
  await once(request, 'end')

  assert.equal(request.reads, 1)
})

test('an unpinned request loses _read silently, with the stream machinery still intact', () => {
  const request = new ShimRequest(false)

  reparentAsExpressDoes(request, new ShimResponse(false))

  // `IncomingMessage` extends `Readable`, so unlike the response nothing here looks broken:
  // the object is still a working readable stream, it just answers to Node's `_read`, which
  // calls `readStart(this.socket)` behind this server's flow control.
  assert.ok(Readable.prototype.isPrototypeOf(request))
  assert.equal(request._read, expressSupplies(app.request, '_read'))
  assert.notEqual(request._read, ShimRequest.prototype._read)
})

test('a pinned accessor stays an accessor rather than freezing at its value', async () => {
  const response = new ShimResponse()

  reparentAsExpressDoes(new ShimRequest(), response)
  assert.equal(response.headersSent, false)

  response.end('hi')
  await once(response, 'finish')

  assert.equal(response.headersSent, true)
})

test('pinned members stay invisible to enumeration, as prototype methods are', () => {
  const response = new ShimResponse()
  const keys = Object.keys(response)

  for (const name of RESPONSE_PINS) assert.ok(!keys.includes(name), name)
  assert.ok(!JSON.stringify(response).includes('_write'))
})

test('pinning a member that is on no prototype throws at construction', () => {
  class Typo extends Writable {
    constructor() {
      super()
      pinToInstance(this, ['ende'])
    }
  }

  assert.throws(() => new Typo(), /cannot pin 'ende'/)
})

test('a member that is already an own property is left as it is', () => {
  const statusCode = 418
  const response = Object.assign(new ShimResponse(), { statusCode })

  pinToInstance(response, ['statusCode'])
  reparentAsExpressDoes(new ShimRequest(), response)

  assert.equal(response.statusCode, statusCode)
})
