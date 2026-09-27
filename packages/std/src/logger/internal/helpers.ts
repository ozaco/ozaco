import type { Operation } from 'std:effect'
import { useContext } from 'std:effect'
import { activeContext } from 'std:trace'

import type { LogLevel } from '../const'
import { Logger, LoggerTransport } from '../definitions'
import type { Helpers } from '../types/helpers'
import type { LoggerDef } from '../types/logger'

import { LoggerBindingsContext } from './context'
import { normalizePayload } from './normalize'

/** The active span as an entry references it (ids + flags), `null` outside of any. */
function* activeTrace(): Operation<LoggerDef.Trace | null> {
  const context = yield* activeContext()

  return context ? { traceId: context.traceId, spanId: context.spanId, flags: context.flags } : null
}

export const logAt = (level: LogLevel) =>
  function* (...args: LoggerDef.Payload[]): Operation<void> {
    const ctx = yield* useContext(Logger)
    if (level < ctx.level) {
      return
    }
    const bindings = (yield* LoggerBindingsContext.get()) ?? {}
    const trace = yield* activeTrace()
    const entry = buildEntry({ ctx, bindings, trace }, level, args)
    yield* dispatch(entry)
  }

export function* dispatch(entry: LoggerDef.Entry) {
  // Fans out to every installed transport via the LoggerTransport protocol's `exec`. Each transport
  // applies its own level threshold inside `write`, so no per-transport filtering is needed here.
  yield* LoggerTransport.actions.write(entry)
}

export const buildEntry = (
  source: Helpers.BuildEntrySource,
  level: LogLevel,
  args: readonly LoggerDef.Payload[],
): LoggerDef.Entry => {
  const { msg, data, error, failures } = normalizePayload(args, source.ctx.errorKey)

  return {
    level,
    time: source.ctx.timestamp(),
    msg,
    error,
    failures,
    bindings: source.bindings,
    data,
    ...(source.trace ? { trace: source.trace } : {}),
  }
}
