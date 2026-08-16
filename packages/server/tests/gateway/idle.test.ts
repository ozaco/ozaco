import { DefaultGateway, Gateway } from 'server:core'
import { until } from 'std:effect'
import { install } from 'std:plugin'

import { describe, expect, it } from 'bun:test'

import { BunGatewayAdapter } from 'server:gateway/bun'

import { bootstrap } from '../core/helpers'
import { runScoped } from '../helpers'

interface SocketProbe {
  readonly closed: Promise<{ code: number; reason: string }>
  send(data: string): void
  close(): void
}

const openProbe = (url: string, onMessage?: (data: string) => void): Promise<SocketProbe> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const closedControl = Promise.withResolvers<{ code: number; reason: string }>()

    socket.addEventListener('close', event => {
      closedControl.resolve({ code: event.code, reason: event.reason })
    })

    socket.addEventListener('open', () => {
      resolve({
        closed: closedControl.promise,
        send: data => {
          socket.send(data)
        },
        close: () => {
          socket.close()
        },
      })
    })
    socket.addEventListener('error', () => {
      reject(new Error('probe failed to connect'))
    })

    if (onMessage) {
      socket.addEventListener('message', event => {
        onMessage(String(event.data))
      })
    }
  })

const bootIdleGateway = function* (idle: { ttlMs: number; pingMs: number }) {
  yield* bootstrap()
  yield* install(BunGatewayAdapter)
  yield* install(DefaultGateway, { name: 'gw', idle })
  yield* Gateway.actions.socket('/live', {
    *message(socket, data) {
      socket.send(`echo:${String(data)}`)
    },
  })

  return yield* Gateway.actions.start({ port: 0 })
}

describe('gateway idle lease (dead-socket reaping)', () => {
  it('reaps a silent socket with 4000 "idle timeout" when pings are disabled', async () => {
    const result = await runScoped(function* () {
      const info = yield* bootIdleGateway({ ttlMs: 120, pingMs: 0 })
      const probe = yield* until(openProbe(`ws://127.0.0.1:${info.port}/live`))
      const closed = yield* until(probe.closed)

      return closed
    })

    expect(result.code).toBe(4000)
    expect(result.reason).toBe('idle timeout')
  })

  it('inbound frames renew the lease — an active socket survives many TTLs', async () => {
    const result = await runScoped(function* () {
      const info = yield* bootIdleGateway({ ttlMs: 120, pingMs: 0 })

      const outcome = yield* until(
        (async () => {
          const probe = await openProbe(`ws://127.0.0.1:${info.port}/live`)
          const race = await Promise.race([
            probe.closed.then(closed => ({ kind: 'closed' as const, closed })),
            (async () => {
              // keep talking across ~4 TTLs — the delays are intentionally sequential
              for (let i = 0; i < 12; i += 1) {
                probe.send(`tick-${i}`)
                // oxlint-disable-next-line no-await-in-loop
                await new Promise(resolve => {
                  setTimeout(resolve, 40)
                })
              }

              return { kind: 'alive' as const }
            })(),
          ])

          probe.close()

          return race
        })(),
      )

      return outcome
    })

    expect(result.kind).toBe('alive')
  })

  it('protocol pings keep a silent-but-alive client open (auto-pong renews)', async () => {
    const result = await runScoped(function* () {
      const info = yield* bootIdleGateway({ ttlMs: 150, pingMs: 40 })

      const outcome = yield* until(
        (async () => {
          const probe = await openProbe(`ws://127.0.0.1:${info.port}/live`)

          // send NOTHING — only the protocol-level auto-pong keeps the lease alive
          const race = await Promise.race([
            probe.closed.then(closed => ({ kind: 'closed' as const, closed })),
            new Promise<{ kind: 'alive' }>(resolve => {
              setTimeout(() => {
                resolve({ kind: 'alive' })
              }, 600)
            }),
          ])

          probe.close()

          return race
        })(),
      )

      return outcome
    })

    expect(result.kind).toBe('alive')
  })

  it('reaping cascades: the socket route close handler runs for reaped sockets', async () => {
    const result = await runScoped(function* () {
      yield* bootstrap()
      yield* install(BunGatewayAdapter)
      yield* install(DefaultGateway, { name: 'gw', idle: { ttlMs: 100, pingMs: 0 } })

      const closes: { code: number; reason: string }[] = []

      yield* Gateway.actions.socket('/tracked', {
        *message() {},
        *close(_socket, code, reason) {
          closes.push({ code, reason })
        },
      })

      const info = yield* Gateway.actions.start({ port: 0 })
      const probe = yield* until(openProbe(`ws://127.0.0.1:${info.port}/tracked`))

      yield* until(probe.closed)
      // give the close handler a tick to run
      yield* until(
        new Promise(resolve => {
          setTimeout(resolve, 30)
        }),
      )

      return closes
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.code).toBe(4000)
  })
})
