import { capUtf8 } from 'std:shared'

import type { TraceDef } from '../types/trace'

import { attributesOf } from './attributes'
import { DEFAULT_SCOPE, LOG_VALUE_BYTES, MAX_ATTRIBUTES } from './const'
import type { SpanRecorder } from './recorder'
import { logContextOf } from './tree'

/**
 * A log record from `input`, the rest taken from `rec` (the span it belongs to): its context,
 * service, scope and clock. Attributes are normalized under the log limits (values ≤ 16 KiB, 128
 * keys); a named event also carries `otel.event.name` (destinations that drop EventName keep it).
 * The body is never empty.
 */
export const logOf = (rec: SpanRecorder | null, input: TraceDef.LogInput): TraceDef.LogData => {
  const { attributes, dropped } = attributesOf(input.attributes, LOG_VALUE_BYTES, MAX_ATTRIBUTES)
  const { eventName, severityText } = input
  const traced = rec !== null && !rec.passThrough
  const body = capUtf8(input.body || eventName || severityText || 'log', LOG_VALUE_BYTES)

  return {
    time: input.time ?? rec?.now() ?? Date.now(),
    observedTime: Date.now(),
    severityNumber: input.severityNumber,
    ...(severityText ? { severityText } : {}),
    body,
    ...(eventName ? { eventName } : {}),
    attributes: eventName ? { ...attributes, 'otel.event.name': eventName } : attributes,
    droppedAttributes: dropped,
    context:
      input.context === undefined
        ? rec
          ? logContextOf(rec.context)
          : null
        : input.context && logContextOf(input.context),
    service: input.service === undefined ? (traced ? rec.service : null) : input.service,
    scope: input.scope ?? (traced ? rec.scope : DEFAULT_SCOPE),
  }
}
