// module 5.5  test/compat/conformance.test.ts -- the supported surface, machine-checked
//
// DECISIONS.md carries the contract in prose: the members Express and its five raw-object
// dependencies reach through to, and the list of things this server will not implement.
// Prose is not enforcement. This file walks both lists against real objects, and walks them
// twice -- once as the listener receives them, and once after `expressInit` has reparented
// them onto `app.request`/`app.response`, because a surface that only holds on one side of
// that swap is the failure subphase 5.1 exists to catch.
//
// It asserts presence, kind and the few behaviours the contract turns on. What each member
// is FOR is recorded in DECISIONS.md next to the file and line that reads it; repeating that
// here would be two copies of the same research, drifting apart.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import express from 'express'

import { ServerRequest } from '../../server/compat/server-request.js'
import { ServerResponse } from '../../server/compat/server-response.js'
import { RequestParser, type RequestHead } from '../../server/http/parser/request-parser.js'
import { ResponseWriter } from '../../server/http/response/writer.js'
import { crlf } from '../helpers/feed-bytes.js'
import { socketPair, type SocketPair } from '../helpers/socket-pair.js'

const app = express()

type Kind = 'string' | 'number' | 'boolean' | 'function' | 'object' | 'array'

function kindOf(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/** `[member, kind]`, transcribed from the section 4 tables. */
const REQUEST_SURFACE: readonly (readonly [string, Kind])[] = [
  ['method', 'string'],
  ['url', 'string'],
  ['headers', 'object'],
  ['rawHeaders', 'array'],
  ['httpVersion', 'string'],
  ['httpVersionMajor', 'number'],
  ['httpVersionMinor', 'number'],
  ['socket', 'object'],
  ['connection', 'object'],
  ['complete', 'boolean'],
  ['upgrade', 'boolean'],
  ['readable', 'boolean'],
  ['trailers', 'object'],
  ['_readableState', 'object'],
  ['_read', 'function'],
  ['push', 'function'],
  ['pipe', 'function'],
  ['resume', 'function'],
  ['pause', 'function'],
  ['destroy', 'function'],
  ['on', 'function'],
  ['removeListener', 'function'],
  // Not Node's, and part of the contract all the same: module 4 calls these on the object
  // after Express has reparented it.
  ['receiveBody', 'function'],
  ['completeBody', 'function'],
  ['abort', 'function'],
]

const RESPONSE_SURFACE: readonly (readonly [string, Kind])[] = [
  ['statusCode', 'number'],
  ['statusMessage', 'string'],
  ['setHeader', 'function'],
  ['getHeader', 'function'],
  ['getHeaders', 'function'],
  ['getHeaderNames', 'function'],
  ['hasHeader', 'function'],
  ['removeHeader', 'function'],
  ['headersSent', 'boolean'],
  ['writeHead', 'function'],
  ['flushHeaders', 'function'],
  ['write', 'function'],
  ['end', 'function'],
  ['destroy', 'function'],
  ['finished', 'boolean'],
  ['socket', 'object'],
  ['connection', 'object'],
  ['on', 'function'],
  ['removeListener', 'function'],
  ['_write', 'function'],
  ['_final', 'function'],
  ['writableEnded', 'boolean'],
  ['writableLength', 'number'],
  ['writableNeedDrain', 'boolean'],
  ['abort', 'function'],
]

/** From the "deliberately unsupported" list. Every one is reachable after reparenting. */
const REQUEST_REFUSED = ['setTimeout'] as const
const REQUEST_REFUSED_PROPERTIES = ['headersDistinct', 'trailersDistinct'] as const
const RESPONSE_REFUSED = [
  'assignSocket',
  'detachSocket',
  'addTrailers',
  'setTimeout',
  'writeContinue',
  'writeEarlyHints',
  'writeProcessing',
  'writeHeader',
  'appendHeader',
  'setHeaders',
] as const

function headOf(...lines: string[]): RequestHead {
  let head: RequestHead | undefined
  new RequestParser({ onHead: (h) => void (head = h) }).push(crlf(...lines, ''))
  if (head === undefined) throw new Error('fixture produced no head')
  return head
}

const HEAD = ['POST /conformance?x=1 HTTP/1.1', 'Host: localhost', 'Content-Length: 4']

async function withPair(
  body: (request: ServerRequest, response: ServerResponse, pair: SocketPair) => Promise<void> | void,
): Promise<void> {
  const pair = await socketPair()
  try {
    const request = new ServerRequest({ head: headOf(...HEAD), tcp: pair.tcp })
    const response = new ServerResponse({
      writer: new ResponseWriter(pair.tcp, { httpVersion: '1.1' }),
      tcp: pair.tcp,
    })
    await body(request, response, pair)
  } finally {
    await pair.close()
  }
}

function assertSurface(object: object, surface: readonly (readonly [string, Kind])[]): void {
  const missing: string[] = []

  for (const [name, kind] of surface) {
    const actual = kindOf((object as Record<string, unknown>)[name])
    if (actual !== kind) missing.push(`${name}: expected ${kind}, found ${actual}`)
  }

  assert.deepEqual(missing, [], `supported surface not met:\n  ${missing.join('\n  ')}`)
}

function assertRefused(object: object, names: readonly string[]): void {
  for (const name of names) {
    const member = (object as Record<string, unknown>)[name]
    assert.equal(typeof member, 'function', `${name} should be a refusing stub`)
    assert.throws(
      () => (member as () => void).call(object),
      new RegExp(`${name} is unsupported by design`),
      name,
    )
  }
}

test('the request carries its whole supported surface, before and after expressInit', async () => {
  await withPair((request) => {
    assertSurface(request, REQUEST_SURFACE)

    Object.setPrototypeOf(request, app.request)
    assertSurface(request, REQUEST_SURFACE)
  })
})

test('the response carries its whole supported surface, before and after expressInit', async () => {
  await withPair((_request, response) => {
    assertSurface(response, RESPONSE_SURFACE)

    Object.setPrototypeOf(response, app.response)
    assertSurface(response, RESPONSE_SURFACE)
  })
})

test('unsupported members refuse rather than running Node\'s implementation', async () => {
  await withPair((request, response) => {
    assertRefused(request, REQUEST_REFUSED)
    assertRefused(response, RESPONSE_REFUSED)

    // The reparent is the half that matters. Before it these members are simply absent;
    // after it they resolve to Node's, which would run against an object with none of
    // Node's internals -- `assignSocket` against a live keep-alive connection, say.
    Object.setPrototypeOf(request, app.request)
    Object.setPrototypeOf(response, app.response)

    assertRefused(request, REQUEST_REFUSED)
    assertRefused(response, RESPONSE_REFUSED)
  })
})

test('unsupported properties refuse on read rather than answering emptily', async () => {
  await withPair((request) => {
    Object.setPrototypeOf(request, app.request)

    for (const name of REQUEST_REFUSED_PROPERTIES) {
      // Node's own versions answer `{}` here, which is a wrong answer rather than a missing
      // one: the parser resolves duplicate fields on the way in, so the separate values
      // these report are gone before there is a request object.
      assert.throws(
        () => (request as unknown as Record<string, unknown>)[name],
        new RegExp(`${name} is unsupported by design`),
      )
    }

    // Non-enumerable, so nothing that walks the object trips over them.
    assert.ok(!Object.keys(request).includes('headersDistinct'))
    assert.ok(!JSON.stringify(request).includes('headersDistinct'))
  })
})

test('on-finished can tell the two objects apart', async () => {
  await withPair((request, response) => {
    Object.setPrototypeOf(request, app.request)
    Object.setPrototypeOf(response, app.response)

    // `on-finished/index.js:69,74` checks `finished` FIRST and only then `complete`. A
    // request carrying a boolean `finished`, or a response carrying a boolean `complete`,
    // would be classified as the other kind and watched for the wrong events entirely.
    assert.equal(typeof response.finished, 'boolean')
    assert.notEqual(typeof (request as unknown as Record<string, unknown>)['finished'], 'boolean')

    assert.equal(typeof request.complete, 'boolean')
    assert.notEqual(typeof (response as unknown as Record<string, unknown>)['complete'], 'boolean')

    // The rest of `isFinished`: an in-flight exchange is neither finished nor aborted.
    assert.equal(request.upgrade, false)
    assert.equal(request.socket.readable, true)
    assert.equal(response.socket.writable, true)
  })
})

test('raw-body finds the request in the state it insists on', async () => {
  await withPair((request) => {
    Object.setPrototypeOf(request, app.request)

    // `raw-body/index.js:184` refuses with a 500 unless this is true, and `:177` treats a
    // set `_decoder` -- or an encoding on the readable state -- as a stream it cannot
    // measure in bytes.
    assert.equal(request.readable, true)
    const internals = request as unknown as Record<string, { encoding?: unknown } | undefined>
    assert.equal(internals['_decoder'], undefined)
    // `@types/node` does not declare `_readableState`, which is exactly why raw-body reading
    // it is worth a test rather than a type.
    assert.equal(internals['_readableState']?.encoding, null)
  })
})

test('a fresh response reads as one that has not started', async () => {
  await withPair((_request, response) => {
    Object.setPrototypeOf(response, app.response)

    // `finalhandler/index.js:258-260` and `send/index.js:1046-1048` both ask these two, in
    // that order, before deciding whether they may still write a status line.
    assert.equal(response.headersSent, false)
    assert.equal(response._header, null)
    assert.equal(response.finished, false)
  })
})
