// module 0.2  server/config.ts -- every tunable lives here; no magic numbers inline
//
// One file holds every limit and timeout the rest of the project reads. Two reasons this
// is worth a module of its own rather than constants scattered where they are used:
//
//   1. Most of these numbers are security controls, not preferences. They are the
//      slowloris and header-bomb defences, and a defence you cannot find is a defence you
//      cannot audit. Each one records the status code it maps to.
//   2. The tests need to shrink them. Proving that a 16 KB header cap works by actually
//      sending 16 KB is slow; proving it with a 64-byte cap is instant and tests the same
//      branch.

/** Environment shape, narrowed so this module needs no Node types and is trivial to test. */
export type Env = Record<string, string | undefined>

export interface Config {
  /** Port the TCP server binds. */
  port: number

  // -- Connection management (module 4) ------------------------------------------------

  /**
   * How long a connection may sit idle between requests before the server sends 408 and
   * closes. This is the slowloris control: an attacker's cheapest attack is opening many
   * connections and sending a byte every few seconds to hold them open forever. Without
   * an idle timeout, a few hundred sockets exhaust the server for the cost of almost no
   * bandwidth.
   */
  idleTimeoutMs: number

  /** Hard ceiling on concurrent connections. Past this, new sockets are closed immediately. */
  maxConnections: number

  /**
   * Requests served on one keep-alive connection before the server sends `Connection:
   * close`. Bounds how long any single client can monopolise a connection slot.
   */
  maxRequestsPerConnection: number

  // -- Request limits (module 2) -------------------------------------------------------

  /**
   * Longest request line accepted, in bytes -- method, target and version together.
   * Exceeding it is 414 URI Too Long. 8 KB matches nginx's `large_client_header_buffers`
   * default.
   */
  maxRequestLineBytes: number

  /** Maximum number of header fields. Exceeding it is 431 Request Header Fields Too Large. */
  maxHeaderCount: number

  /**
   * Maximum total bytes in the header section. Exceeding it is 431. This is the
   * header-bomb control: without it a client can stream header bytes forever and the
   * server buffers all of them, because the header section does not end until an empty
   * line arrives. 16 KB matches Node's own `--max-http-header-size` default.
   */
  maxHeaderBytes: number

  /** Maximum request body size. Exceeding it is 413 Content Too Large. */
  maxBodyBytes: number

  /**
   * Maximum size of a single chunk in a chunked body. A chunk header is hex and otherwise
   * unbounded, so a client could declare a 2 GB chunk; this rejects that as 400 before any
   * allocation happens.
   */
  maxChunkSizeBytes: number

  /**
   * Maximum length of one chunk-size line -- the hex size and any `;ext` after it.
   *
   * Distinct from `maxChunkSizeBytes`, which bounds the chunk's data. This one bounds the
   * line that announces it: a client can open a size line and never send its CRLF, and
   * without a cap the server buffers that forever. It is the header bomb again, in the
   * body. Exceeding it is 400.
   */
  maxChunkLineBytes: number

  // -- Metrics (module 7) --------------------------------------------------------------

  /** How many recent requests the ring buffer keeps for the dashboard's inspector panel. */
  recentRequestsBufferSize: number

  /** How often the SSE stream pushes a metrics snapshot. */
  metricsIntervalMs: number

  // -- Response (module 3) -------------------------------------------------------------

  /** Value sent in the `Server` response header. */
  serverName: string
}

export const defaults: Config = {
  port: 3000,

  idleTimeoutMs: 5_000,
  maxConnections: 512,
  maxRequestsPerConnection: 100,

  maxRequestLineBytes: 8_192,
  maxHeaderCount: 100,
  maxHeaderBytes: 16_384,
  maxBodyBytes: 1_048_576,
  maxChunkSizeBytes: 1_048_576,
  maxChunkLineBytes: 1_024,

  recentRequestsBufferSize: 50,
  metricsIntervalMs: 500,

  serverName: 'wirehttp',
}

/** Environment variable name for a given config key: `idleTimeoutMs` -> `WIREHTTP_IDLE_TIMEOUT_MS`. */
export function envNameFor(key: keyof Config): string {
  return 'WIREHTTP_' + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
}

/**
 * Reads a positive integer override.
 *
 * Throws rather than falling back on a bad value. A typo in an env var should stop the
 * server at boot with a readable message, not silently run with `NaN` as the header cap --
 * `bytes > NaN` is always false, so a mistyped limit would disable the control entirely
 * and nothing would look wrong until someone exploited it.
 */
function positiveInt(env: Env, key: keyof Config, fallback: number): number {
  const name = envNameFor(key)
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * Builds the configuration, applying environment overrides on top of the defaults.
 *
 * Takes `env` as a parameter so tests can pass a plain object instead of mutating
 * `process.env`, which leaks between tests when they run in the same process.
 */
export function loadConfig(env: Env = process.env, base: Config = defaults): Config {
  return {
    port: positiveInt(env, 'port', base.port),

    idleTimeoutMs: positiveInt(env, 'idleTimeoutMs', base.idleTimeoutMs),
    maxConnections: positiveInt(env, 'maxConnections', base.maxConnections),
    maxRequestsPerConnection: positiveInt(
      env,
      'maxRequestsPerConnection',
      base.maxRequestsPerConnection,
    ),

    maxRequestLineBytes: positiveInt(env, 'maxRequestLineBytes', base.maxRequestLineBytes),
    maxHeaderCount: positiveInt(env, 'maxHeaderCount', base.maxHeaderCount),
    maxHeaderBytes: positiveInt(env, 'maxHeaderBytes', base.maxHeaderBytes),
    maxBodyBytes: positiveInt(env, 'maxBodyBytes', base.maxBodyBytes),
    maxChunkSizeBytes: positiveInt(env, 'maxChunkSizeBytes', base.maxChunkSizeBytes),
    maxChunkLineBytes: positiveInt(env, 'maxChunkLineBytes', base.maxChunkLineBytes),

    recentRequestsBufferSize: positiveInt(
      env,
      'recentRequestsBufferSize',
      base.recentRequestsBufferSize,
    ),
    metricsIntervalMs: positiveInt(env, 'metricsIntervalMs', base.metricsIntervalMs),

    serverName: env[envNameFor('serverName')] ?? base.serverName,
  }
}

/** The configuration this process runs with. */
export const config: Config = loadConfig()
