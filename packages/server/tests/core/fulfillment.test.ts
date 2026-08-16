import { Broker, CoreErrors, defineAction, defineService, Transport, useSignal } from 'server:core'
import type { Reply, TransportDispatch, TransportEvent } from 'server:core'
import { attempt, operation, sleep, suspend } from 'std:effect'
import { isFailure, isJust, isNothing, just } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { runResult, runScoped } from '../helpers'

import { bootstrap, cidOf } from './helpers'

/** A carrier claiming `slow-remote` that can withhold ack / reply on demand. */
const installFakeCarrier = operation(function* (behavior: 'never-ack' | 'ack-then-hang') {
  yield* Transport.actions.register({
    name: 'fake-remote',
    priority: -10,
    actions: {
      hosts: operation(function* (service: string) {
        return just(service === 'slow-remote')
      }),
      dispatch: operation(function* ({ acked }: TransportDispatch) {
        if (behavior === 'ack-then-hang') {
          acked()
        }

        yield* suspend()

        return undefined as never as Reply
      }),
      emit: operation(function* (_event: TransportEvent) {
        return 'skipped' as const
      }),
      broadcast: operation(function* (_event: TransportEvent) {}),
    },
  })
})

describe('fulfillment model', () => {
  it('no ack → TimeoutUnreached (work never started, retry safe)', async () => {
    const failure = await runResult(function* () {
      yield* bootstrap()
      yield* installFakeCarrier('never-ack')

      yield* Broker.actions.call('slow-remote', 'anything', undefined, { ackTimeoutMs: 30 })
    })

    expect(isFailure(failure)).toBe(true)
    if (isFailure(failure)) {
      expect(failure.error).toBe(CoreErrors.TimeoutUnreached)
      expect(failure.message).toContain('retry is safe')
    }
  })

  it('ack but no reply → TimeoutPending with the cid, outcome recorded as cancelled', async () => {
    const outcome = await runScoped(function* () {
      yield* bootstrap()
      yield* installFakeCarrier('ack-then-hang')

      const failure = yield* attempt(() =>
        Broker.actions.call('slow-remote', 'anything', undefined, {
          ackTimeoutMs: 1000,
          timeoutMs: 30,
        }),
      )

      if (!isFailure(failure)) {
        throw new Error('expected a failure')
      }

      const stored = yield* Broker.actions.outcome(cidOf(failure))

      return { failure, stored }
    })

    expect(outcome.failure.error).toBe(CoreErrors.TimeoutPending)
    expect(outcome.failure.message).toContain('outcome unknown')
    expect(isJust(outcome.stored)).toBe(true)
    if (isJust(outcome.stored)) {
      expect(outcome.stored.value.state).toBe('cancelled')
    }
  })

  it('detach: the handler finishes after abandonment and the real outcome is queryable', async () => {
    const result = await runScoped(function* () {
      let finished = false
      let sawAbort = false

      const slow = defineService({
        name: 'slow-local',
        actions: {
          work: defineAction({ onDisconnect: 'detach' }, function* () {
            const signal = yield* useSignal()

            yield* sleep(80)
            finished = true
            sawAbort = signal.aborted()

            return 'done'
          }),
        },
      })

      yield* bootstrap()
      yield* Broker.actions.register(slow)

      const failure = yield* attempt(() =>
        Broker.actions.call(slow, 'work', undefined, { timeoutMs: 20 }),
      )

      if (!isFailure(failure)) {
        throw new Error('expected TimeoutPending')
      }

      const cid = cidOf(failure)
      const before = yield* Broker.actions.outcome(cid)

      yield* sleep(150)

      const after = yield* Broker.actions.outcome(cid)

      return { failure, finished, sawAbort, before, after }
    })

    expect(result.failure.error).toBe(CoreErrors.TimeoutPending)
    expect(result.finished).toBe(true)
    expect(result.sawAbort).toBe(true)
    expect(isNothing(result.before)).toBe(true)
    expect(isJust(result.after)).toBe(true)
    if (isJust(result.after)) {
      expect(result.after.value.state).toBe('fulfilled')
    }
  })

  it('cancel (default): the handler is halted on abandonment', async () => {
    const result = await runScoped(function* () {
      let finished = false

      const slow = defineService({
        name: 'slow-cancel',
        actions: {
          work: defineAction(function* () {
            yield* sleep(80)
            finished = true

            return 'done'
          }),
        },
      })

      yield* bootstrap()
      yield* Broker.actions.register(slow)

      const failure = yield* attempt(() =>
        Broker.actions.call(slow, 'work', undefined, { timeoutMs: 20 }),
      )

      yield* sleep(150)

      return { failure, finished }
    })

    expect(isFailure(result.failure)).toBe(true)
    if (isFailure(result.failure)) {
      expect(result.failure.error).toBe(CoreErrors.TimeoutPending)
    }
    expect(result.finished).toBe(false)
  })

  it('fast local dispatches are unaffected by tight fulfillment timeouts', async () => {
    const value = await runScoped(function* () {
      const quick = defineService({
        name: 'quick',
        actions: {
          ping: defineAction(function* () {
            return 'pong'
          }),
        },
      })

      yield* bootstrap({ ackTimeoutMs: 50, requestTimeoutMs: 200 })
      yield* Broker.actions.register(quick)

      return yield* Broker.actions.call(quick, 'ping', undefined)
    })

    expect(value).toBe('pong')
  })
})
