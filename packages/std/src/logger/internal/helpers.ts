import { operation, useContext } from 'std:effect'

import type { LogLevel } from '../const'
import { Logger, LoggerTransport } from '../definitions'
import type { Helpers } from '../types/helpers'
import type { LoggerDef } from '../types/logger'

import { LoggerBindingsContext } from './context'
import { normalizePayload } from './normalize'

export const logAt = (level: LogLevel) =>
  operation(function* (...args: LoggerDef.Payload[]) {
    const ctx = yield* useContext(Logger)
    if (level < ctx.level) {
      return
    }
    const bindings = (yield* LoggerBindingsContext.get()) ?? {}
    const entry = buildEntry({ ctx, bindings }, level, args)
    yield* dispatch(entry)
  })

export const dispatch = operation(function* (entry: LoggerDef.Entry) {
  // Fans out to every installed transport via the LoggerTransport protocol's `exec`. Each transport
  // applies its own level threshold inside `write`, so no per-transport filtering is needed here.
  yield* LoggerTransport.actions.write(entry)
})

export const buildEntry = (
  source: Helpers.BuildEntrySource,
  level: LogLevel,
  args: readonly LoggerDef.Payload[],
): LoggerDef.Entry => {
  const { msg, data, error } = normalizePayload(args)

  return {
    level,
    time: source.ctx.timestamp(),
    msg,
    error,
    bindings: source.bindings,
    data,
  }
}
