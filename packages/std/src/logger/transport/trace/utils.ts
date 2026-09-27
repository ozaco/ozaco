import type { TraceDef } from 'std:trace'
import { toAttributes, TraceSeverity } from 'std:trace'

import { LogLevel } from '../../const'
import {
  MAX_LEAVES,
  OVERFLOW_KEY,
  PROTECTED_PREFIX,
  RESERVED_KEYS,
  VALUE_BYTES,
} from '../../internal/const'

/** A key the way the backends compare it: lowercase, every non-alphanumeric character `_`. */
export const backendKey = (key: string): string => key.toLowerCase().replaceAll(/[^a-z0-9]/gu, '_')

/**
 * Whether a log attribute key collides with a field the log backends reserve (`trace_id`,
 * `span_id`, `flags`, `severity*`, `detected_level`, `level`, `*timestamp`, `body`, `scope_*`,
 * `event_name`, `o2_event_name`, `instrumentation_library_*`, `dropped_attributes_count`,
 * `service_name`), compared after {@link backendKey} normalization (`Trace-Id`, `service.name`).
 */
export const isReservedLogKey = (key: string): boolean => RESERVED_KEYS.has(backendKey(key))

/**
 * The OTel severity of a level, by range: TRACE 1, DEBUG 5, INFO 9, WARN 13, ERROR 17, FATAL 21;
 * the text is the range's name (`INFO`).
 */
export const severityOf = (level: LogLevel): { number: number; text: string } => {
  if (level >= LogLevel.fatal) {
    return { number: TraceSeverity.fatal, text: 'FATAL' }
  }
  if (level >= LogLevel.error) {
    return { number: TraceSeverity.error, text: 'ERROR' }
  }
  if (level >= LogLevel.warn) {
    return { number: TraceSeverity.warn, text: 'WARN' }
  }
  if (level >= LogLevel.info) {
    return { number: TraceSeverity.info, text: 'INFO' }
  }
  if (level >= LogLevel.debug) {
    return { number: TraceSeverity.debug, text: 'DEBUG' }
  }
  return { number: TraceSeverity.trace, text: 'TRACE' }
}

/**
 * Log-record fields as attributes, the way every logger line carries them: flattened to dotted
 * leaves (objects 3 levels deep, deeper ones / arrays of objects a JSON string, values ≤ 8 KiB),
 * a leaf whose key the backends reserve ({@link isReservedLogKey}) or that `taken` holds (the
 * record's own attributes, e.g. `exception.*`) moved to `ozaco.data.<key>`; the first 64 leaves
 * stay attributes, the rest become ONE JSON object string under `ozaco.log.data` (≤ 8 KiB).
 */
export const logAttributes = (
  fields: TraceDef.AttributesInput,
  taken: ReadonlySet<string> = new Set(),
): Record<string, TraceDef.AttrValue> => {
  const { attributes: leaves } = toAttributes(fields, {
    maxBytes: VALUE_BYTES,
    maxCount: Number.POSITIVE_INFINITY,
  })

  const kept = new Map<string, TraceDef.AttrValue>()
  const overflow = new Map<string, TraceDef.AttrValue>()

  for (const [leaf, value] of Object.entries(leaves)) {
    const key = isReservedLogKey(leaf) || taken.has(leaf) ? `${PROTECTED_PREFIX}${leaf}` : leaf

    if (kept.has(key) || kept.size < MAX_LEAVES) {
      kept.set(key, value)
    } else {
      overflow.set(key, value)
    }
  }

  if (overflow.size > 0) {
    const { attributes } = toAttributes(
      { [OVERFLOW_KEY]: JSON.stringify(Object.fromEntries(overflow)) },
      { maxBytes: VALUE_BYTES },
    )
    kept.set(OVERFLOW_KEY, attributes[OVERFLOW_KEY] ?? '')
  }

  return Object.fromEntries(kept)
}
