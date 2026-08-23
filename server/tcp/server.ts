//createServer — a function from Node's built-in net module used to create a TCP server.
//AddressInfo — a type describing a bound network address (contains fields like address, port, family
//Socket — a type representing one client connection. Also imported as a type only.
import { createServer, type AddressInfo, type Socket } from 'node:net'

import { config } from '../config.js'

//it must accept a Socket and return nothing (void). This type is used to describe what a valid connection handler looks like.
export type ConnectionHandler = (socket: Socket) => void

//Defines the shape of an options object that can be passed when creating the server
//It has one optional field, onConnection, which — if provided — must match the ConnectionHandler type above.
export interface TcpServerOptions {
  onConnection?: ConnectionHandler
}

export interface TcpServer {
  listen(port?: number, host?: string): Promise<AddressInfo>
  close(): Promise<void>
  //returns the current bound address, or null if not listening.
  address(): AddressInfo | null
  readonly connectionCount: number
  readonly listening: boolean
}
//This is the default connection handler. It runs once per connected client. Every time that client sends data, 
// this function writes back a message reporting how many bytes were in that specific chunk, and the running total of bytes received from that client so far.
export function echoByteCounts(socket: Socket): void {
  let total = 0
  socket.on('data', (chunk: Buffer) => {
    total += chunk.length
    socket.write(`${chunk.length}/${total}\n`)
  })
}

//This is the main function of the file. It builds and returns a TcpServer object — a working TCP server with connection tracking, 
// a safe listen()/close() API, and a pluggable handler for what happens on each new connection.
export function createTcpServer(options: TcpServerOptions = {}): TcpServer {
  //Decides which handler to use for new connections.
  const onConnection = options.onConnection ?? echoByteCounts
  const sockets = new Set<Socket>()
  //This creates the actual underlying Node TCP server.
  const server = createServer(
    {
      noDelay: true,
    },
    (socket) => {
      sockets.add(socket)
      socket.once('close', () => {
        sockets.delete(socket)
      })
      socket.on('error', () => {
        socket.destroy()
      })

      onConnection(socket)
    },
  )

  //Purpose: a small helper that safely retrieves the server's current address, and throws an error if something unexpected happens.
  function addressOrThrow(): AddressInfo {
    const bound = server.address()
    if (bound === null || typeof bound === 'string') {
      // A string address means a pipe or Unix socket, which this server never binds.
      throw new Error('wirehttp: expected a TCP address after listen()')
    }
    return bound
  }

  //Declares a variable to cache the "closing" promise, initially not set. This will be used to make sure the shutdown logic only ever runs once, even if close() gets called multiple times.
  let closing: Promise<void> | undefined

  //Purpose: performs the actual work of stopping the server and disconnecting all clients.
  async function shutDown(): Promise<void> {
    if (!server.listening) {
      for (const socket of sockets) socket.destroy()
      return
    }

    const closed = new Promise<void>((resolve) => {
      server.once('close', () => resolve())
    })

    server.close()
    for (const socket of sockets) {
      socket.destroy()
      sockets.delete(socket)
    }

    await closed
  }

  return {
    address: () => (server.listening ? addressOrThrow() : null),
    get connectionCount() {
      return sockets.size
    },
    get listening() {
      return server.listening
    },

    async listen(port = config.port, host = '127.0.0.1'): Promise<AddressInfo> {
      if (server.listening) {
        throw new Error('wirehttp: listen() called on a server that is already listening')
      }

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })

      closing = undefined

      return addressOrThrow()
    },

    close(): Promise<void> {
      closing ??= shutDown()
      return closing
    },
  }
}
