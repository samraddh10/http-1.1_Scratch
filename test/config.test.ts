// module 0.2  test/config.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { defaults, envNameFor, loadConfig, type Env } from '../server/config.js'

test('defaults are present and positive', () => {
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === 'number') {
      assert.ok(Number.isInteger(value) && value > 0, `${key} should be a positive integer`)
    } else {
      assert.ok(value.length > 0, `${key} should not be empty`)
    }
  }
})

test('default limits match the values they were chosen from', () => {
  // Not arbitrary: these are the numbers nginx and Node actually ship, which is a better
  // answer than "they seemed reasonable" if anyone asks where they came from.
  assert.equal(defaults.maxHeaderBytes, 16_384, "Node's --max-http-header-size default")
  assert.equal(defaults.maxRequestLineBytes, 8_192, "nginx's large_client_header_buffers default")
})

test('env var names are derived from config keys', () => {
  assert.equal(envNameFor('idleTimeoutMs'), 'WIREHTTP_IDLE_TIMEOUT_MS')
  assert.equal(envNameFor('maxHeaderBytes'), 'WIREHTTP_MAX_HEADER_BYTES')
  assert.equal(envNameFor('port'), 'WIREHTTP_PORT')
})

test('an env override replaces just that value', () => {
  const env: Env = { WIREHTTP_MAX_HEADER_BYTES: '64' }
  const config = loadConfig(env)

  assert.equal(config.maxHeaderBytes, 64)
  // Everything else is untouched. This is the property the parser tests rely on: they
  // shrink one limit to a tiny number so the branch can be hit without sending 16 KB.
  assert.equal(config.maxHeaderCount, defaults.maxHeaderCount)
  assert.equal(config.port, defaults.port)
})

test('an absent or empty override falls back to the default', () => {
  assert.equal(loadConfig({}).idleTimeoutMs, defaults.idleTimeoutMs)
  assert.equal(loadConfig({ WIREHTTP_IDLE_TIMEOUT_MS: '' }).idleTimeoutMs, defaults.idleTimeoutMs)
})

test('a malformed override throws at load rather than silently disabling the limit', () => {
  // The failure this prevents: Number('16k') is NaN, and `bytes > NaN` is always false,
  // so a mistyped cap would switch the control off with nothing looking wrong.
  for (const bad of ['16k', 'abc', '0', '-1', '1.5', 'Infinity']) {
    assert.throws(
      () => loadConfig({ WIREHTTP_MAX_HEADER_BYTES: bad }),
      /WIREHTTP_MAX_HEADER_BYTES must be a positive integer/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    )
  }
})

test('loadConfig does not mutate the defaults', () => {
  const before = { ...defaults }
  loadConfig({ WIREHTTP_PORT: '8080' })
  assert.deepEqual(defaults, before)
})
