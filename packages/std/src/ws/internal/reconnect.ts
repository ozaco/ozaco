import type { Utils } from 'std:effect'
import { attempt, budgetDelay, operation, sleep } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isSuccess } from 'std:result'

import { WsCauses, WsErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { WsDef } from '../types/ws'

import { dial } from './dial'

const exhausted = (budget: Utils.Budget, last: WsDef.CloseInfo) =>
  fail(
    WsErrors.ReconnectExhausted,
    `gave up after ${budget.retries} redial attempts (last close: ${last.code}${
      last.reason ? ` ${last.reason}` : ''
    })`,
  ) as Result.Failure<unknown>

/**
 * Reconnect supervisor (forked): one outage at a time — redial after `delayMs * backoff^attempt`
 * (capped by `maxDelayMs`); the attempt budget RESETS after every successful reopen, so only
 * consecutive failed redials exhaust it. Exhaustion ends the connection with a
 * `WsErrors.ReconnectExhausted` failure close. Never raises: dial failures are attempted, everything
 * else is synchronous bookkeeping.
 */
export const supervise = operation(function* (
  session: Helpers.Session,
  impl: WsDef.ImplLike,
  budget: Utils.Budget,
) {
  while (true) {
    const outage = yield* session.outages.next()
    if (outage.done) {
      return
    }

    let reopened = false

    for (let attemptNo = 0; attemptNo < budget.retries; attemptNo += 1) {
      yield* sleep(budgetDelay(budget, attemptNo))

      if (session.ended || session.closedByClient) {
        return
      }

      const redialed = yield* attempt(() => dial(session, impl))
      if (!isSuccess(redialed)) {
        continue
      }

      if (session.ended) {
        return // raced with teardown — `onopen` refused adoption and disposed the socket
      }

      session.reconnects += 1
      reopened = true
      break
    }

    if (!reopened) {
      const last = session.lastClose ?? { code: 1006, reason: '' }
      session.settle(exhausted(budget, last), last)
      return
    }
  }
}, WsCauses.Reconnect)
