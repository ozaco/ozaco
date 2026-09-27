import type { Flow, Queue } from 'std:effect'
import {
  action,
  attempt,
  call,
  createQueue,
  ensure,
  mapError,
  until,
  useScope,
  withResolvers,
} from 'std:effect'
import { asFailure, fail } from 'std:result'

import { createSocket } from 'node:dgram'
import type { Socket } from 'node:net'
import { connect, createServer } from 'node:net'

import { IOErrors } from '../../errors'
import type { IODef } from '../../types/io'
import { toBytes } from '../process/shared'

const queueFlow = <T, TClose>(queue: Queue<T, TClose>): Flow<T, TClose> => ({
  *[Symbol.iterator]() {
    return queue
  },
})

function* nodeWrite(socket: Socket, chunk: Uint8Array | string) {
  yield* mapError(
    until(
      new Promise<void>((resolve, reject) => {
        socket.write(toBytes(chunk), error => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      }),
    ),
    failure => fail(IOErrors.TcpWriteFailed, 'tcp write failed', asFailure(failure, IOErrors)),
  )
}

// Half-close: send FIN once every queued write is flushed. The read side stays open — the socket
// fully closes when the peer ends too (or on `close()`).
function* nodeEnd(socket: Socket) {
  if (socket.writableEnded || socket.destroyed) {
    return
  }
  yield* attempt(
    until(
      new Promise<void>(resolve => {
        socket.end(() => {
          resolve()
        })
      }),
    ),
  )
}

// Tear-down: flush and FIN (as `end`), then release the socket whatever the peer does.
function* nodeClose(socket: Socket) {
  yield* nodeEnd(socket)
  socket.destroy()
}

const makeHandle = (socket: Socket): IODef.TcpSocket => {
  // Attach the reader EAGERLY (at accept/connect time) and buffer into a queue, so bytes are captured
  // even when the handler does async work (e.g. connecting an upstream) before consuming `data`. A
  // lazy subscribe would drop the first bytes under Bun's node:net (it does not buffer a paused
  // accepted socket the way Node does). Trade-off: no native backpressure — a slow consumer buffers.
  //
  // The socket is half-open (`allowHalfOpen`): the peer's FIN (`'end'`) ends only `data` — the write
  // side stays usable until `end()` / `close()` — while `closed` settles when the socket is gone.
  const queue = createQueue<Uint8Array, IODef.FlowClose>()
  let settled = false
  const settle = (close: IODef.FlowClose) => {
    if (!settled) {
      settled = true
      queue.close(close)
    }
  }
  const closed = withResolvers<IODef.FlowClose>()
  let failure: IODef.FlowClose = true
  socket.on('data', (chunk: Buffer) => queue.add(new Uint8Array(chunk)))
  socket.on('end', () => settle(true))
  socket.on('error', error => {
    failure = asFailure(error, IOErrors)
    settle(failure)
  })
  socket.on('close', () => {
    settle(true)
    closed.resolve(failure)
  })

  return {
    remoteAddress: socket.remoteAddress ?? '',
    remotePort: socket.remotePort ?? 0,
    localPort: socket.localPort ?? 0,
    data: queueFlow(queue),
    write: chunk => nodeWrite(socket, chunk),
    end: () => nodeEnd(socket),
    close: () => nodeClose(socket),
    closed: closed.operation,
  }
}

export function* tcpListen(options: IODef.TcpListenOptions, onConnection: IODef.TcpHandler) {
  const scope = yield* useScope()

  const server = createServer({ allowHalfOpen: true }, socket => {
    const handle = makeHandle(socket)
    // the task's promise side resolves a Result and never rejects (a halt at listen-scope
    // teardown included), so `finally` is the whole story: the socket goes with the handler
    void scope
      .run(() => onConnection(handle))
      .finally(() => {
        socket.destroy()
      })
  })

  yield* mapError(
    action<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(
        {
          port: options.port,
          host: options.hostname ?? '0.0.0.0',
          ...(options.reusePort === undefined ? {} : { reusePort: options.reusePort }),
        },
        () => {
          server.off('error', reject)
          resolve()
        },
      )
      return () => {}
    }),
    failure =>
      fail(
        IOErrors.TcpListenFailed,
        `tcp listen on ${options.hostname ?? '0.0.0.0'}:${options.port} failed`,
        asFailure(failure, IOErrors),
      ),
  )

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port

  // Close at most once: `close()` and the scope-teardown `ensure` share this guard (node's
  // server.close() throws ERR_SERVER_NOT_RUNNING on a server that is already closing).
  let closed = false
  const close = function* () {
    if (closed) {
      return
    }
    closed = true
    yield* attempt(
      call(() => {
        server.close()
      }),
    )
  }

  yield* ensure(() => close())

  return { port, hostname: options.hostname ?? '0.0.0.0', close }
}

export function* tcpConnect(options: IODef.TcpConnectOptions) {
  const socket = connect({
    port: options.port,
    host: options.hostname ?? '127.0.0.1',
    allowHalfOpen: true,
  })

  yield* mapError(
    action<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.once('connect', () => {
        socket.off('error', reject)
        resolve()
      })
      return () => {}
    }),
    failure => {
      socket.destroy()
      return fail(
        IOErrors.TcpConnectFailed,
        `tcp connect to ${options.hostname ?? '127.0.0.1'}:${options.port} failed`,
        asFailure(failure, IOErrors),
      )
    },
  )

  yield* ensure(() => {
    socket.destroy()
  })

  return makeHandle(socket)
}

export function* udpBind(options?: IODef.UdpBindOptions) {
  const queue = createQueue<IODef.UdpDatagram, IODef.FlowClose>()
  const socket = createSocket('udp4')

  socket.on('message', (msg, rinfo) => {
    queue.add({ data: new Uint8Array(msg), address: rinfo.address, port: rinfo.port })
  })

  yield* mapError(
    action<void>((resolve, reject) => {
      const onError = (error: unknown) => reject(error)
      socket.once('error', onError)
      socket.bind(options?.port, options?.hostname, () => {
        socket.off('error', onError)
        resolve()
      })
      return () => socket.off('error', onError)
    }),
    failure => {
      socket.close()
      return fail(IOErrors.UdpBindFailed, 'udp bind failed', asFailure(failure, IOErrors))
    },
  )

  // runtime errors after bind close the message stream instead of crashing the process
  socket.on('error', error => {
    queue.close(asFailure(error, IOErrors))
  })

  // Close at most once: `close()` and the scope-teardown `ensure` share this guard, otherwise the
  // second `socket.close()` throws in node:dgram (closing an already-closed handle).
  let closed = false
  const close = function* () {
    if (closed) {
      return
    }
    closed = true
    yield* attempt(
      until(
        new Promise<void>(resolve => {
          socket.close(() => {
            resolve()
          })
        }),
      ),
    )
    queue.close(true)
  }

  yield* ensure(() => close())

  const send = function* (data: Uint8Array | string, port: number, address: string) {
    yield* mapError(
      until(
        new Promise<void>((resolve, reject) => {
          socket.send(toBytes(data), port, address, error => {
            if (error) {
              reject(error)
            } else {
              resolve()
            }
          })
        }),
      ),
      failure =>
        fail(
          IOErrors.UdpSendFailed,
          `udp send to ${address}:${port} failed`,
          asFailure(failure, IOErrors),
        ),
    )
  }

  return { port: socket.address().port, messages: queueFlow(queue), send, close }
}
