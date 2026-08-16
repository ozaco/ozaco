import { Broker, CoreErrors, DefaultGateway, defineAction, defineService } from 'server:core'
import { Daemon } from 'server:daemon'
import type { DaemonModule, DaemonRuntime } from 'server:daemon'
import { until } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunGatewayAdapter } from 'server:gateway/bun'
import { z } from 'zod'

import { bootstrap } from '../core/helpers'
import { runResult, runScoped } from '../helpers'

const makeModules = (): DaemonModule[] => [
  {
    name: 'alpha',
    service: defineService({
      name: 'alpha',
      actions: {
        hello: defineAction(
          { input: z.object({ name: z.string() }), route: { method: 'GET', path: '/hello' } },
          function* (body) {
            return { greeting: `hi ${body.name}` }
          },
        ),
        callBeta: defineAction(function* () {
          return yield* Broker.actions.call('beta', 'ping', undefined)
        }),
      },
    }),
  },
  {
    name: 'beta',
    service: defineService({
      name: 'beta',
      actions: {
        ping: defineAction({ route: { method: 'GET', path: '/ping' } }, function* () {
          return 'pong'
        }),
      },
    }),
  },
]

describe('daemon topology', () => {
  it('monolith: registers + mounts everything and serves HTTP', async () => {
    const result = await runScoped(function* () {
      yield* bootstrap()
      yield* install(Daemon, {
        env: {},
        modules: makeModules(),
        *base() {
          yield* install(BunGatewayAdapter)
          yield* install(DefaultGateway)
        },
      })

      const info = yield* Daemon.actions.start()

      const res = yield* until(fetch(`${info.gateway?.url}/alpha/hello?name=oz`))
      const body = (yield* until(res.json())) as { greeting: string }
      const cross = yield* Broker.actions.call('alpha', 'callBeta', undefined)

      return { info, body, cross }
    })

    expect(result.info.runtime.kind).toBe('monolith')
    expect(result.info.owned).toEqual(['alpha', 'beta'])
    expect(result.info.mounted).toEqual(['alpha', 'beta'])
    expect(result.body.greeting).toBe('hi oz')
    expect(result.cross).toBe('pong')
  })

  it('service role: owns only its module, no edge', async () => {
    const result = await runScoped(function* () {
      yield* bootstrap()
      yield* install(Daemon, { env: { SERVICE: 'beta' }, modules: makeModules() })

      const info = yield* Daemon.actions.start()
      const services = yield* Broker.actions.getServices()

      return { info, services }
    })

    expect(result.info.runtime.kind).toBe('service')
    expect(result.info.owned).toEqual(['beta'])
    expect(result.info.mounted).toEqual([])
    expect(result.info.gateway).toBeUndefined()
    expect(result.services).toEqual(['beta'])
  })

  it('gateway role: mounts everything, owns nothing — unreached backends 503', async () => {
    const result = await runScoped(function* () {
      yield* bootstrap()
      yield* install(Daemon, {
        env: { SERVICE: 'gateway' },
        modules: makeModules(),
        *base() {
          yield* install(BunGatewayAdapter)
          yield* install(DefaultGateway)
        },
      })

      const info = yield* Daemon.actions.start()
      const res = yield* until(fetch(`${info.gateway?.url}/beta/ping`))
      const body = (yield* until(res.json())) as { error: string; requestId: string }
      const services = yield* Broker.actions.getServices()

      return { info, status: res.status, body, services }
    })

    expect(result.info.owned).toEqual([])
    expect(result.info.mounted).toEqual(['alpha', 'beta'])
    expect(result.services).toEqual([])
    expect(result.status).toBe(503)
    expect(result.body.error).toBe(CoreErrors.Unavailable)
    expect(result.body.requestId).toMatch(/^r_/u)
  })

  it('when() gates modules; module setup runs on owners only', async () => {
    const result = await runScoped(function* () {
      let setups = 0
      const modules: DaemonModule[] = [
        ...makeModules().map(module => {
          if (module.name !== 'alpha') {
            return module
          }

          const wrapped: DaemonModule = {
            name: module.name,
            service: module.service,
            *setup() {
              setups += 1
            },
          }

          return wrapped
        }),
        {
          name: 'flagged',
          service: defineService({
            name: 'flagged',
            actions: {
              noop: defineAction(function* () {}),
            },
          }),
          when: (runtime: DaemonRuntime) => runtime.env['FLAG'] === '1',
        },
      ]

      yield* bootstrap()
      yield* install(Daemon, { env: {}, modules })

      const info = yield* Daemon.actions.start()

      return { info, setups }
    })

    expect(result.info.owned).toEqual(['alpha', 'beta'])
    expect(result.setups).toBe(1)
  })

  it('unknown SERVICE fails with the known module list', async () => {
    const failure = await runResult(function* () {
      yield* bootstrap()
      yield* install(Daemon, { env: { SERVICE: 'ghost' }, modules: makeModules() })
      yield* Daemon.actions.start()
    })

    expect(isFailure(failure)).toBe(true)
    if (isFailure(failure)) {
      expect(failure.error).toBe(CoreErrors.Configuration)
      expect(failure.message).toContain('alpha, beta')
    }
  })
})
