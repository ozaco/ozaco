import type { Future } from 'std:effect'
import { all, operation, reduce, useContext } from 'std:effect'

import type { LogLevel } from '../const'
import { Logger } from '../definitions'
import type { LoggerDef } from '../types/logger'

import { LoggerBindingsContext } from './context'
import { normalizePayload } from './normalize'

interface BuildEntrySource {
  ctx: LoggerDef.Context
  bindings: Record<string, unknown>
}

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
  const transports = yield* Logger.actions.getTransports()

  if (transports.length === 0) {
    return
  }

  const ops = yield* reduce(
    transports,
    function* (acc, transport) {
      const transportCtx = yield* useContext(transport)

      if (transportCtx.level !== undefined && entry.level < transportCtx.level) {
        return acc
      }

      acc.push(transport.actions.write(entry))

      return acc
    },
    [] as Future<unknown, unknown>[],
  )

  if (ops.length === 0) {
    return
  }

  yield* all(ops)
})

export const buildEntry = (
  source: BuildEntrySource,
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
