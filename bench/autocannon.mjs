// module 9.4  bench/autocannon.mjs -- four scenarios: keep-alive on/off x wirehttp/node:http
//
// The listener is three lines of plain JavaScript and is identical on both servers. That is
// deliberate: mounting Express here would measure Express, which is the same on both sides
// and would compress the only difference this is trying to show. What is being compared is
// the parse-and-write path -- module 1 through module 5 against Node's equivalent.
//
// Keep-alive off is the harsher of the two for a from-scratch server, because every request
// pays for a fresh accept, a fresh parser and a teardown, so the connection lifecycle is
// exposed rather than amortised over a long-lived socket.
//
// Run with `npm run bench`. Results are written to docs/bench.txt exactly as measured; a
// slower number goes in as-is.

import { createServer as createNodeServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import autocannon from 'autocannon'

import { createServer as createWireServer } from '../server/index.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUTPUT = join(ROOT, 'docs', 'bench.txt')

const DURATION_S = Number(process.env.BENCH_DURATION ?? 10)
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 50)

const BODY = 'hello from the benchmark\n'

function listener(_request, response) {
  response.setHeader('Content-Type', 'text/plain')
  response.end(BODY)
}

async function startNode() {
  const server = createNodeServer(listener)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    stop: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function startWire() {
  const server = createWireServer(listener)
  server.listen(0, '127.0.0.1')
  const address = await server.ready()
  return {
    port: address.port,
    stop: () => new Promise((resolve) => server.close(resolve)),
  }
}

const SERVERS = [
  { name: 'wirehttp', start: startWire },
  { name: 'node:http', start: startNode },
]
const KEEP_ALIVE = [
  { name: 'keep-alive', headers: {} },
  { name: 'close', headers: { connection: 'close' } },
]

async function run({ port, headers }) {
  return autocannon({
    url: `http://127.0.0.1:${port}/bench`,
    connections: CONNECTIONS,
    duration: DURATION_S,
    pipelining: 1,
    headers,
  })
}

function row(label, result) {
  const nonTwoXX = result.non2xx ?? 0
  return [
    label.padEnd(22),
    `${Math.round(result.requests.average).toString().padStart(9)} req/s`,
    `${result.latency.average.toFixed(2).padStart(8)} ms avg`,
    `${result.latency.p99.toFixed(2).padStart(8)} ms p99`,
    `${(result.throughput.average / 1_048_576).toFixed(2).padStart(7)} MB/s`,
    `${String(result.errors).padStart(4)} err`,
    `${String(nonTwoXX).padStart(4)} non-2xx`,
  ].join('  ')
}

const lines = [
  'wirehttp benchmark -- captured output, not averaged over repeated runs',
  '',
  `date         ${new Date().toISOString()}`,
  `node         ${process.version}`,
  `platform     ${process.platform} ${process.arch}`,
  `duration     ${DURATION_S}s per scenario`,
  `connections  ${CONNECTIONS}`,
  `payload      GET /bench -> 200, ${BODY.length} byte text body, identical listener on both`,
  '',
]

for (const server of SERVERS) {
  for (const mode of KEEP_ALIVE) {
    const label = `${server.name} / ${mode.name}`
    process.stderr.write(`running ${label} ...\n`)

    const started = await server.start()
    try {
      const result = await run({ port: started.port, headers: mode.headers })
      lines.push(row(label, result))
    } finally {
      await started.stop()
    }
  }
}

const report = `${lines.join('\n')}\n`
process.stdout.write(`\n${report}`)

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, report)
process.stderr.write(`\nwritten to ${OUTPUT}\n`)
