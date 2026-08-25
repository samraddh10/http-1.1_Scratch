// module 2.1  server/http/errors.ts -- ProtocolError { status, closeAfter, reason }

export interface ProtocolErrorOptions {
  closeAfter?: boolean
}

//Purpose: Represents one specific failure while reading or interpreting an HTTP request. It extends the built-in Error so it behaves like a normal JavaScript error
export class ProtocolError extends Error {
  override readonly name = 'ProtocolError'

  /** The status the client is answered with. */
  readonly status: number

  /** Short machine-stable description of the rule that was broken. */
  readonly reason: string

  /**
   * Whether the connection must close once the error response is written.
   *
   * True for anything raised mid-message: the parser stopped at an arbitrary byte offset,
   * and there is no way to find where the next request begins in what is left. Sending an
   * error and then continuing to read would hand the remainder of a broken message to the
   * next request as if the client had sent it, which is the smuggling primitive this
   * server exists to not have.
   *
   * False is for errors raised once a request is fully framed and consumed, where the
   * stream position is still known -- 417 in subphase 4.4 is the case that needs it.
   */
  readonly closeAfter: boolean

  constructor(status: number, reason: string, options: ProtocolErrorOptions = {}) {
    super(`${status} ${reason}`)
    this.status = status
    this.reason = reason
    this.closeAfter = options.closeAfter ?? true
  }
}

/** Malformed: the bytes do not form a request this server can interpret. */
export function badRequest(reason: string): ProtocolError {
  return new ProtocolError(400, reason)
}

/** The request line ran past `maxRequestLineBytes` before a CRLF appeared. */
export function uriTooLong(): ProtocolError {
  return new ProtocolError(414, 'request line exceeds the configured limit')
}

/** The header section ran past `maxHeaderCount` or `maxHeaderBytes`. */
export function headerFieldsTooLarge(reason: string): ProtocolError {
  return new ProtocolError(431, reason)
}

/** A declared or observed body larger than `maxBodyBytes`. */
export function contentTooLarge(reason: string): ProtocolError {
  return new ProtocolError(413, reason)
}

/** Well-formed request line naming a method this server does not implement. */
export function notImplemented(method: string): ProtocolError {
  return new ProtocolError(501, `method ${method} is not implemented`)
}

/** A version other than HTTP/1.0 or HTTP/1.1. */
export function versionNotSupported(version: string): ProtocolError {
  return new ProtocolError(505, `version ${version} is not supported`)
}
