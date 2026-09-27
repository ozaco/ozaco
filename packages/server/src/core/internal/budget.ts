import type { TraceDef } from 'std:trace'

import { LOG_MAX_ATTRIBUTE_BYTES, LOG_MAX_ATTRIBUTES } from '../const'

/** The UTF-8 length of a string without encoding it. */
const utf8Length = (text: string): number => {
  let bytes = 0

  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) ?? 0

    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x8_00) {
      bytes += 2
    } else if (code < 0x1_00_00) {
      bytes += 3
    } else {
      // outside the BMP: ONE 4-byte code point over a surrogate pair
      bytes += 4
      index += 1
    }
  }

  return bytes
}

/** What an attribute weighs on the wire (its key + its value), roughly as OTLP carries it. */
const attributeBytes = (key: string, value: TraceDef.AttrValue): number => {
  const weigh = (item: string | number | boolean): number =>
    typeof item === 'string' ? utf8Length(item) : typeof item === 'number' ? 8 : 1

  if (Array.isArray(value)) {
    let bytes = utf8Length(key)

    for (const item of value as readonly (string | number | boolean)[]) {
      bytes += weigh(item)
    }

    return bytes
  }

  return utf8Length(key) + weigh(value as string | number | boolean)
}

/** Keys a budget cut spares while anything else is left to drop: what makes a record an
 * exception / a named event. */
const isProtected = (key: string): boolean =>
  key.startsWith('exception.') || key.startsWith('ozaco.failure.') || key === 'otel.event.name'

/**
 * One log record with its attributes cut to what every log backend ingests (≤ 96 attributes,
 * ≤ 48 KiB of keys + values) — applied ONCE by the kernel before the fan-out, so the store,
 * stdout and every exporter hold the identical record. Over the byte budget the LARGEST values go
 * first, over the count the last ones do — unprotected keys before the exception / event keys.
 * What was cut is counted into `droppedAttributes`, on top of what std:trace's own limits dropped.
 * A record within budget is returned as it is.
 */
export const budgetLog = (log: TraceDef.LogData): TraceDef.LogData => {
  const entries = Object.entries(log.attributes)
  const sizes = entries.map(([key, value]) => attributeBytes(key, value))
  let total = sizes.reduce((sum, size) => sum + size, 0)

  if (entries.length <= LOG_MAX_ATTRIBUTES && total <= LOG_MAX_ATTRIBUTE_BYTES) {
    return log
  }

  const kept = entries.map(() => true)
  let count = entries.length

  // bytes: largest first, unprotected before protected
  const bySize = entries
    .map((entry, index) => ({ index, size: sizes[index] ?? 0, protect: isProtected(entry[0]) }))
    .toSorted((a, b) => Number(a.protect) - Number(b.protect) || b.size - a.size)

  for (const candidate of bySize) {
    if (total <= LOG_MAX_ATTRIBUTE_BYTES) {
      break
    }

    kept[candidate.index] = false
    total -= candidate.size
    count -= 1
  }

  // count: from the end, unprotected before protected
  for (const protect of [false, true]) {
    for (let index = entries.length - 1; index >= 0 && count > LOG_MAX_ATTRIBUTES; index -= 1) {
      if (kept[index] && isProtected(entries[index]![0]) === protect) {
        kept[index] = false
        count -= 1
      }
    }
  }

  const attributes: Record<string, TraceDef.AttrValue> = {}

  for (const [index, [key, value]] of entries.entries()) {
    if (kept[index]) {
      attributes[key] = value
    }
  }

  return {
    ...log,
    attributes,
    droppedAttributes: log.droppedAttributes + (entries.length - count),
  }
}
