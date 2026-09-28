import type { Flow, Operation } from 'std:effect'
import { attempt, fork } from 'std:effect'
import { Logger } from 'std:logger'
import { isFailure } from 'std:result'

import { TRANSPORT_LOGGER } from '../const'
import type { TransportDef } from '../types/transport'

/**
 * One operational line through the installed std `Logger`, under the child binding
 * `logger: '@ozaco/transport'` (the line's scope) with `data` as its payload — an `error` key
 * carries a Failure (a foreign value — a client's error — is folded first, `asFailure`). Silent
 * when no Logger is installed where it runs, and it never fails: a transport is never broken by
 * its own logging.
 */
export function* logTransport(
  level: TransportDef.LogLevel,
  message: string,
  data?: Record<string, unknown>,
): Operation<void> {
  yield* attempt(function* () {
    if ((yield* Logger.context.get()) === undefined) {
      return
    }

    yield* Logger.actions.child({ logger: TRANSPORT_LOGGER }, () =>
      data === undefined ? Logger.actions[level](message) : Logger.actions[level](message, data),
    )
  })
}

/**
 * Log a transport's connection changes for as long as the calling scope lives — a lost
 * connection at WARN (`transport connection lost`, with `detail()`), its return at INFO
 * (`transport reconnected`, with `ozaco.connection.down_ms`), the end at INFO (`transport closed`;
 * WARN when it closed while reconnecting). The first status `status` reports is the baseline,
 * never logged. Subscribes to `status` right away, then watches it on a forked task and returns;
 * an impl's `setup` calls it once its state is in place (a status that cannot be watched is
 * silently not watched). The Logger is looked up per line, so one installed after the transport
 * is still heard.
 */
export function* watchStatus(
  status: Flow<TransportDef.Status, void>,
  watch: TransportDef.StatusWatch,
): Operation<void> {
  const identity = { 'messaging.system': watch.transport, 'ozaco.prefix': watch.prefix }
  // subscribed HERE, before returning: a change right after the install is never missed
  const subscribed = yield* attempt(function* () {
    return yield* status
  })

  if (isFailure(subscribed)) {
    return
  }

  const changes = subscribed.value

  yield* fork(() =>
    attempt(function* () {
      let last: TransportDef.Status | undefined
      let lostAt = Date.now()

      for (;;) {
        const step = yield* changes.next()

        if (step.done) {
          return
        }

        const next = step.value
        const previous = last

        last = next

        if (previous === undefined || next === previous) {
          if (next === 'reconnecting') {
            lostAt = Date.now()
          }

          continue
        }

        switch (next) {
          case 'reconnecting': {
            lostAt = Date.now()
            yield* logTransport('warn', 'transport connection lost', {
              ...identity,
              ...watch.detail?.(),
            })

            break
          }
          case 'connected': {
            yield* logTransport('info', 'transport reconnected', {
              ...identity,
              'ozaco.connection.down_ms': Date.now() - lostAt,
            })

            break
          }
          default: {
            yield* logTransport(
              previous === 'reconnecting' ? 'warn' : 'info',
              previous === 'reconnecting'
                ? 'transport closed while reconnecting'
                : 'transport closed',
              identity,
            )
          }
        }
      }
    }),
  )
}
