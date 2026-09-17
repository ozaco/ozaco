import type { Utils } from 'std:effect'
import { budgetDelay, guard, sleep } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'

import { RtcCauses, RtcErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { RtcDef } from '../types/rtc'

import { dialGeneration } from './generation'

const isConnected = (generation: Helpers.Generation | undefined) =>
  generation?.alive === true && generation.pc.connectionState === 'connected'

/**
 * ICE-restart supervisor (forked, only when budgeted): one outage at a time — queue a restart
 * offer, wait `delayMs * backoff^attempt` (capped), check recovery. The budget RESETS after every
 * recovery; exhaustion ends the GENERATION (redialed under `reconnect`, terminal
 * `rtc/ice-exhausted` otherwise).
 */
export const superviseIce = guard(function* (session: Helpers.Session, budget: Utils.Budget) {
  const { counters, observe } = session

  yield* session.eachGeneration(function* (generation) {
    const gone = () => !generation.alive || session.ended || session.closedByClient

    while (true) {
      const outage = yield* generation.outages.next()
      if (outage.done) {
        return
      }

      if (isConnected(generation)) {
        continue // a stale outage — the connection already recovered
      }

      let recovered = false
      const startedAt = Date.now()

      for (let attemptNo = 0; attemptNo < budget.retries; attemptNo += 1) {
        if (gone()) {
          return
        }

        observe.record('ice-restart', `attempt ${attemptNo + 1}`)
        generation.negotiations.add({ kind: 'restart' })
        yield* sleep(budgetDelay(budget, attemptNo))

        if (gone()) {
          return
        }

        if (isConnected(generation)) {
          counters.restarts += 1
          observe.record('ice-restart', 'recovered', { durationMs: Date.now() - startedAt })
          recovered = true
          break
        }
      }

      if (!recovered) {
        session.endGeneration(
          generation,
          fail(
            RtcErrors.IceExhausted,
            `gave up after ${budget.retries} ice restart attempts`,
          ) as Result.Failure<unknown>,
          { state: generation.pc.connectionState, reason: 'ice-exhausted' },
        )
        return
      }
    }
  })
}, RtcCauses.IceRestart)

/**
 * Session-reconnect supervisor (forked, only when budgeted): one generation death at a time —
 * redial a whole new connection over the same signal after `delayMs * backoff^attempt`
 * (capped); success = the new generation reaches `connected` within the next backoff step. The
 * budget RESETS after every recovery; exhaustion settles `rtc/reconnect-exhausted`.
 */
export const superviseReconnect = guard(function* (
  session: Helpers.Session,
  impl: RtcDef.ImplLike,
  budget: Utils.Budget,
) {
  const { counters, observe } = session
  const gone = () => session.ended || session.closedByClient

  while (true) {
    const outage = yield* session.outages.next()
    if (outage.done || gone()) {
      return
    }

    if (isConnected(session.generation)) {
      continue // a stale outage — a later generation already recovered
    }

    let recovered = false
    const startedAt = Date.now()

    for (let attemptNo = 0; attemptNo < budget.retries; attemptNo += 1) {
      observe.record('redial', `attempt ${attemptNo + 1}`)
      yield* sleep(budgetDelay(budget, attemptNo))

      if (gone()) {
        return
      }

      if (session.signalEnded) {
        break // no signal, no negotiation — exhaust into the terminal settle below
      }

      const previous = session.generation
      if (previous?.alive) {
        session.teardownGeneration(previous) // a half-dialed attempt that never connected
      }

      if (dialGeneration(session, impl) !== undefined) {
        continue // construction failed — next attempt
      }

      // grace window: one backoff step for the fresh generation to negotiate + connect
      yield* sleep(budgetDelay(budget, attemptNo))

      if (gone()) {
        return
      }

      if (isConnected(session.generation)) {
        recovered = true
        break
      }
    }

    if (recovered) {
      counters.reconnects += 1
      observe.record('redial', 'recovered', { durationMs: Date.now() - startedAt })
      continue
    }

    session.settle(
      fail(
        RtcErrors.ReconnectExhausted,
        `gave up after ${budget.retries} redial attempts`,
      ) as Result.Failure<unknown>,
      { state: session.stateOf(), reason: 'reconnect-exhausted' },
    )
    return
  }
}, RtcCauses.Reconnect)
