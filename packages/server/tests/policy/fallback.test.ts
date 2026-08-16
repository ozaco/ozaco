import { Broker, defineAction, defineService } from 'server:core'
import { attempt } from 'std:effect'
import { install } from 'std:plugin'
import { fail, isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { FallbackPolicy } from 'server:policy/fallback'

import { bootstrap } from '../core/helpers'
import { runScoped } from '../helpers'

const flaky = defineService({
  name: 'flaky-svc',
  actions: {
    boom: defineAction(function* () {
      return yield* fail('flaky-svc.boom', 'kaboom')
    }),
    other: defineAction(function* () {
      return yield* fail('flaky-svc.other', 'different failure')
    }),
  },
})

describe('policy: fallback', () => {
  it('replaces a business failure reply with the static value', async () => {
    const value = await runScoped(function* () {
      yield* bootstrap()
      yield* install(FallbackPolicy, { value: 'safe-default' })
      yield* Broker.actions.register(flaky)

      // the action's declared return is `never` (it always fails) — the fallback widens it
      return (yield* Broker.actions.call(flaky, 'boom', undefined)) as string
    })

    expect(value).toBe('safe-default')
  })

  it('computes the fallback with a generator handler receiving ctx and failure', async () => {
    const value = await runScoped(function* () {
      yield* bootstrap()
      yield* install(FallbackPolicy, {
        *handler(ctx, failure) {
          return `${ctx.request.action}:${failure.error}`
        },
      })
      yield* Broker.actions.register(flaky)

      return (yield* Broker.actions.call(flaky, 'boom', undefined)) as string
    })

    expect(value).toBe('boom:flaky-svc.boom')
  })

  it('the when predicate scopes which failures fall back', async () => {
    const result = await runScoped(function* () {
      yield* bootstrap()
      yield* install(FallbackPolicy, {
        value: 'covered',
        when: failure => failure.error === 'flaky-svc.boom',
      })
      yield* Broker.actions.register(flaky)

      const matched = (yield* Broker.actions.call(flaky, 'boom', undefined)) as string
      const passed = yield* attempt(() => Broker.actions.call(flaky, 'other', undefined))

      return { matched, passed }
    })

    expect(result.matched).toBe('covered')
    expect(isFailure(result.passed)).toBe(true)
    if (isFailure(result.passed)) {
      expect(result.passed.error).toBe('flaky-svc.other')
    }
  })

  it('catches raised infrastructure failures too', async () => {
    const value = await runScoped(function* () {
      yield* bootstrap()
      yield* install(FallbackPolicy, { value: 'offline-default' })

      // nothing hosts this service → the transport raises Unavailable
      return yield* Broker.actions.call('ghost-svc', 'anything', undefined)
    })

    expect(value).toBe('offline-default')
  })
})
