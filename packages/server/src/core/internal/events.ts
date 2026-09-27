import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { Logger } from 'std:logger'
import type { Result } from 'std:result'

import { TRACE_SCOPE } from '../const'
import type { EventsDef } from '../types/events'
import type { ServerDef } from '../types/server'
import { statusOf } from '../utils/failure'

import { SUBSCRIPTION_KEY } from './const'
import { withInbound } from './spans'

/**
 * A `handle` failure where tracing is OFF (a non-observing node): no span can hold it, so it is
 * never silent — one Logger line (`logger: '@ozaco/server'`), correlated to the emitter's
 * context, WARN for a bad publisher (4xx), ERROR for a handler that broke. Never fails.
 */
export function* unhandled(
  item: ServerDef.EventItem,
  failure: Result.Failure<unknown>,
  options: EventsDef.HandleOptions | undefined,
): Operation<void> {
  yield* attempt(function* () {
    if ((yield* Logger.context.get()) === undefined) {
      return
    }

    const level = statusOf(failure) >= 500 ? 'error' : 'warn'
    const data: Record<string, unknown> = {
      'messaging.destination.name': item.name,
      'ozaco.event.origin': item.origin,
      error: failure,
    }

    if (options?.subscription) {
      data[SUBSCRIPTION_KEY] = options.subscription
    }

    yield* withInbound(item.trace, () =>
      Logger.actions.child({ logger: TRACE_SCOPE }, () =>
        Logger.actions[level](`event "${item.name}" was not handled`, data),
      ),
    )
  })
}
