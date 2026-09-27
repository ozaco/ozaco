import { attempt, useContext } from 'std:effect'

import pkg from '../../../../package.json'
import { LogLevel } from '../../const'
import { Logger, LoggerTransport } from '../../definitions'
import type { LoggerDef } from '../../types/logger'

import { forward } from './internal'
import type { TraceTransportDef } from './types'

const TraceTransportImpl = LoggerTransport.implement<
  TraceTransportDef.Context,
  [options?: TraceTransportDef.Options]
>({
  name: 'std/trace-transport',
  version: pkg.version,
  description: 'logger → std:trace: every entry becomes a log record correlated to its span',

  /** The level defaults to the installed Logger's (read here, so install it after the Logger);
   * without a Logger yet it forwards every level the Logger later lets through. */
  *setup(options = {}) {
    const logger = yield* Logger.context.get()

    const context: TraceTransportDef.Context = {
      name: 'trace',
      level: options.level ?? logger?.level ?? LogLevel.trace,
      options,
    }

    return context
  },
})

/**
 * The bridge from the Logger to std:trace (`std:logger/transport/trace`): every entry at or above
 * its level becomes ONE `LogData` handed to the installed `Tracer`s through `emitLog` —
 * correlated to the entry's span, severity by level (TRACE 1 … FATAL 21) with the level's name as
 * `severityText`, the message as body, the `logger` binding as the instrumentation scope, bindings
 * + data flattened into attributes (≤ 64 leaves, the rest one `ozaco.log.data` JSON string;
 * backend-reserved keys moved under `ozaco.data.`). A failure logged at WARN+ inside a recording
 * span is recorded once through `recordFailure`; elsewhere the line carries its exception
 * attributes. Silent while suppressed, and for entries `ctx.log` already emitted (binding
 * `ozaco.telemetry = 'sent'`). Telemetry never fails a log call.
 *
 * Where tracing is off (a scope outside every observing node: infrastructure — transport, db —
 * installed before `createServer`), the record goes to the process FALLBACK sink instead
 * (`registerFallback` in std:trace; an observing `@ozaco/server` node registers itself), and
 * nowhere when none is registered.
 *
 * Only the transports visible where the Logger is CALLED run, and a re-install of the same
 * transport replaces the inherited one — so the recommended setup is ONE install at the ROOT, next
 * to `ConsoleTransport`: `DefaultLogger.use()`, `ConsoleTransport.use()`, `TraceTransport.use()`.
 * Every line then becomes exactly one record: lines logged inside a node reach its Tracer, lines
 * logged outside reach the fallback (the node's sinks, with its resource). `createServer` installs
 * one in its own scope only when none is visible — then only the lines logged inside the node
 * are bridged.
 */
export const TraceTransport = TraceTransportImpl.build({
  *write(entry: LoggerDef.Entry) {
    const ctx = yield* useContext(TraceTransportImpl.context)

    if (entry.level < ctx.level) {
      return
    }

    yield* attempt(() => forward(entry))
  },

  *flush() {},
  *close() {},
})
