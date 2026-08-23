// module 1.3  test/tcp/byte-buffer.test.ts -- no byte lost, reordered, or invented across chunks

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ByteBuffer } from '../../server/tcp/byte-buffer.js'
import { crlf, forEachSplit, join, splitStrategies } from '../helpers/feed-bytes.js'

const REQUEST_HEAD = crlf(
  'POST /echo/42?debug=1 HTTP/1.1',
  'Host: localhost:3000',
  'Content-Type: application/json',
  'Content-Length: 16',
  '',
)

/**
 * The module 2 read loop, in miniature: append a chunk, pull off every complete CRLF line,
 * and remember how far the scan got so the next chunk does not rescan the whole buffer.
 * Resuming one byte back is the contract indexOfCRLF documents, and this is what breaks if
 * it is wrong.
 */
function readLines(chunks: readonly Buffer[], initialCapacity = 8): string[] {
  const buffer = new ByteBuffer(initialCapacity)
  const lines: string[] = []
  let scanned = 0

  for (const chunk of chunks) {
    buffer.append(chunk)
    for (;;) {
      const at = buffer.indexOfCRLF(scanned)
      if (at === -1) break
      lines.push(buffer.toLatin1(0, at))
      buffer.consume(at + 2)
      scanned = 0
    }
    scanned = Math.max(0, buffer.length - 1)
  }

  assert.equal(buffer.length, 0, 'the fixture ends on a CRLF, so nothing should be left over')
  return lines
}

test('bytes accumulate across chunks and read back byte-identical', () => {
  forEachSplit(REQUEST_HEAD, (chunks, strategy) => {
    const buffer = new ByteBuffer(8)
    for (const chunk of chunks) buffer.append(chunk)

    assert.equal(buffer.length, REQUEST_HEAD.length, strategy)
    assert.deepEqual(buffer.copy(), REQUEST_HEAD, strategy)
  })
})

test('the same lines come out however the bytes are split', () => {
  const expected = [
    'POST /echo/42?debug=1 HTTP/1.1',
    'Host: localhost:3000',
    'Content-Type: application/json',
    'Content-Length: 16',
    '',
  ]

  forEachSplit(REQUEST_HEAD, (chunks, strategy) => {
    assert.deepEqual(readLines(chunks), expected, strategy)
  })
})

test('a CRLF split across an append boundary is still found', () => {
  // The single most likely way to lose a request: CR ends one TCP read, LF starts the next.
  const buffer = new ByteBuffer(8)
  buffer.append(Buffer.from('GET / HTTP/1.1\r', 'latin1'))
  assert.equal(buffer.indexOfCRLF(), -1, 'a trailing CR is incomplete, not absent')

  buffer.append(Buffer.from('\nHost: x\r\n', 'latin1'))
  assert.equal(buffer.indexOfCRLF(14), 14)
  assert.equal(buffer.toLatin1(0, 14), 'GET / HTTP/1.1')
})

test('indexOfCRLF ignores a CR without an LF and a bare LF', () => {
  const buffer = new ByteBuffer()
  buffer.append(Buffer.from('a\rb\nc\r\nd', 'latin1'))

  assert.equal(buffer.indexOfCRLF(), 5, 'the lone CR at 1 and lone LF at 3 are not terminators')
  assert.equal(buffer.indexOfCRLF(6), -1, 'nothing after the match')
  assert.equal(buffer.indexOf(0x3a), -1, 'no colon in this buffer')
})

test('scanning resumes from an offset without rescanning the prefix', () => {
  const buffer = new ByteBuffer()
  buffer.append(crlf('one', 'two', 'three'))

  assert.equal(buffer.indexOfCRLF(0), 3)
  assert.equal(buffer.indexOfCRLF(4), 8)
  assert.equal(buffer.indexOfCRLF(9), 15)
  assert.equal(buffer.indexOfCRLF(buffer.length), -1)
})

test('consume drops a prefix by offset and leaves the rest untouched', () => {
  const buffer = new ByteBuffer(64)
  buffer.append(Buffer.from('HTTP/1.1 200 OK\r\nrest', 'latin1'))
  const before = buffer.capacity

  buffer.consume(17)

  assert.equal(buffer.length, 4)
  assert.equal(buffer.toLatin1(0, 4), 'rest')
  assert.equal(buffer.capacity, before, 'consume must not reallocate')

  buffer.consume(0)
  assert.equal(buffer.length, 4)
  buffer.consume(4)
  assert.equal(buffer.length, 0)
})

test('nothing past the live region is ever visible', () => {
  // The backing store is allocUnsafe and consumed bytes are left in place, so every read
  // has to be bounded by the end of the live region, not by the length of the store.
  const buffer = new ByteBuffer(16)
  buffer.append(Buffer.from('AB', 'latin1'))
  buffer.consume(2)

  buffer.append(Buffer.from('A', 'latin1'))
  assert.equal(buffer.length, 1)
  assert.equal(buffer.indexOf(0x42), -1, 'the B physically still sitting at index 1 is not data')
  assert.equal(buffer.byteAt(1), undefined)

  const line = new ByteBuffer(16)
  line.append(Buffer.from('X\r\n', 'latin1'))
  line.consume(3)
  line.append(Buffer.from('\r', 'latin1'))
  assert.equal(line.indexOfCRLF(), -1, 'the LF left over at index 2 must not complete this CR')
})

test('interleaved append and consume never loses or reorders a byte', () => {
  const source = Buffer.from(Array.from({ length: 20_000 }, (_, i) => i % 251))

  const LEFTOVER = 3

  for (const strategy of splitStrategies) {
    const chunks = strategy.split(source)
    const buffer = new ByteBuffer(8)
    const drained: Buffer[] = []

    for (const chunk of chunks) {
      buffer.append(chunk)
      // Leave a few bytes behind each round so the start and end offsets stay out of step
      // and the compaction path is the one under test.
      const take = Math.max(0, buffer.length - LEFTOVER)
      drained.push(buffer.copy(0, take))
      buffer.consume(take)
    }
    drained.push(buffer.copy())

    assert.deepEqual(join(drained), source, strategy.name)

    // The buffer is only ever asked to hold one chunk plus the leftover, so its capacity
    // must be bounded by that and not by the 20 KB that passed through it. Doubling
    // overshoots by up to 2x, and 4x leaves room for that without hiding a leak.
    const workingSet = Math.max(...chunks.map((chunk) => chunk.length)) + LEFTOVER
    const bound = Math.max(16, workingSet * 4)
    assert.ok(
      buffer.capacity <= bound,
      `${strategy.name}: capacity ${buffer.capacity} exceeds ${bound} for a working set of ${workingSet} bytes`,
    )
  }
})

test('the backing store grows to fit and is released once the buffer empties', () => {
  const buffer = new ByteBuffer(64)
  const big = Buffer.alloc(10_000, 0x7a)

  buffer.append(big)
  assert.equal(buffer.length, big.length)
  assert.ok(buffer.capacity >= big.length)
  assert.deepEqual(buffer.copy(), big)

  buffer.consume(big.length)
  assert.equal(buffer.capacity, 64, 'a drained buffer must not keep a body-sized allocation')
})

test('peek is a view of the buffer and copy is owned', () => {
  const buffer = new ByteBuffer(64)
  buffer.append(Buffer.from('name: value', 'latin1'))

  const view = buffer.peek(6, 11)
  const owned = buffer.copy(6, 11)
  assert.deepEqual(view, Buffer.from('value', 'latin1'))
  assert.deepEqual(owned, view)

  owned.fill(0x78)
  assert.equal(buffer.toLatin1(6, 11), 'value', 'a copy must not alias the buffer')

  assert.deepEqual(buffer.peek(), buffer.copy())
  assert.equal(buffer.peek(4, 4).length, 0)
})

test('reads are decoded from an explicit range only', () => {
  const buffer = new ByteBuffer()
  buffer.append(Buffer.from('GET /a HTTP/1.1', 'latin1'))

  assert.equal(buffer.toLatin1(0, 3), 'GET')
  assert.equal(buffer.toLatin1(4, 6), '/a')
  assert.equal(buffer.byteAt(3), 0x20)

  // Every byte value survives the round trip; utf8 would not carry 0x80-0xff back out.
  const opaque = new ByteBuffer()
  const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
  opaque.append(allBytes)
  assert.deepEqual(Buffer.from(opaque.toLatin1(0, 256), 'latin1'), allBytes)
})

test('out-of-range access throws rather than reading neighbouring memory', () => {
  const buffer = new ByteBuffer(16)
  buffer.append(Buffer.from('abcd', 'latin1'))

  assert.throws(() => buffer.toLatin1(0, 5), RangeError)
  assert.throws(() => buffer.toLatin1(3, 1), RangeError)
  assert.throws(() => buffer.toLatin1(-1, 2), RangeError)
  assert.throws(() => buffer.peek(0, 9), RangeError)
  assert.throws(() => buffer.indexOfCRLF(5), RangeError)
  assert.throws(() => buffer.consume(5), RangeError)
  assert.throws(() => buffer.consume(-1), RangeError)
  assert.throws(() => buffer.consume(1.5), RangeError)
  assert.throws(() => new ByteBuffer(0), RangeError)

  assert.equal(buffer.byteAt(4), undefined, 'byteAt reports absence instead of throwing')
  assert.equal(buffer.toLatin1(0, 4), 'abcd', 'a rejected read leaves the buffer untouched')
})

test('reset drops everything held', () => {
  const buffer = new ByteBuffer(32)
  buffer.append(crlf('GET / HTTP/1.1', 'Host: x', ''))

  buffer.reset()

  assert.equal(buffer.length, 0)
  assert.equal(buffer.indexOfCRLF(), -1)
  assert.equal(buffer.copy().length, 0)

  buffer.append(Buffer.from('next', 'latin1'))
  assert.equal(buffer.toLatin1(0, 4), 'next')
})

test('appending nothing is a no-op', () => {
  const buffer = new ByteBuffer(16)
  buffer.append(Buffer.alloc(0))
  assert.equal(buffer.length, 0)

  buffer.append(Buffer.from('x', 'latin1'))
  buffer.append(Buffer.alloc(0))
  assert.equal(buffer.length, 1)
  assert.equal(buffer.toLatin1(0, 1), 'x')
})
