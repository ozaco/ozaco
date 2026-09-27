import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { Logger } from 'std:logger'

import { TRACE_SCOPE } from '../../const'

/**
 * One operational edge line (a socket closing, a swallowed failure) through the installed std
 * `Logger`, under the child binding `logger: '@ozaco/server'` (the record's scope) — correlated to
 * whatever span is active where it runs (the Logger stamps it; `TraceTransport` bridges it to the
 * sinks). Silent without a Logger, and it never fails: the edge is never broken by its own logging.
 */
export function* edgeLog(
  level: 'info' | 'warn',
  message: string,
  data?: Readonly<Record<string, unknown>>,
): Operation<void> {
  yield* attempt(function* () {
    if ((yield* Logger.context.get()) === undefined) {
      return
    }

    yield* Logger.actions.child({ logger: TRACE_SCOPE }, () =>
      data === undefined
        ? Logger.actions[level](message)
        : Logger.actions[level](message, { ...data }),
    )
  })
}
