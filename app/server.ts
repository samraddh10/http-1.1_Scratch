//6.1
import express from 'express'

import { createServer } from '../server/index.js'

import { config } from '../server/config.js'
import { createRoutes } from './routes.js'

const app = express()

app.use(express.json())
app.use(createRoutes())


const server = createServer(app as never)

server.listen(config.port, () => {
  console.log(`wirehttp listening on http://localhost:${config.port}`)
})
