// module 6.1  app/server.ts -- THE ONE IMPORT LINE
//
// Below the imports this is an ordinary Express program. Comment out the wirehttp line,
// uncomment the `node:http` line, and the same app serves the same responses on Node's own
// server. That one-line swap is the claim the whole project exists to make, so it is kept
// literally to one line: nothing else here is conditional on which server is mounted.

import { fileURLToPath } from 'node:url'

import express from 'express'
import type { ErrorRequestHandler } from 'express'

// import { createServer } from 'node:http'
import { createServer } from '../server/index.js'

import { config } from '../server/config.js'
import { createRoutes } from './routes.js'

// Resolved from this file rather than the working directory, so the server serves the same
// directory however it was started. Empty until `npm run build:frontend` fills it.
const publicDir = fileURLToPath(new URL('../public', import.meta.url))

// Four arguments is how Express recognises an error handler, and it has to be registered
// after everything that might fail.
const reportError: ErrorRequestHandler = (error, _request, response, next) => {
  console.error('wirehttp: unhandled error in the Express app --', error)

  // Once the head is on the wire the status cannot be changed and a second body would be
  // framed as part of the first. Handing back to finalhandler is the only correct move
  // left: it destroys the socket, which is how a truncated response is signalled.
  if (response.headersSent) return next(error)

  // The message is logged, not sent. It is the one place an internal detail would leak to
  // a client for no benefit.
  response.status(500).type('text/plain').send('internal server error\n')
}

const app = express()

// Static first: an asset request should not run the body parser or the router. Serving
// `public/` at the root is also what puts the phase 8 dashboard on `/`; until that build
// exists the directory is empty, every request falls through, and the router answers.
app.use(express.static(publicDir))
app.use(express.json())
app.use(createRoutes())
app.use(reportError)

// Express's handler type demands the whole of `http.IncomingMessage` and
// `http.ServerResponse`. wirehttp implements the subset in DECISIONS.md -- every member
// Express and its five request/response-touching dependencies actually reach for, and
// deliberately nothing else. The compiler cannot see that the subset is sufficient, so
// mounting costs one cast, written so that it suits either `createServer` above.
const server = createServer(app as never)

server.listen(config.port, () => {
  console.log(`wirehttp listening on http://localhost:${config.port}`)
})
