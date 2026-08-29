// module 4.1  test/connection/keep-alive.test.ts -- the persistence decision, and the header it produces

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decidePersistence } from '../../server/http/keep-alive.js'
import { ResponseWriter, type ByteSink } from '../../server/http/response/writer.js'

function collect(): ByteSink & { text(): string } {
  const chunks: Buffer[] = []
  return {
    write(data) {
      chunks.push(typeof data === 'string' ? Buffer.from(data, 'latin1') : data)
      return true
    },
    text: () => Buffer.concat(chunks).toString('latin1'),
  }
}

test('HTTP/1.1 is persistent unless the client says otherwise', () => {
  assert.deepEqual(decidePersistence({ httpVersion: '1.1' }), {
    keepAlive: true,
    reason: 'http-1.1-default',
  })
  assert.deepEqual(decidePersistence({ httpVersion: '1.1', connection: 'keep-alive' }), {
    keepAlive: true,
    reason: 'http-1.1-default',
  })
  assert.deepEqual(decidePersistence({ httpVersion: '1.1', connection: 'close' }), {
    keepAlive: false,
    reason: 'client-asked-to-close',
  })
})

test('HTTP/1.0 closes unless the client opts in', () => {
  assert.deepEqual(decidePersistence({ httpVersion: '1.0' }), {
    keepAlive: false,
    reason: 'http-1.0-default',
  })
  assert.deepEqual(decidePersistence({ httpVersion: '1.0', connection: 'keep-alive' }), {
    keepAlive: true,
    reason: 'http-1.0-keep-alive',
  })
  assert.deepEqual(decidePersistence({ httpVersion: '1.0', connection: 'close' }), {
    keepAlive: false,
    reason: 'client-asked-to-close',
  })
})

test('the Connection field is a token list, matched case-insensitively', () => {
  for (const value of ['Close', 'CLOSE', 'keep-alive, close', 'TE ,  Close', 'close,']) {
    assert.equal(
      decidePersistence({ httpVersion: '1.1', connection: value }).keepAlive,
      false,
      `expected ${JSON.stringify(value)} to end the connection`,
    )
  }

  // A token that merely contains "close" is a different token.
  assert.equal(decidePersistence({ httpVersion: '1.1', connection: 'closed' }).keepAlive, true)
})

test('a server-side decision closes a connection the client was happy to keep', () => {
  assert.deepEqual(
    decidePersistence({ httpVersion: '1.1', connection: 'keep-alive', serverWantsClose: true }),
    { keepAlive: false, reason: 'server-asked-to-close' },
  )
})

test('a persistent 1.1 response says nothing, because persistence is the default', () => {
  const sink = collect()
  const response = new ResponseWriter(sink, { httpVersion: '1.1', keepAlive: true })
  response.end('hi')

  assert.equal(/^connection:/im.test(sink.text()), false, sink.text())
  assert.equal(response.mustCloseAfter, false)
})

test('a persistent 1.0 response says so, because closing is the default there', () => {
  const sink = collect()
  const response = new ResponseWriter(sink, { httpVersion: '1.0', keepAlive: true })
  response.end('hi')

  assert.match(sink.text(), /\r\nConnection: keep-alive\r\n/)
  assert.equal(response.mustCloseAfter, false)
})

test('a non-persistent response announces the close in both versions', () => {
  for (const httpVersion of ['1.0', '1.1'] as const) {
    const sink = collect()
    const response = new ResponseWriter(sink, { httpVersion, keepAlive: false })
    response.end('hi')

    assert.match(sink.text(), /\r\nConnection: close\r\n/, httpVersion)
    assert.equal(response.mustCloseAfter, true)
  }
})

test('a close-delimited body overrules a keep-alive the request asked for', () => {
  const sink = collect()
  const response = new ResponseWriter(sink, { httpVersion: '1.0', keepAlive: true })
  // No length in hand at head time and no chunked coding in 1.0: the close is the framing.
  response.writeHead({ status: 200 })
  response.end('hi')

  assert.equal(response.framing?.kind, 'close')
  assert.match(sink.text(), /\r\nConnection: close\r\n/)
  assert.equal(response.mustCloseAfter, true)
})

test('a Connection header the application set is a close that actually happens', () => {
  const sink = collect()
  const response = new ResponseWriter(sink, { httpVersion: '1.1', keepAlive: true })
  response.writeHead({ status: 200, headers: { Connection: 'close' } })
  response.end('hi')

  assert.equal(sink.text().match(/\r\nConnection: /g)?.length, 1)
  assert.equal(response.mustCloseAfter, true)
})

test('an interim response carries no Connection header of its own', () => {
  const sink = collect()
  const response = new ResponseWriter(sink, { httpVersion: '1.1', keepAlive: false })
  response.writeHead({ status: 100, framing: { kind: 'none' } })

  assert.equal(sink.text(), 'HTTP/1.1 100 Continue\r\n\r\n')
})

test('onFinish fires once, after the last byte of the response', () => {
  const sink = collect()
  let seen = 0
  let textAtFinish = ''

  const response = new ResponseWriter(sink, {
    keepAlive: true,
    onFinish: () => {
      seen++
      textAtFinish = sink.text()
    },
  })

  response.write('one')
  assert.equal(seen, 0)

  response.end('two')
  assert.equal(seen, 1)
  assert.match(textAtFinish, /onetwo|0\r\n\r\n$/)
})
