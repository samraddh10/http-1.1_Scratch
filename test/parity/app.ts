// module 9.3  test/parity/app.ts -- one Express app, written once, mounted on both servers
//
// Nothing here knows which server it is running on, and that is the whole point: the file is
// an ordinary Express app of the kind the supported-surface contract in DECISIONS.md promises
// to run. Every route exists to reach a different part of that contract -- route params,
// express.json(), express.urlencoded(), express.static(), res.sendFile(), res.redirect(),
// res.json(), req.get(), next(), and an error handler -- so that a parity failure points at
// one member rather than at "Express".

import express, { type ErrorRequestHandler, type Express } from 'express'

export interface ParityAppOptions {
  /** Directory handed to `express.static()` and `res.sendFile()`. */
  readonly staticDir: string
}

export function createParityApp({ staticDir }: ParityAppOptions): Express {
  const app = express()

  // Fixed rather than left to Express's default, which is the process start time and would
  // differ between the two servers for reasons that have nothing to do with the protocol.
  app.set('etag', 'strong')

  app.use('/assets', express.static(staticDir))
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))

  app.get('/', (_request, response) => {
    response.type('text/plain').send('wirehttp parity root\n')
  })

  app.get('/echo/:id', (request, response) => {
    response.json({
      id: request.params.id,
      query: request.query,
      seenHost: request.get('host') !== undefined,
    })
  })

  app.post('/echo', (request, response) => {
    response.status(201).json({ received: request.body })
  })

  app.post('/form', (request, response) => {
    response.json({ form: request.body })
  })

  app.get('/headers', (request, response) => {
    response
      .set('X-Echoed', request.get('X-Custom') ?? 'absent')
      .type('application/json')
      .send(JSON.stringify({ custom: request.get('X-Custom') ?? null }))
  })

  app.get('/redirect', (_request, response) => {
    response.redirect('/')
  })

  app.get('/status/204', (_request, response) => {
    response.status(204).end()
  })

  // Two handlers on one route: the first defers, which is the `next()` half of the contract.
  app.get(
    '/next',
    (_request, _response, next) => next(),
    (_request, response) => response.type('text/plain').send('reached the second handler\n'),
  )

  app.get('/file', (_request, response) => {
    response.sendFile('hello.txt', { root: staticDir })
  })

  app.get('/boom', () => {
    throw new Error('parity: deliberate failure')
  })

  const reportError: ErrorRequestHandler = (error, _request, response, next) => {
    if (response.headersSent) return next(error)
    // `err.status` is what body-parser sets when JSON fails to parse, and honouring it is
    // what makes a bad body a 400 on both servers rather than a 500 on both.
    const status = (error as { status?: number }).status ?? 500
    response.status(status).type('text/plain').send(`handled: ${status}\n`)
  }
  app.use(reportError)

  return app
}
