import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { Logger, LogLevel } from 'std:logger'
import { isFailure } from 'std:result'

import type { BoundLogger, BoundLogMethod } from '../types'

type LevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const noop: Operation<void> = {
  *[Symbol.iterator]() {},
}

const createSilent = (bindings: Record<string, unknown>): BoundLogger => ({
  bindings,
  trace: () => noop,
  debug: () => noop,
  info: () => noop,
  warn: () => noop,
  error: () => noop,
  fatal: () => noop,
  child: extra => createSilent({ ...bindings, ...extra }),
})

const createBound = (bindings: Record<string, unknown>): BoundLogger => {
  const at =
    (level: LevelName): BoundLogMethod =>
    (msg, data) =>
      Logger.actions.child(bindings, () =>
        data === undefined ? Logger.actions[level](msg) : Logger.actions[level](msg, data),
      )

  return {
    bindings,
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: extra => createBound({ ...bindings, ...extra }),
  }
}

/**
 * Create a per-instance {@link BoundLogger} carrying `bindings` on every entry. Probes ONCE
 * whether a `Logger` impl is installed in the current scope — when none is, a silent no-op logger
 * is returned, so callers never have to guard their logging.
 */
export function* boundLogger(bindings: Record<string, unknown> = {}): Operation<BoundLogger> {
  const probe = yield* attempt(Logger.actions.isLevelEnabled(LogLevel.error))
  return isFailure(probe) ? createSilent(bindings) : createBound(bindings)
}

/** A {@link boundLogger} keyed by module name: `boundLogger({ module, ...extra })`. */
export const moduleLogger = (
  module: string,
  extra?: Record<string, unknown>,
): Operation<BoundLogger> => boundLogger({ module, ...extra })
