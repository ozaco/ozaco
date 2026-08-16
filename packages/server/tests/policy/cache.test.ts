import { Broker, defineAction, defineService } from 'server:core'
import { sleep } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { CachePolicy } from 'server:policy/cache'

import { bootstrap } from '../core/helpers'
import { runScoped } from '../helpers'

const fixture = (counter: { runs: number }) =>
  defineService({
    name: 'cached-svc',
    actions: {
      get: defineAction(function* (params: { id: string }) {
        counter.runs += 1

        return `${params.id}:${counter.runs}`
      }),
    },
  })

describe('policy: cache', () => {
  it('serves repeated dispatches from cache and misses on different params', async () => {
    const result = await runScoped(function* () {
      const counter = { runs: 0 }
      const service = fixture(counter)

      yield* bootstrap()
      yield* install(CachePolicy, { global: true })
      yield* Broker.actions.register(service)

      const first = yield* Broker.actions.call(service, 'get', { id: 'a' })
      const second = yield* Broker.actions.call(service, 'get', { id: 'a' })
      const other = yield* Broker.actions.call(service, 'get', { id: 'b' })

      return { first, second, other, runs: counter.runs }
    })

    expect(result.first).toBe('a:1')
    expect(result.second).toBe('a:1')
    expect(result.other).toBe('b:2')
    expect(result.runs).toBe(2)
  })

  it('expires entries after ttlMs', async () => {
    const result = await runScoped(function* () {
      const counter = { runs: 0 }
      const service = fixture(counter)

      yield* bootstrap()
      yield* install(CachePolicy, { global: true, ttlMs: 25 })
      yield* Broker.actions.register(service)

      yield* Broker.actions.call(service, 'get', { id: 'a' })
      yield* Broker.actions.call(service, 'get', { id: 'a' })
      yield* sleep(50)

      const revived = yield* Broker.actions.call(service, 'get', { id: 'a' })

      return { revived, runs: counter.runs }
    })

    expect(result.revived).toBe('a:2')
    expect(result.runs).toBe(2)
  })

  it('per-action override tunes ttlMs while other actions keep the default', async () => {
    const result = await runScoped(function* () {
      const counter = { runs: 0 }
      const service = defineService({
        name: 'tuned-svc',
        actions: {
          tuned: defineAction({ policies: { cache: { ttlMs: 25 } } }, function* () {
            counter.runs += 1

            return counter.runs
          }),
          steady: defineAction(function* () {
            counter.runs += 1

            return counter.runs
          }),
        },
      })

      yield* bootstrap()
      yield* install(CachePolicy, { global: true, ttlMs: 60_000 })
      yield* Broker.actions.register(service)

      yield* Broker.actions.call(service, 'tuned', undefined)
      yield* Broker.actions.call(service, 'steady', undefined)
      yield* sleep(50)
      yield* Broker.actions.call(service, 'tuned', undefined)
      yield* Broker.actions.call(service, 'steady', undefined)

      return counter.runs
    })

    // tuned expired (2 runs), steady stayed cached (1 run)
    expect(result).toBe(3)
  })

  it('varies entries per principal via meta.authorization', async () => {
    const result = await runScoped(function* () {
      const counter = { runs: 0 }
      const service = fixture(counter)

      yield* bootstrap()
      yield* install(CachePolicy, { global: true })
      yield* Broker.actions.register(service)

      const alice = { meta: { authorization: 'alice' } }
      const bob = { meta: { authorization: 'bob' } }

      yield* Broker.actions.call(service, 'get', { id: 'a' }, alice)
      yield* Broker.actions.call(service, 'get', { id: 'a' }, bob)
      yield* Broker.actions.call(service, 'get', { id: 'a' }, alice)

      return counter.runs
    })

    expect(result).toBe(2)
  })

  it('is OPT-IN without global: undeclared actions are never cached (frozen-requestId regression)', async () => {
    const result = await runScoped(function* () {
      const counter = { runs: 0 }
      const service = defineService({
        name: 'optin-svc',
        actions: {
          plain: defineAction(function* () {
            counter.runs += 1

            return counter.runs
          }),
          declared: defineAction({ policies: { cache: { ttlMs: 60_000 } } }, function* () {
            counter.runs += 1

            return counter.runs
          }),
        },
      })

      yield* bootstrap()
      yield* install(CachePolicy, {})
      yield* Broker.actions.register(service)

      const plainFirst = yield* Broker.actions.call(service, 'plain', undefined)
      const plainSecond = yield* Broker.actions.call(service, 'plain', undefined)
      const declaredFirst = yield* Broker.actions.call(service, 'declared', undefined)
      const declaredSecond = yield* Broker.actions.call(service, 'declared', undefined)

      return { plainFirst, plainSecond, declaredFirst, declaredSecond }
    })

    // every undeclared dispatch runs the handler — per-request values stay fresh
    expect(result.plainFirst).toBe(1)
    expect(result.plainSecond).toBe(2)
    // the declared action still opts in and serves the second dispatch from cache
    expect(result.declaredFirst).toBe(3)
    expect(result.declaredSecond).toBe(3)
  })

  it('never caches failure replies', async () => {
    const result = await runScoped(function* () {
      const counter = { runs: 0 }
      const service = defineService({
        name: 'failing-svc',
        actions: {
          boom: defineAction(function* () {
            counter.runs += 1

            return yield* fail('failing-svc.boom', 'kaboom')
          }),
        },
      })

      yield* bootstrap()
      yield* install(CachePolicy, { global: true })
      yield* Broker.actions.register(service)

      const first = yield* Broker.actions.exchange(service, 'boom', undefined)
      const second = yield* Broker.actions.exchange(service, 'boom', undefined)

      return { kinds: [first.kind, second.kind], runs: counter.runs }
    })

    expect(result.kinds).toEqual(['failure', 'failure'])
    expect(result.runs).toBe(2)
  })
})
