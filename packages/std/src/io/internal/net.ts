import type { Queue, Flow } from 'std:effect'
import {
  action,
  attempt,
  call,
  createQueue,
  ensure,
  mapError,
  operation,
  until,
  useScope,
} from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail } from 'std:result'

import { createSocket } from 'node:dgram'
import type { Socket } from 'node:net'
import { connect, createServer } from 'node:net'

import type {
  FlowClose,
  TcpConnectOptions,
  TcpHandler,
  TcpListenOptions,
  TcpSocket,
  UdpBindOptions,
  UdpDatagram,
} from '../types/common'

import { errorMessage, toBytes } from './process'

const queueFlow = <T, TClose>(queue: Queue<T, TClose>): Flow<T, TClose> => ({
  *[Symbol.iterator]() {
    return queue
  },
})

const nodeWrite = operation(function* (socket: Socket, chunk: Uint8Array | string) {
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
    failure =>
      fail(
        'tcp-write-failed',
        errorMessage(failure.error),
        ...failure.causes,
      ) as Result.Failure<unknown>,
  )
})

const nodeClose = operation(function* (socket: Socket) {
  yield* attempt(
    until(
      new Promise<void>(resolve => {
        socket.end(() => {
          resolve()
        })
      }),
    ),
  )
})

const makeHandle = (socket: Socket): TcpSocket => {
  // Attach the reader EAGERLY (at accept/connect time) and buffer into a queue, so bytes are captured
  // even when the handler does async work (e.g. connecting an upstream) before consuming `data`. A
  // lazy subscribe would drop the first bytes under Bun's node:net (it does not buffer a paused
  // accepted socket the way Node does). Trade-off: no native backpressure — a slow consumer buffers.
  const queue = createQueue<Uint8Array, FlowClose>()
  let settled = false
  const settle = (close: FlowClose) => {
    if (!settled) {
      settled = true
      queue.close(close)
    }
  }
  socket.on('data', (chunk: Buffer) => queue.add(new Uint8Array(chunk)))
  socket.on('end', () => settle(true))
  socket.on('close', () => settle(true))
  socket.on('error', error => settle(asFailure(error)))

  return {
    remoteAddress: socket.remoteAddress ?? '',
    remotePort: socket.remotePort ?? 0,
    localPort: socket.localPort ?? 0,
    data: queueFlow(queue),
    write: chunk => nodeWrite(socket, chunk),
    close: () => nodeClose(socket),
  }
}

export const tcpListen = operation(function* (options: TcpListenOptions, onConnection: TcpHandler) {
  const scope = yield* useScope()

  const server = createServer(socket => {
    const handle = makeHandle(socket)
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
        'tcp-listen-failed',
        errorMessage(failure.error),
        ...failure.causes,
      ) as Result.Failure<unknown>,
  )

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port

  // Close at most once: `close()` and the scope-teardown `ensure` share this guard (node's
  // server.close() throws ERR_SERVER_NOT_RUNNING on a server that is already closing).
  let closed = false
  const close = operation(function* () {
    if (closed) {
      return
    }
    closed = true
    yield* attempt(
      call(() => {
        server.close()
      }),
    )
  })

  yield* ensure(() => close())

  return { port, hostname: options.hostname ?? '0.0.0.0', close }
})

export const tcpConnect = operation(function* (options: TcpConnectOptions) {
  const socket = connect({ port: options.port, host: options.hostname ?? '127.0.0.1' })

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
        'tcp-connect-failed',
        errorMessage(failure.error),
        ...failure.causes,
      ) as Result.Failure<unknown>
    },
  )

  yield* ensure(() => {
    socket.destroy()
  })

  return makeHandle(socket)
})

export const udpBind = operation(function* (options?: UdpBindOptions) {
  const queue = createQueue<UdpDatagram, FlowClose>()
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
      return fail(
        'udp-bind-failed',
        errorMessage(failure.error),
        ...failure.causes,
      ) as Result.Failure<unknown>
    },
  )

  // runtime errors after bind close the message stream instead of crashing the process
  socket.on('error', error => {
    queue.close(asFailure(error))
  })

  // Close at most once: `close()` and the scope-teardown `ensure` share this guard, otherwise the
  // second `socket.close()` throws in node:dgram (closing an already-closed handle).
  let closed = false
  const close = operation(function* () {
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
  })

  yield* ensure(() => close())

  const send = operation(function* (data: Uint8Array | string, port: number, address: string) {
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
          'udp-send-failed',
          errorMessage(failure.error),
          ...failure.causes,
        ) as Result.Failure<unknown>,
    )
  })

  return { port: socket.address().port, messages: queueFlow(queue), send, close }
})
