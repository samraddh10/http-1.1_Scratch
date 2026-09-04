// module 6.1  app/routes.ts -- the demo routes
import { Router } from 'express'

//Purpose: builds and returns an Express Router with three handlers, so app/routes.ts can be mounted onto an Express app instance that itself sits on top of your TCP/HTTP layers.
export function createRoutes(): Router {
  const routes = Router()

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

  return routes
}
