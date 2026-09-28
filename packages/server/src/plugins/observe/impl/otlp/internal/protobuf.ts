// oxlint-disable import/exports-last
import type { TraceDef } from 'std:trace'

import type { Helpers } from '../types/helpers'

import { CUMULATIVE, SPAN_KINDS, STATUS_ERROR } from './const'
import { isInt64, nanosOf, spanFlags } from './values'

/**
 * A dependency-free protobuf WRITER for the OTLP `Export*ServiceRequest` messages
 * (opentelemetry-proto v1): varints, fixed32/64, doubles, strings, bytes and nested messages,
 * little-endian as the wire format wants. Field numbers follow `trace.proto`, `logs.proto`,
 * `metrics.proto`, `common.proto` and `resource.proto`; proto3 defaults are skipped except inside
 * a `oneof` (an `AnyValue` / a data point's value is always written).
 */

const WIRE_VARINT = 0
const WIRE_FIXED64 = 1
const WIRE_LENGTH = 2
const WIRE_FIXED32 = 5

const UTF8 = new TextEncoder()

const createWriter = (): Helpers.ProtoWriter => {
  let buffer = new Uint8Array(256)
  let view = new DataView(buffer.buffer)
  let length = 0

  const reserve = (bytes: number) => {
    if (length + bytes <= buffer.length) {
      return
    }

    let size = buffer.length * 2

    while (size < length + bytes) {
      size *= 2
    }

    const grown = new Uint8Array(size)

    grown.set(buffer.subarray(0, length))
    buffer = grown
    view = new DataView(buffer.buffer)
  }

  /** An unsigned varint of a non-negative safe integer. */
  const rawVarint = (value: number) => {
    reserve(10)

    let rest = value

    while (rest > 0x7f) {
      buffer[length] = (rest % 0x80) | 0x80
      length += 1
      rest = Math.floor(rest / 0x80)
    }

    buffer[length] = rest
    length += 1
  }

  /** An unsigned varint of a 64-bit two's complement value (a negative int64 takes 10 bytes). */
  const rawVarint64 = (value: bigint) => {
    reserve(10)

    let rest = BigInt.asUintN(64, value)

    while (rest > 0x7fn) {
      buffer[length] = Number(rest & 0x7fn) | 0x80
      length += 1
      rest >>= 7n
    }

    buffer[length] = Number(rest)
    length += 1
  }

  const tag = (field: number, wire: number) => rawVarint(field * 8 + wire)

  const rawBytes = (bytes: Uint8Array) => {
    reserve(bytes.length)
    buffer.set(bytes, length)
    length += bytes.length
  }

  const writer: Helpers.ProtoWriter = {
    varint(field, value) {
      tag(field, WIRE_VARINT)
      rawVarint(value)
    },
    int64(field, value) {
      tag(field, WIRE_VARINT)

      if (Number.isSafeInteger(value) && value >= 0) {
        rawVarint(value)
      } else {
        rawVarint64(BigInt(value))
      }
    },
    fixed64(field, value) {
      tag(field, WIRE_FIXED64)
      reserve(8)
      view.setBigUint64(length, BigInt.asUintN(64, value), true)
      length += 8
    },
    sfixed64(field, value) {
      tag(field, WIRE_FIXED64)
      reserve(8)
      view.setBigInt64(length, BigInt(value), true)
      length += 8
    },
    fixed32(field, value) {
      tag(field, WIRE_FIXED32)
      reserve(4)
      view.setUint32(length, value >>> 0, true)
      length += 4
    },
    double(field, value) {
      tag(field, WIRE_FIXED64)
      reserve(8)
      view.setFloat64(length, value, true)
      length += 8
    },
    string(field, value) {
      writer.bytes(field, UTF8.encode(value))
    },
    bytes(field, value) {
      tag(field, WIRE_LENGTH)
      rawVarint(value.length)
      rawBytes(value)
    },
    message(field, build) {
      const child = createWriter()

      build(child)
      writer.bytes(field, child.finish())
    },
    packedFixed64(field, values) {
      tag(field, WIRE_LENGTH)
      rawVarint(values.length * 8)
      reserve(values.length * 8)

      for (const value of values) {
        view.setBigUint64(length, BigInt(value), true)
        length += 8
      }
    },
    packedDouble(field, values) {
      tag(field, WIRE_LENGTH)
      rawVarint(values.length * 8)
      reserve(values.length * 8)

      for (const value of values) {
        view.setFloat64(length, value, true)
        length += 8
      }
    },
    finish: () => buffer.slice(0, length),
  }

  return writer
}

/** A lowercase hex id as its bytes. */
const idBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length >> 1)

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }

  return bytes
}

// --- common.proto / resource.proto -------------------------------------------------------------

/** `AnyValue`: string 1, bool 2, int 3, double 4, array 5 (ALWAYS written — it is a oneof). */
const anyValue = (writer: Helpers.ProtoWriter, value: TraceDef.AttrValue): void => {
  if (typeof value === 'string') {
    writer.string(1, value)
  } else if (typeof value === 'boolean') {
    writer.varint(2, value ? 1 : 0)
  } else if (typeof value === 'number') {
    if (isInt64(value)) {
      writer.int64(3, value)
    } else {
      writer.double(4, value)
    }
  } else {
    // ArrayValue { repeated AnyValue values = 1 }
    writer.message(5, array => {
      for (const item of value as readonly (string | number | boolean)[]) {
        array.message(1, element => anyValue(element, item))
      }
    })
  }
}

/** `repeated KeyValue` (key 1, value 2) under `field`. */
const attributes = (
  writer: Helpers.ProtoWriter,
  field: number,
  record: TraceDef.Attributes | undefined,
): void => {
  for (const [key, value] of Object.entries(record ?? {})) {
    writer.message(field, pair => {
      pair.string(1, key)
      pair.message(2, inner => anyValue(inner, value))
    })
  }
}

const count = (writer: Helpers.ProtoWriter, field: number, value: number | undefined) => {
  if (value !== undefined && value > 0) {
    writer.varint(field, value)
  }
}

/** A resource block: `Resource` 1, the scope blocks under `scopeField`, each `{ scope 1,
 * items 2 }`. */
const resourceBlock = <T>(
  writer: Helpers.ProtoWriter,
  group: Helpers.ResourceGroup<T>,
  item: (writer: Helpers.ProtoWriter, value: T) => void,
): void => {
  writer.message(1, resource => attributes(resource, 1, group.resource))

  for (const { scope, items } of group.scopes) {
    writer.message(2, block => {
      block.message(1, head => {
        if (scope.name) {
          head.string(1, scope.name)
        }

        if (scope.version) {
          head.string(2, scope.version)
        }
      })

      for (const value of items) {
        block.message(2, inner => item(inner, value))
      }
    })
  }
}

const request = <T>(
  groups: readonly Helpers.ResourceGroup<T>[],
  item: (writer: Helpers.ProtoWriter, value: T) => void,
): Uint8Array => {
  const writer = createWriter()

  for (const group of groups) {
    writer.message(1, block => resourceBlock(block, group, item))
  }

  return writer.finish()
}

// --- trace.proto ---------------------------------------------------------------------------------

const span = (writer: Helpers.ProtoWriter, data: TraceDef.SpanData): void => {
  writer.bytes(1, idBytes(data.context.traceId))
  writer.bytes(2, idBytes(data.context.spanId))

  if (data.context.state) {
    writer.string(3, data.context.state)
  }

  if (data.parent) {
    writer.bytes(4, idBytes(data.parent.spanId))
  }

  writer.string(5, data.name)
  writer.varint(6, SPAN_KINDS[data.kind])
  writer.fixed64(7, nanosOf(data.start))
  writer.fixed64(8, nanosOf(data.end))
  attributes(writer, 9, data.attributes)
  count(writer, 10, data.droppedAttributes)

  for (const event of data.events) {
    writer.message(11, inner => {
      inner.fixed64(1, nanosOf(event.time))
      inner.string(2, event.name)
      attributes(inner, 3, event.attributes)
      count(inner, 4, event.droppedAttributes)
    })
  }

  count(writer, 12, data.droppedEvents)

  for (const link of data.links) {
    writer.message(13, inner => {
      inner.bytes(1, idBytes(link.context.traceId))
      inner.bytes(2, idBytes(link.context.spanId))

      if (link.context.state) {
        inner.string(3, link.context.state)
      }

      attributes(inner, 4, link.attributes)
      count(inner, 5, link.droppedAttributes)
      inner.fixed32(6, spanFlags(link.context.flags, link.context.remote))
    })
  }

  count(writer, 14, data.droppedLinks)

  if (data.status.code === 'error') {
    writer.message(15, status => {
      if (data.status.message) {
        status.string(2, data.status.message)
      }

      status.varint(3, STATUS_ERROR)
    })
  }

  writer.fixed32(16, spanFlags(data.context.flags, data.parent?.remote))
}

// --- logs.proto ----------------------------------------------------------------------------------

const logRecord = (writer: Helpers.ProtoWriter, log: TraceDef.LogData): void => {
  writer.fixed64(1, nanosOf(log.time))

  if (log.severityNumber > 0) {
    writer.varint(2, log.severityNumber)
  }

  if (log.severityText) {
    writer.string(3, log.severityText)
  }

  writer.message(5, body => anyValue(body, log.body))
  attributes(writer, 6, log.attributes)
  count(writer, 7, log.droppedAttributes)

  if (log.context) {
    const flags = log.context.flags & 0xff

    if (flags !== 0) {
      writer.fixed32(8, flags)
    }

    writer.bytes(9, idBytes(log.context.traceId))
    writer.bytes(10, idBytes(log.context.spanId))
  }

  writer.fixed64(11, nanosOf(log.observedTime))

  if (log.eventName) {
    writer.string(12, log.eventName)
  }
}

// --- metrics.proto -------------------------------------------------------------------------------

const numberPoint = (writer: Helpers.ProtoWriter, point: Helpers.NumberPoint): void => {
  writer.fixed64(2, nanosOf(point.start))
  writer.fixed64(3, nanosOf(point.time))

  if (isInt64(point.value)) {
    writer.sfixed64(6, point.value)
  } else {
    writer.double(4, point.value)
  }

  attributes(writer, 7, point.attributes)
}

const histogramPoint = (writer: Helpers.ProtoWriter, point: Helpers.HistogramPoint): void => {
  writer.fixed64(2, nanosOf(point.start))
  writer.fixed64(3, nanosOf(point.time))
  writer.fixed64(4, BigInt(point.count))
  writer.double(5, point.sum)
  writer.packedFixed64(6, point.bucketCounts)
  writer.packedDouble(7, point.bounds)
  attributes(writer, 9, point.attributes)
  writer.double(11, point.min)
  writer.double(12, point.max)
}

const metric = (writer: Helpers.ProtoWriter, data: Helpers.Metric): void => {
  writer.string(1, data.name)

  if (data.description) {
    writer.string(2, data.description)
  }

  if (data.unit) {
    writer.string(3, data.unit)
  }

  if (data.kind === 'gauge') {
    writer.message(5, gauge => {
      for (const point of data.points) {
        gauge.message(1, inner => numberPoint(inner, point))
      }
    })
  } else if (data.kind === 'sum') {
    writer.message(7, sum => {
      for (const point of data.points) {
        sum.message(1, inner => numberPoint(inner, point))
      }

      sum.varint(2, CUMULATIVE)

      if (data.monotonic) {
        sum.varint(3, 1)
      }
    })
  } else {
    writer.message(9, histogram => {
      for (const point of data.points) {
        histogram.message(1, inner => histogramPoint(inner, point))
      }

      histogram.varint(2, CUMULATIVE)
    })
  }
}

// --- the requests --------------------------------------------------------------------------------

/** `ExportTraceServiceRequest` as protobuf. */
export const protobufTraces = (groups: readonly Helpers.ResourceGroup<TraceDef.SpanData>[]) =>
  request(groups, span)

/** `ExportLogsServiceRequest` as protobuf. */
export const protobufLogs = (groups: readonly Helpers.ResourceGroup<TraceDef.LogData>[]) =>
  request(groups, logRecord)

/** `ExportMetricsServiceRequest` as protobuf. */
export const protobufMetrics = (groups: readonly Helpers.ResourceGroup<Helpers.Metric>[]) =>
  request(groups, metric)

// --- the answers ---------------------------------------------------------------------------------

/** A protobuf READER over one message — just enough for `Export*ServiceResponse`: each field
 * goes to `onField`; `false` when the message is malformed (a truncated varint, an unsupported
 * wire type) or `onField` answered `false` for a field it could not read. */
const readFields = (
  bytes: Uint8Array,
  onField: (field: number, value: bigint | Uint8Array) => boolean,
): boolean => {
  let at = 0

  /** The next varint — `null` when it runs past the end (or beyond 64 bits). */
  const varint = (): bigint | null => {
    let value = 0n
    let shift = 0n

    for (;;) {
      const byte = bytes[at]

      if (byte === undefined || shift > 63n) {
        return null
      }

      at += 1
      value |= BigInt(byte & 0x7f) << shift
      shift += 7n

      if ((byte & 0x80) === 0) {
        return value
      }
    }
  }

  while (at < bytes.length) {
    const tag = varint()

    if (tag === null) {
      return false
    }

    const key = Number(tag)
    const field = key >>> 3
    const wire = key & 7

    if (wire === WIRE_VARINT) {
      const value = varint()

      if (value === null || !onField(field, value)) {
        return false
      }
    } else if (wire === WIRE_LENGTH) {
      const size = varint()

      if (size === null || !onField(field, bytes.subarray(at, at + Number(size)))) {
        return false
      }

      at += Number(size)
    } else if (wire === WIRE_FIXED64) {
      at += 8
    } else if (wire === WIRE_FIXED32) {
      at += 4
    } else {
      return false
    }
  }

  return true
}

/**
 * The `partial_success` of a protobuf `Export*ServiceResponse` (`{ rejected 1, error_message 2 }`
 * under field 1); a malformed answer reads as fully accepted.
 */
export const protobufPartial = (bytes: Uint8Array): Helpers.Delivery => {
  let rejected = 0
  let message: string | null = null

  const read = readFields(bytes, (field, value) => {
    if (field !== 1 || !(value instanceof Uint8Array)) {
      return true
    }

    return readFields(value, (inner, content) => {
      if (inner === 1 && typeof content === 'bigint') {
        rejected = Number(BigInt.asIntN(64, content))
      } else if (inner === 2 && content instanceof Uint8Array) {
        message = new TextDecoder().decode(content) || null
      }

      return true
    })
  })

  return read ? { rejected, message } : { rejected: 0, message: null }
}
