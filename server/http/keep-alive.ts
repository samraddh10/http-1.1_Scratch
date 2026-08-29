// module 4.1  server/http/keep-alive.ts -- whether a connection survives one exchange

import { listTokens } from './parser/tokens.js'

export interface PersistenceInput {
  readonly httpVersion: '1.0' | '1.1'
  /** The request's `Connection` field as parsed, or undefined when it sent none. */
  readonly connection?: string | undefined
  /** Set when the server has already decided this exchange is the connection's last. */
  readonly serverWantsClose?: boolean
}

export type PersistenceReason =
  | 'client-asked-to-close'
  | 'server-asked-to-close'
  | 'http-1.1-default'
  | 'http-1.0-default'
  | 'http-1.0-keep-alive'

export interface Persistence {
  /** Whether the connection stays open for another request after this exchange. */
  readonly keepAlive: boolean
  readonly reason: PersistenceReason
}

/**
 * Decides whether one connection survives one exchange.
 *
 * The two versions have opposite defaults and that is the whole rule. HTTP/1.1 connections
 * are persistent unless a `close` says otherwise (RFC 9112 section 9.3); HTTP/1.0 predates
 * persistence, so a 1.0 connection ends with its response unless the client opted in with
 * the `keep-alive` extension. Getting the default backwards is silent in both directions:
 * closing a 1.1 connection costs a handshake per request, and holding a 1.0 one open leaves
 * a client waiting on a response it has already been sent in full.
 */
export function decidePersistence(input: PersistenceInput): Persistence {
  // `Connection` is a list of case-insensitive tokens, RFC 9110 section 7.6.1.
  const options = listTokens(input.connection)

  if (options.has('close')) return { keepAlive: false, reason: 'client-asked-to-close' }
  if (input.serverWantsClose === true) {
    return { keepAlive: false, reason: 'server-asked-to-close' }
  }

  if (input.httpVersion === '1.1') return { keepAlive: true, reason: 'http-1.1-default' }

  return options.has('keep-alive')
    ? { keepAlive: true, reason: 'http-1.0-keep-alive' }
    : { keepAlive: false, reason: 'http-1.0-default' }
}
