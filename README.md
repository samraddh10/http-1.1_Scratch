# wirehttp

An HTTP/1.1 server written from scratch on raw TCP sockets, exposed behind a
Node-`http`-compatible interface, running an unmodified Express app on top.

Nothing in `server/` imports `node:http` as a value. The request line, the header section,
the body framing, the response serialiser, the keep-alive decision and the connection
lifecycle are all implemented here, on `net.Socket` and a byte buffer. Express does not know
the difference: `app/server.ts` swaps one import line and the same application serves the
same responses.

```ts
// app/server.ts
// import { createServer } from 'node:http'
import { createServer } from '../server/index.js'

const app = express()
app.use(express.json())
app.use(createRoutes(...))

const server = createServer(app)
server.listen(3000)
```

## Quick start

```
npm install
npm start          # builds the dashboard, then serves it on http://localhost:3000
npm run dev        # tsx watch, no frontend build
npm test           # 331 tests, node:test
npm run typecheck  # server and frontend projects
npm run bench      # autocannon, four scenarios, writes docs/bench.txt
```

Requires Node 22 or newer.

Routes the demo app serves: `/` (plain text), `/echo/:id` and `POST /echo` (JSON echo),
`/boom` (throws on purpose, to exercise the error handler), `/api/metrics` (snapshot JSON)
and `/api/metrics/stream` (server-sent events). The React dashboard is served at the root
from `public/` once `npm run build:frontend` has filled it.

## Layout

```
server/
  tcp/            module 1  sockets, accept loop, byte buffer, backpressure
    server.ts               net.createServer, connection cap, close() that resolves
    connection.ts           per-socket state, idle timer, write path, drain waiters
    byte-buffer.ts          growable read buffer with delimiter scanning
  http/
    parser/       module 2  request line, headers, framing, body, trailers
      request-parser.ts     the state machine; push(bytes) in, events out
      request-line.ts       method, target, version
      headers.ts            field parsing, duplicate policy, obs-fold rejection
      framing.ts            Content-Length vs Transfer-Encoding, smuggling rejection
      body.ts               length and chunked decoders
      target.ts             path/query split, percent-decode, traversal rejection
      tokens.ts             RFC token and field-value primitives
      states.ts             the five states and the legal transitions between them
    response/     module 3  the sending side
      writer.ts             status line, header serialisation, framing, bodyless rules
      status.ts             status classification and reason phrases
      error-response.ts     the protocol-error path; imports nothing from compat/
    connection.ts module 4  one socket, many exchanges; owns the parser
    keep-alive.ts           whether a connection survives an exchange
    errors.ts               ProtocolError { status, closeAfter, reason }
  compat/         module 5  the Node-shaped surface
    create-server.ts        createServer(listener) -> WireServer
    server-request.ts       a Readable that stands in for http.IncomingMessage
    server-response.ts      a Writable that stands in for http.ServerResponse
    own-props.ts            keeps shim methods reachable after Express reparents them
  metrics/        module 7  counters, ring buffer of recent requests
  config.ts       module 0  every limit and timeout, with env overrides
app/              module 6  the Express program and its routes
frontend/         module 8  React dashboard over the SSE stream
test/             module 9  331 tests
bench/            module 9  autocannon, wirehttp against node:http
```

## Limits

All in [`server/config.ts`](server/config.ts), all overridable by environment variable.

| Control | Default | Status on breach |
| --- | --- | --- |
| `WIREHTTP_IDLE_TIMEOUT_MS` | 5,000 | 408, then close |
| `WIREHTTP_MAX_CONNECTIONS` | 512 | socket closed on arrival |
| `WIREHTTP_MAX_REQUESTS_PER_CONNECTION` | 100 | `Connection: close` |
| `WIREHTTP_MAX_REQUEST_LINE_BYTES` | 8,192 | 414 |
| `WIREHTTP_MAX_HEADER_COUNT` | 100 | 431 |
| `WIREHTTP_MAX_HEADER_BYTES` | 16,384 | 431 |
| `WIREHTTP_MAX_BODY_BYTES` | 1,048,576 | 413 |
| `WIREHTTP_MAX_CHUNK_SIZE_BYTES` | 1,048,576 | 400 |
| `WIREHTTP_MAX_CHUNK_LINE_BYTES` | 1,024 | 400 |

The idle timeout is the slowloris control and the two header caps are the header-bomb
control. A bad value throws at boot rather than falling back: `bytes > NaN` is always false,
so a mistyped limit would disable the check and nothing would look wrong.

## Metrics and the dashboard

The server records connection counts, request totals, a five-second requests-per-second
window, keep-alive reuse, status-code counts and a fixed-size ring buffer of recent
requests - each with the request head as text, what the parser made of it, the status and
the duration. `/api/metrics` returns a snapshot; `/api/metrics/stream` pushes one every 500
ms over server-sent events.

The dashboard in [`frontend/`](frontend/) is React and Tailwind built by Vite into
`public/`, and served by `express.static` through wirehttp itself. There is no dev server
and no proxy: the page arrives over the wire format this project implements, or it does not
arrive.

## Tests

331 tests under `node:test`, no test framework.

| Directory | Covers |
| --- | --- |
| `test/tcp/` | byte buffer, connection lifecycle, accept loop, backpressure |
| `test/parser/` | request line, headers, framing, chunked bodies, targets, state machine |
| `test/response/` | writer, framing, bodyless rules, error responses |
| `test/connection/` | keep-alive, persistence, timeouts, caps, 100-continue, raw bytes |
| `test/compat/` | the two shims, `createServer`, own-property pinning, conformance |
| `test/metrics/` | registry, ring buffer, instrumentation, endpoints |
| `test/parity/` | the same Express app on wirehttp and on `node:http`, responses compared |
| `test/guard/` | no `node:http` value import under `server/` |

The parity suite mounts one Express app on both servers and compares status, headers and
body for each case - route parameters, percent-encoded queries, JSON and urlencoded bodies,
malformed JSON that body-parser rejects, HEAD, redirects, 204s, `next()` fallthrough,
`express.static()`, `res.sendFile()`, thrown handlers and unrouted paths.
Only `date`, `server`, `connection` and `keep-alive` are excused, each for a stated reason;
a header that differs and is not on that list fails the test. Connection-level behaviour is
asserted separately against literal bytes on the socket.

## Benchmark

`npm run bench` runs four scenarios - keep-alive on and off, wirehttp and `node:http` - with
an identical three-line listener on both sides, so what is measured is the parse-and-write
path rather than Express. Captured output, Node 22.14.0 on win32 x64, 10 s per scenario, 50
connections, 25-byte text body:

```
wirehttp / keep-alive       21821 req/s     49.48 ms avg    101.00 ms p99     3.02 MB/s
wirehttp / close             3906 req/s   2496.68 ms avg   4933.00 ms p99     0.61 MB/s
node:http / keep-alive      47478 req/s      0.63 ms avg      2.00 ms p99     7.88 MB/s
node:http / close            4421 req/s   2479.55 ms avg   4944.00 ms p99     0.62 MB/s
```

Node's parser is native C and roughly twice as fast on a warm keep-alive connection, which
is the honest result. Without keep-alive the two converge, because the cost there is the
accept and teardown that both pay to the same kernel.

## License

Unlicensed personal project.
