import type { Operation } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { Logger, LoggerTransport, LogLevel } from 'std:logger'
import type { Result } from 'std:result'
import type { TraceDef } from 'std:trace'
import { exceptionType, isRecorded, TraceSeverity } from 'std:trace'

import { Server } from '../definition/protocol'
import type { ServerDef } from '../types/server'

import { NOTED_FAILURES, SENT_BINDING } from './const'
import { ForwardedAt } from './context'

export const noted: WeakRef<Result.Failure<unknown>>[] = []

/** The failures a log line at WARN or above showed in the Logger already. */
export const logged = new WeakSet<Result.Failure<unknown>>()

/** Remember a failure that escaped a kernel span: the exception record it settles into may be
 * forwarded to the Logger WITH it (`forwardException`). */
export const noteFailure = (failure: Result.Failure<unknown>): void => {
  if (noted.at(-1)?.deref() === failure) {
    return
  }

  noted.push(new WeakRef(failure))

  if (noted.length > NOTED_FAILURES) {
    noted.shift()
  }
}

/** Remember that `failure` is shown by a Logger line already (`markLogged`, a Logger line at WARN
 * or above, a `ctx.log` line): its exception record is never forwarded to the Logger again. */
export const markShown = (failure: Result.Failure<unknown>): void => {
  logged.add(failure)
  noteFailure(failure)
}

/** The noted failure an exception record was made of: recorded in the record's trace, same
 * `exception.type` (its tag) and message — the newest such one. */
export const recall = (log: TraceDef.LogData): Result.Failure<unknown> | undefined => {
  const traceId = log.context?.traceId ?? ''
  const type = log.attributes['exception.type']
  const message = log.attributes['exception.message']

  for (let index = noted.length - 1; index >= 0; index -= 1) {
    const failure = noted[index]!.deref()
    const text = failure?.message ?? ''

    if (
      failure &&
      isRecorded(failure, traceId) &&
      exceptionType(failure) === type &&
      (!text ||
        text === message ||
        (typeof message === 'string' && text.startsWith(message.slice(0, 64))))
    ) {
      return failure
    }
  }

  return undefined
}

/** A settled exception record (std:trace's own — no `severityText`: a logger-bridged line or a
 * `ctx.log` line carrying exception attributes has one). */
export const isExceptionRecord = (log: TraceDef.LogData): boolean =>
  log.severityText === undefined && typeof log.attributes['exception.type'] === 'string'

/**
 * Forward one settled exception record at WARN or above to the std Logger — when one is installed
 * where it was recorded — so failures show in the console / terminal too: the failure attached
 * when it is known here (it escaped a kernel span), else the record's rendered chain as the line.
 * Bound `ozaco.telemetry = 'sent'` (the Logger's `TraceTransport` skips it: the record already is
 * telemetry) and `logger` = the record's scope. Only the node the record was emitted in forwards
 * it, and never the record of a failure a log line showed already (`markLogged`). The line is the
 * failure's: std:trace hands the record over with its own span active (the entry's `trace` is the
 * failure's origin span), and it is stamped with the record's time (`ForwardedAt`).
 */
export function* forwardException(
  kernel: ServerDef.Context,
  log: TraceDef.LogData,
): Operation<void> {
  if (
    log.severityNumber < TraceSeverity.warn ||
    !isExceptionRecord(log) ||
    (yield* Server.context.get()) !== kernel ||
    (yield* Logger.context.get()) === undefined
  ) {
    return
  }

  const failure = recall(log)

  if (failure && logged.has(failure)) {
    return
  }

  const level =
    log.severityNumber >= TraceSeverity.fatal
      ? 'fatal'
      : log.severityNumber >= TraceSeverity.error
        ? 'error'
        : 'warn'

  yield* ForwardedAt.with(Math.trunc(log.time), () =>
    Logger.actions.child({ ...SENT_BINDING, logger: log.scope.name }, () =>
      failure
        ? Logger.actions[level](log.eventName ?? 'exception', failure)
        : Logger.actions[level](log.body),
    ),
  )
}

/**
 * Mark the failures of every std Logger line at WARN or above written in this node's scope as
 * shown (`markLogged`) before the Logger's transports run: the exception record its
 * `TraceTransport` makes of the line's failure — or a later settle of it — is not forwarded back
 * to the Logger. An exception line the server tracer forwards (`forwardException`) is stamped with
 * the failure's time here (`ForwardedAt`). Installed by `createServer` on an observing node.
 */
export function* markLoggedLines(): Operation<void> {
  yield* LoggerTransport.around({
    *write([entry]: [LoggerDef.Entry], next: (entry: LoggerDef.Entry) => Operation<void>) {
      if (entry.level >= LogLevel.warn) {
        for (const failure of entry.failures) {
          markShown(failure)
        }
      }

      const at = yield* ForwardedAt.get()

      return yield* next(at === null || at === undefined ? entry : { ...entry, time: at })
    },
  })
}
