// module 7.1  test/metrics/ring-buffer.test.ts -- the buffer never grows past N

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RingBuffer } from '../../server/metrics/ring-buffer.js'

test('a capacity that is not a positive integer is refused', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new RingBuffer<number>(bad), RangeError, `capacity ${String(bad)}`)
  }
})

test('below capacity it holds everything, newest first', () => {
  const buffer = new RingBuffer<number>(4)
  assert.equal(buffer.size, 0)
  assert.deepEqual(buffer.recent(), [])

  buffer.push(1)
  buffer.push(2)
  buffer.push(3)

  assert.equal(buffer.size, 3)
  assert.equal(buffer.capacity, 4)
  assert.deepEqual(buffer.recent(), [3, 2, 1])
})

/**
 * The whole reason this class exists. A hundred thousand entries through a buffer of eight
 * leaves eight, and they are the last eight -- if the storage grew, or the wrap dropped the
 * wrong end, one of the two assertions fails.
 */
test('a hundred thousand pushes leave exactly the newest capacity entries', () => {
  const capacity = 8
  const pushes = 100_000
  const buffer = new RingBuffer<number>(capacity)

  for (let i = 0; i < pushes; i++) buffer.push(i)

  assert.equal(buffer.size, capacity)
  assert.equal(buffer.capacity, capacity)
  assert.deepEqual(
    buffer.recent(),
    [99_999, 99_998, 99_997, 99_996, 99_995, 99_994, 99_993, 99_992],
  )
})

test('a buffer of one keeps only the last entry', () => {
  const buffer = new RingBuffer<string>(1)
  buffer.push('a')
  buffer.push('b')

  assert.equal(buffer.size, 1)
  assert.deepEqual(buffer.recent(), ['b'])
})

test('recent() is capped by what is held, not by what is asked for', () => {
  const buffer = new RingBuffer<number>(4)
  for (const n of [1, 2, 3, 4, 5]) buffer.push(n)

  assert.deepEqual(buffer.recent(2), [5, 4])
  assert.deepEqual(buffer.recent(100), [5, 4, 3, 2])
  assert.deepEqual(buffer.recent(0), [])
  assert.deepEqual(buffer.recent(-1), [])
})
