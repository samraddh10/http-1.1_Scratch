// module 3.4  server/http/response/error-response.ts -- protocol-error path; imports nothing from compat/
//
// This file exists so that answering a malformed request needs nothing but a socket and a
// `ProtocolError`. It has no route, no listener, no `ServerRequest`, no `ServerResponse` and
// no Express: by the time one of these is written, the bytes on the wire did not form a
// request, so there is nothing to hand to an application and nothing that could have
// handled it. The import list is the assertion -- if it ever grows a `compat/` entry, the
// error path has started depending on the layer that only exists for well-formed requests.

import type { ProtocolError } from '../errors.js'
import { reasonPhrase } from './status.js'
import { ResponseWriter, type ByteSink } from './writer.js'

/** The part of a `Connection` this module needs: bytes in, and a flush-then-close. */
export interface ClosableByteSink extends ByteSink {
  end(reason: 'client-error'): void
}

export interface ErrorResponseOptions {
  readonly serverName?: string
  /** The request's method, when it was read before the failure. A HEAD gets no body. */
  readonly method?: string
}

export interface WrittenErrorResponse {
  readonly status: number
  /** Whether the connection has to close once these bytes have flushed. */
  readonly closeAfter: boolean
}

/**
 * Writes the response for a `ProtocolError` and reports whether the connection can survive
 * it.
 *
 * The body names the status and nothing else. `error.reason` is deliberately not sent: it
 * says which rule was broken and, for the limit errors, roughly where the limit sits, which
 * is server-side detail for the metrics in module 7 rather than something a client that just
 * sent a malformed request has earned.
 */
export function writeErrorResponse(
  sink: ByteSink,
  error: ProtocolError,
  options: ErrorResponseOptions = {},
): WrittenErrorResponse {
  const { status, closeAfter } = error
  const body = `${status} ${reasonPhrase(status)}\n`

  const writerOptions: { serverName?: string; method?: string } = {}
  if (options.serverName !== undefined) writerOptions.serverName = options.serverName
  if (options.method !== undefined) writerOptions.method = options.method

  // Always HTTP/1.1, and never a negotiated version: the request line is the first thing
  // parsed, so a client whose version could not be read is answered in the newer one it
  // would have had to speak to get further than this.
  const response = new ResponseWriter(sink, writerOptions)

  const headers: Record<string, string | number> = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  }
  // A close that is not announced leaves the client holding a socket it thinks it can send
  // the next request on, and waiting out its own timeout to find otherwise.
  if (closeAfter) headers['Connection'] = 'close'

  response.writeHead({ status, headers })
  response.end(body)

  return { status, closeAfter }
}

/**
 * Writes the error response and closes the connection when the error requires it.
 *
 * `end()` rather than `destroy()`: destroying discards whatever is still queued, and what is
 * queued here is the response explaining the close.
 *
 * The close is not a policy choice, it is the only correct move. The parser stopped at
 * whatever byte offset the rule was broken at -- mid-header-line, mid-chunk-size, halfway
 * through a body whose declared length was itself the thing rejected -- so the stream
 * position is no longer trustworthy. Nothing in the remaining bytes says where the next
 * request begins, and reading on would mean guessing: the tail of the broken message would
 * be parsed as a fresh request that the client never sent, which is request smuggling
 * performed by the server on its own connection. The one case that keeps the connection is
 * an error raised after a request was fully framed and consumed, where the position is still
 * known -- `ProtocolError.closeAfter` carries that distinction, and 4.4's 417 is the case.
 */
export function respondToProtocolError(
  connection: ClosableByteSink,
  error: ProtocolError,
  options: ErrorResponseOptions = {},
): WrittenErrorResponse {
  const written = writeErrorResponse(connection, error, options)
  if (written.closeAfter) connection.end('client-error')
  return written
}
