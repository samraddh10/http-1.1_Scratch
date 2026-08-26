// module 3.1  server/http/response/status.ts -- status code -> reason-phrase table

export const STATUS_CODES: Readonly<Record<number, string>> = Object.freeze({
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  103: 'Early Hints',

  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',

  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',

  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a Teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Content',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',

  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  510: 'Not Extended',
  511: 'Network Authentication Required',
})

/**
 * The statuses this server has to actually produce, each with the subphase that produces
 * it. The phase 3 gate is "all 14 produced, not merely defined", and a table of phrases
 * proves only the second half -- this list is what the later suites assert against.
 */
export const REQUIRED_STATUSES: readonly number[] = [
  100, // 4.4  the Expect: 100-continue interim
  200, // 3.2  the ordinary framed response
  204, // 3.3  no body and no framing header
  304, // 3.3  no body and no framing header
  400, // 2.x  a malformed request, and 3.4's standalone responder
  404, // 6.1  finalhandler, through the compat layer
  408, // 4.2  the idle timeout
  413, // 2.4  a body over maxBodyBytes
  414, // 2.1  a request line over maxRequestLineBytes
  417, // 4.4  an Expect this server does not implement
  431, // 2.3  a header section over maxHeaderCount or maxHeaderBytes
  500, // 6.2  a thrown error reaching the error middleware
  501, // 2.2  an unimplemented method, and 2.4's non-chunked transfer coding
  505, // 2.2  a version other than 1.0 or 1.1
]

/** RFC 9112 section 4: status-code is exactly three digits. */
export function isValidStatus(code: number): boolean {
  return Number.isInteger(code) && code >= 100 && code <= 999
}

export function isInformational(code: number): boolean {
  return code >= 100 && code < 200
}

export function reasonPhrase(code: number): string {
  return STATUS_CODES[code] ?? 'Unknown'
}
