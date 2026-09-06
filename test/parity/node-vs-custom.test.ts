// module 9.3  test/parity/node-vs-custom.test.ts -- the same Express app on both servers
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer as createNodeServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { createServer as createWireServer, type WireServer } from '../../server/index.js'
import { createParityApp } from './app.js'

/**
 * Headers that are allowed to differ, with the reason each one is on the list.
 *
 * `date` moves between the two requests and `server` names the implementation, so both are
 * differences the parity claim never included. `connection` and `keep-alive` describe how
 * each server manages the socket rather than what the application returned; they are asserted
 * directly, on literal bytes, in test/connection/raw-protocol.test.ts and keep-alive.test.ts.
 * Nothing else is excused -- a header that differs and is not on this list fails the test.
 */
const NOT_COMPARED = new Set(['date', 'server', 'connection', 'keep-alive'])

interface Case {
  readonly name: string
  readonly path: string
  readonly init?: RequestInit
}

const CASES: readonly Case[] = [
  { name: 'a plain text route', path: '/' },
  { name: 'a HEAD, which carries the head and no body', path: '/', init: { method: 'HEAD' } },
  { name: 'a route parameter', path: '/echo/42' },
  { name: 'a query string, percent-encoded', path: '/echo/42?debug=1&q=a%20b&list=1&list=2' },
  {
    name: 'a JSON body through express.json()',
    path: '/echo',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'shriy', nested: { ok: true } }),
    },
  },
  {
    name: 'a malformed JSON body, which body-parser rejects',
    path: '/echo',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"unterminated": ',
    },
  },
  {
    name: 'a urlencoded body',
    path: '/form',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=two+words',
    },
  },
  {
    name: 'a request header read back through req.get()',
    path: '/headers',
    init: { headers: { 'X-Custom': 'present' } },
  },
  { name: 'a redirect', path: '/redirect', init: { redirect: 'manual' } },
  { name: 'a 204', path: '/status/204' },
  { name: 'next() falling through to a second handler', path: '/next' },
  { name: 'a static file through express.static()', path: '/assets/hello.txt' },
  { name: 'res.sendFile()', path: '/file' },
  { name: 'a thrown error reaching the error middleware', path: '/boom' },
  { name: 'an unrouted path reaching finalhandler', path: '/nothing/here' },
]

interface Observed {
  readonly status: number
  readonly statusText: string
  readonly headers: Record<string, string>
  readonly body: string
}

async function observe(base: string, testCase: Case): Promise<Observed> {
  const response = await fetch(`${base}${testCase.path}`, testCase.init)

  const headers: Record<string, string> = {}
  for (const [name, value] of [...response.headers].sort(([a], [b]) => a.localeCompare(b))) {
    if (!NOT_COMPARED.has(name)) headers[name] = value
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: await response.text(),
  }
}

const staticDir = mkdtempSync(join(tmpdir(), 'wirehttp-parity-'))
writeFileSync(join(staticDir, 'hello.txt'), 'a file served off disk\n')

// One instance, handed to both servers. Two instances would compare two apps that merely
// look alike; this compares the same object reached through two different sets of request
// and response objects, which is the thing actually under test.
const app = createParityApp({ staticDir })

const nodeServer: Server = createNodeServer(app)
nodeServer.listen(0, '127.0.0.1')

const wireServer: WireServer = createWireServer(app as never)
wireServer.listen(0, '127.0.0.1')

const [nodeAddress] = await Promise.all([
  once(nodeServer, 'listening').then(() => nodeServer.address() as AddressInfo),
  wireServer.ready(),
])
const wireAddress = wireServer.address() as AddressInfo

const NODE_BASE = `http://127.0.0.1:${nodeAddress.port}`
const WIRE_BASE = `http://127.0.0.1:${wireAddress.port}`

test.after(() => {
  nodeServer.close()
  wireServer.close()
  rmSync(staticDir, { recursive: true, force: true })
})

for (const testCase of CASES) {
  test(`parity: ${testCase.name}`, async () => {
    const [node, wire] = await Promise.all([
      observe(NODE_BASE, testCase),
      observe(WIRE_BASE, testCase),
    ])

    assert.deepEqual(
      { status: wire.status, statusText: wire.statusText },
      { status: node.status, statusText: node.statusText },
      `${testCase.path}: status line differs`,
    )
    assert.deepEqual(wire.headers, node.headers, `${testCase.path}: headers differ`)
    assert.equal(wire.body, node.body, `${testCase.path}: body differs`)
  })
}

test('the parity suite is actually reaching two different servers', async () => {
  // Without this the suite is vacuous in its most embarrassing way: a misconfigured base URL
  // would compare one server against itself and pass all fifteen cases above. Different
  // ports is not enough to prove it -- the responses have to be identifiably from each
  // implementation, and `Server` is the one header that says which. It is on NOT_COMPARED
  // precisely because the two disagree about it, which is what makes it usable here.
  const [node, wire] = await Promise.all([fetch(`${NODE_BASE}/`), fetch(`${WIRE_BASE}/`)])
  await Promise.all([node.text(), wire.text()])

  assert.notEqual(nodeAddress.port, wireAddress.port)
  assert.equal(wire.headers.get('server'), 'wirehttp')
  assert.equal(node.headers.get('server'), null, 'the node:http base is answering as wirehttp')
})
