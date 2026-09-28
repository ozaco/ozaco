import type { Operation } from 'std:effect'
import type { TraceDef } from 'std:trace'
import { Trace, TraceSeverity } from 'std:trace'

import { LogLevel } from '../../const'
import { MAX_LEAVES, OVERFLOW_KEY, PROTECTED_PREFIX, VALUE_BYTES } from '../../internal/const'
import { isReservedLogKey } from '../../internal/keys'

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
 * a leaf whose key the backends reserve ({@link isReservedLogKey}) moved to `ozaco.data.<key>`;
 * the first 64 leaves stay attributes, the rest become ONE JSON object string under
 * `ozaco.log.data` (≤ 8 KiB).
 */
export function* logAttributes(
  fields: TraceDef.AttributesInput,
): Operation<Record<string, TraceDef.AttrValue>> {
  const { attributes: leaves } = yield* Trace.actions.toAttributes(fields, {
    maxBytes: VALUE_BYTES,
    maxCount: Number.POSITIVE_INFINITY,
  })

  const kept = new Map<string, TraceDef.AttrValue>()
  const overflow = new Map<string, TraceDef.AttrValue>()

  for (const [leaf, value] of Object.entries(leaves)) {
    const key = isReservedLogKey(leaf) ? `${PROTECTED_PREFIX}${leaf}` : leaf

    if (kept.has(key) || kept.size < MAX_LEAVES) {
      kept.set(key, value)
    } else {
      overflow.set(key, value)
    }
  }

  if (overflow.size > 0) {
    const { attributes } = yield* Trace.actions.toAttributes(
      { [OVERFLOW_KEY]: JSON.stringify(Object.fromEntries(overflow)) },
      { maxBytes: VALUE_BYTES },
    )

    kept.set(OVERFLOW_KEY, attributes[OVERFLOW_KEY] ?? '')
  }

  return Object.fromEntries(kept)
}
