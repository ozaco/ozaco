import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { Logger } from 'std:logger'
import { Trace } from 'std:trace'

import { OBSERVE_LOGGER } from './const'

/**
 * A delivery complaint (a backend refusing, a collector gone): a WARN line through the std
 * Logger under `logger: '@ozaco/server/observe'`, SUPPRESSED — an exporter's trouble is never
 * telemetry itself (no record reaches a sink, nothing recurses) — else `console.warn`. Never
 * fails.
 */
export function* warnDelivery(
  message: string,
  data: Readonly<Record<string, unknown>>,
): Operation<void> {
  yield* attempt(() =>
    Trace.actions.suppressed(function* () {
      if ((yield* Logger.context.get()) === undefined) {
        console.warn(`[ozaco/observe] ${message}`)

        return
      }

      yield* Logger.actions.child({ logger: OBSERVE_LOGGER }, () =>
        Logger.actions.warn(message, { ...data }),
      )
    }),
  )
}
