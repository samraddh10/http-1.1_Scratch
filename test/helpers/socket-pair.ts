// module 5.2  test/helpers/socket-pair.ts -- a real connected socket, wrapped as module 1 wraps it
//
// The compat shims take a `Connection`, and `Connection` takes a `net.Socket`. An
// unconnected `new Socket()` would not do: `on-finished` and Express both read
// `socket.readable`/`socket.writable`, and on an unconnected socket those are false, which
// is the state that means "this request is already over". So the pair is really connected,
// over the loopback, and the client half is handed back so a test can make it vanish.

import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net'
import { once } from 'node:events'

import { Connection } from '../../server/tcp/connection.js'

export interface SocketPair {
  /** The server's side, as module 1 hands it to everything above. */
  readonly tcp: Connection
  /** The client's side. `client.destroy()` is a client that vanished mid-request. */
  readonly client: Socket
  close(): Promise<void>
}

export async function socketPair(): Promise<SocketPair> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const { port } = server.address() as AddressInfo
  const client = createConnection({ port, host: '127.0.0.1' })

  const [[accepted]] = await Promise.all([
    once(server, 'connection') as Promise<[Socket]>,
    once(client, 'connect'),
  ])

  const tcp = new Connection(accepted)

  return {
    tcp,
    client,
    async close(): Promise<void> {
      tcp.destroy('server-shutdown')
      client.destroy()
      server.close()
      await once(server, 'close')
    },
  }
}
