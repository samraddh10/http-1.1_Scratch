// module 5  server/index.ts -- public entry: createServer + exported types
//
// The whole surface of this project as anything outside it sees it. `app/server.ts` swaps
// one import line between `node:http` and this file, and nothing else in the application
// changes -- which is the claim the project exists to make, so the export list is kept to
// what that claim needs.

export { createServer } from './compat/create-server.js'
export type {
  CreateServerOptions,
  RequestListener,
  WireServer,
} from './compat/create-server.js'

export { ServerRequest } from './compat/server-request.js'
export { ServerResponse } from './compat/server-response.js'

export type { Config } from './config.js'
export { config, defaults, loadConfig } from './config.js'
