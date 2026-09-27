import type { Operation } from 'std:effect'
import { useScope } from 'std:effect'

import { SEVERITY } from '../internal/const'
import { activeOf, isOn } from '../internal/context'
import { fallbackFor, sendFallback } from '../internal/fallback'
import { logOf } from '../internal/log'
import { deliverLog } from '../internal/settle'
import type { TraceDef } from '../types/trace'

/**
 * A named event: a span event on the active span (when it records) AND a log record with
 * `eventName = name` (always, while tracing is on — also under a non-recording span, flags `00`).
 * Severity default 9 (INFO), body default the name, time default now on the span's clock. With
 * tracing off (not suppressed) the record alone goes to the process fallback sink, when one is
 * registered (`registerFallback`).
 */
export function* event(
  name: string,
  attributes?: TraceDef.AttributesInput,
  options: TraceDef.EventOptions = {},
): Operation<void> {
  const scope = yield* useScope()
  const on = isOn(scope)
  const sink = on ? undefined : fallbackFor(scope)

  if (!on && !sink) {
    return
  }

  const rec = activeOf(scope)
  const time = options.time ?? rec?.now() ?? Date.now()
  const log = logOf(rec, {
    body: options.body ?? name,
    severityNumber: options.severity ?? SEVERITY.info,
    eventName: name,
    attributes,
    time,
  })

  if (sink) {
    yield* sendFallback(sink, log)
    return
  }

  rec?.addEvent(name, attributes, time)

  yield* deliverLog(rec?.trace ?? null, log)
}

/**
 * Emit a log record — a logger line, a domain record — correlated to the active span: what `input`
 * leaves out (context, service, scope, time) comes from it. Goes through the active local trace
 * (buffered with a `record: 'errors'` one). Suppressed: a no-op. Tracing off: the record goes to
 * the process fallback sink, when one is registered (`registerFallback`), else nowhere.
 */
export function* emitLog(input: TraceDef.LogInput): Operation<void> {
  const scope = yield* useScope()

  if (isOn(scope)) {
    const rec = activeOf(scope)

    yield* deliverLog(rec?.trace ?? null, logOf(rec, input))
    return
  }

  const sink = fallbackFor(scope)

  if (sink) {
    yield* sendFallback(sink, logOf(activeOf(scope), input))
  }
}
