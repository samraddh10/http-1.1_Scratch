// module 6.1/7.3  app/routes.ts -- the demo routes, the metrics snapshot and the SSE stream
import { Router } from 'express'

import { config } from '../server/config.js'
import type { MetricsSnapshot } from '../server/metrics/registry.js'

export interface RouteOptions {
  /** Reads the current metrics. Called per request, so a snapshot is never stale. */
  readonly snapshot: () => MetricsSnapshot
  /** How often the stream pushes. Injected so a test need not wait out real half-seconds. */
  readonly intervalMs?: number
}

//Purpose: builds and returns an Express Router with the demo handlers and the two metrics
// endpoints, so app/server.ts can mount it onto an Express app sitting on the TCP/HTTP layers.
export function createRoutes(options: RouteOptions): Router {
  const routes = Router()
  const { snapshot } = options
  const intervalMs = options.intervalMs ?? config.metricsIntervalMs

  routes.get('/', (_request, response) => {
    response.type('text/plain').send('wirehttp: an HTTP/1.1 server on raw TCP sockets\n')
  })

  routes.get('/echo/:id', (request, response) => {
    response.json({
      id: request.params.id,
      query: request.query,
    })
  })

  routes.post('/echo', (request, response) => {
    response.json({
      body: request.body,
      contentType: request.get('content-type') ?? null,
    })
  })

  routes.get('/boom', () => {
    throw new Error('boom: this route throws on purpose')
  })

  routes.get('/api/metrics', (_request, response) => {
    response.json(snapshot())
  })

  
  routes.get('/api/metrics/stream', (_request, response) => {
    response.set({
      'Content-Type': 'text/event-stream',
      // A proxy that buffered or compressed this would turn a live stream into one long
      // silence, and the dashboard would look broken rather than slow.
      'Cache-Control': 'no-cache, no-transform',
    })
    // Sent before the first tick, so the browser's EventSource opens now rather than in
    // half a second.
    response.flushHeaders()

    const push = (): void => {
      response.write(`data: ${JSON.stringify(snapshot())}\n\n`)
    }

    push()
    const timer = setInterval(push, intervalMs)
    // A metrics tick is never a reason to keep the process alive; the listening socket is.
    timer.unref()

    // Without this the interval outlives the viewer: one timer per tab ever opened, each
    // writing into a socket that is gone.
    response.on('close', () => clearInterval(timer))
  })

  return routes
}
