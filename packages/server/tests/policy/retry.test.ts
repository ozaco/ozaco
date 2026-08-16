import { Broker, CoreErrors, defineAction, defineService, Transport } from 'server:core'
import type { Reply, TransportDispatch, TransportEvent } from 'server:core'
import { operation } from 'std:effect'
import { install } from 'std:plugin'
import { fail, isFailure, just } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { RetryPolicy } from 'server:policy/retry'

import { bootstrap } from '../core/helpers'
import { runResult, runScoped } from '../helpers'

/** A carrier hosting `flaky-remote` that raises Unavailable until `failures` runs out. */
const installFlakyCarrier = operation(function* (state: { dispatches: number; failures: number }) {
  yield* Transport.actions.register({
    name: 'flaky-carrier',
    priority: -10,
    actions: {
      hosts: operation(function* (service: string) {
        return just(service === 'flaky-remote')
      }),
      dispatch: operation(function* ({ request, acked }: TransportDispatch) {
        state.dispatches += 1

        if (state.dispatches <= state.failures) {
          return yield* fail(CoreErrors.Unavailable, 'carrier momentarily unavailable')
        }

        acked()

        const reply: Reply = { kind: 'value', cid: request.cid, meta: {}, value: 'ok' }

        return reply
      }),
      emit: operation(function* (_event: TransportEvent) {
        return 'skipped' as const
      }),
      broadcast: operation(function* (_event: TransportEvent) {}),
    },
  })
})

describe('policy: retry', () => {
  it('does NOT retry business failure replies by default', async () => {
    const counter = { runs: 0 }
    const failure = await runResult(function* () {
      const service = defineService({
        name: 'business-svc',
        actions: {
          boom: defineAction(function* () {
            counter.runs += 1

            return yield* fail('business-svc.boom', 'kaboom')
          }),
        },
      })

      yield* bootstrap()
      yield* install(RetryPolicy, { delayMs: 1 })
      yield* Broker.actions.register(service)

      yield* Broker.actions.call(service, 'boom', undefined)
    })

    expect(isFailure(failure)).toBe(true)

    if (isFailure(failure)) {
      expect(failure.error).toBe('business-svc.boom')
    }

    expect(counter.runs).toBe(1)
  })

  it('retries raised Unavailable failures until the carrier recovers', async () => {
    const state = { dispatches: 0, failures: 2 }
    const value = await runScoped(function* () {
      yield* bootstrap()
      yield* install(RetryPolicy, { attempts: 3, delayMs: 1 })
      yield* installFlakyCarrier(state)

      return yield* Broker.actions.call('flaky-remote', 'anything', undefined)
    })

    expect(value).toBe('ok')
    expect(state.dispatches).toBe(3)
  })

  it('exhaustion re-raises the last failure with the retry cause appended', async () => {
    const state = { dispatches: 0, failures: Number.POSITIVE_INFINITY }
    const failure = await runResult(function* () {
      yield* bootstrap()
      yield* install(RetryPolicy, { attempts: 3, delayMs: 1 })
      yield* installFlakyCarrier(state)

      yield* Broker.actions.call('flaky-remote', 'anything', undefined)
    })

    expect(isFailure(failure)).toBe(true)

    if (isFailure(failure)) {
      expect(failure.error).toBe(CoreErrors.Unavailable)
      expect(failure.causes.includes('policy:retry 3 attempts exhausted')).toBe(true)
    }

    expect(state.dispatches).toBe(3)
  })

  it('a custom when predicate retries matching business failures', async () => {
    const result = await runScoped(function* () {
      const counter = { runs: 0 }
      const service = defineService({
        name: 'recovering-svc',
        actions: {
          shaky: defineAction(function* () {
            counter.runs += 1

            if (counter.runs < 3) {
              return yield* fail('recovering-svc.shaky', 'not yet')
            }

            return 'recovered'
          }),
        },
      })

      yield* bootstrap()
      yield* install(RetryPolicy, {
        attempts: 3,
        delayMs: 1,
        when: failure => failure.error === 'recovering-svc.shaky',
      })
      yield* Broker.actions.register(service)

      const value = yield* Broker.actions.call(service, 'shaky', undefined)

      return { value, runs: counter.runs }
    })

    expect(result.value).toBe('recovered')
    expect(result.runs).toBe(3)
  })
})
