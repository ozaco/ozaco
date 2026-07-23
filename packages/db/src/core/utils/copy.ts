import type { AnyType } from 'std:shared'

/**
 * PostgreSQL binary COPY encoding — the pure core behind `copyFromBinary`. Produces the byte stream
 * for `COPY ... FROM STDIN WITH (FORMAT binary)`: an 11-byte signature + flags/extension header, then
 * one record per tuple (int16 field count, each field length-prefixed), then the `-1` trailer.
 *
 * Supported column types (Postgres type names): `bool`, `int2`, `int4`, `int8`, `float4`, `float8`,
 * `text`, `varchar`, `bpchar`, `json`, `jsonb`, `bytea`, `uuid`, `date`, `timestamp`, `timestamptz`.
 * `null`/`undefined` encode as SQL NULL. An unsupported type, or a tuple of the wrong width, throws
 * (the caller runs this inside `call(...)`, so the throw surfaces as a Result failure).
 */

const SIGNATURE = Uint8Array.from([
  0x50, 0x47, 0x43, 0x4f, 0x50, 0x59, 0x0a, 0xff, 0x0d, 0x0a, 0x00,
])

// Postgres date/time epoch: 2000-01-01T00:00:00Z, expressed in unix milliseconds.
const PG_EPOCH_MS = 946_684_800_000
const MS_PER_DAY = 86_400_000

const int16 = (value: number): Buffer => {
  const buffer = Buffer.allocUnsafe(2)
  buffer.writeInt16BE(value)
  return buffer
}
const int32 = (value: number): Buffer => {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeInt32BE(value)
  return buffer
}
const int64 = (value: bigint): Buffer => {
  const buffer = Buffer.allocUnsafe(8)
  buffer.writeBigInt64BE(value)
  return buffer
}
const float32 = (value: number): Buffer => {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeFloatBE(value)
  return buffer
}
const float64 = (value: number): Buffer => {
  const buffer = Buffer.allocUnsafe(8)
  buffer.writeDoubleBE(value)
  return buffer
}

const asEpochMs = (value: unknown): number =>
  value instanceof Date ? value.getTime() : new Date(String(value)).getTime()

/** Encode ONE field to its binary body (without the length prefix); `null` marks a SQL NULL. */
const encodeField = (type: string, value: unknown): Buffer | null => {
  if (value === null || value === undefined) {
    return null
  }
  switch (type) {
    case 'bool': {
      return Buffer.from([value ? 1 : 0])
    }
    case 'int2': {
      return int16(Number(value))
    }
    case 'int4': {
      return int32(Number(value))
    }
    case 'int8': {
      return int64(BigInt(value as AnyType))
    }
    case 'float4': {
      return float32(Number(value))
    }
    case 'float8': {
      return float64(Number(value))
    }
    case 'text':
    case 'varchar':
    case 'bpchar': {
      return Buffer.from(String(value), 'utf8')
    }
    case 'json': {
      return Buffer.from(JSON.stringify(value), 'utf8')
    }
    case 'jsonb': {
      return Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(value), 'utf8')])
    }
    case 'bytea': {
      return Buffer.from(value as Uint8Array)
    }
    case 'uuid': {
      return Buffer.from(String(value).replaceAll('-', ''), 'hex')
    }
    case 'date': {
      return int32(Math.floor((asEpochMs(value) - PG_EPOCH_MS) / MS_PER_DAY))
    }
    case 'timestamp':
    case 'timestamptz': {
      return int64(BigInt(asEpochMs(value) - PG_EPOCH_MS) * 1000n)
    }
    default: {
      throw new Error(`copyFromBinary: unsupported column type "${type}"`)
    }
  }
}

/** Encode `tuples` into a single Postgres binary-COPY payload, one field per entry of `columnTypes`. */
export const encodeCopyBinary = (
  tuples: ReadonlyArray<readonly unknown[]>,
  columnTypes: readonly string[],
): Uint8Array => {
  const chunks: Buffer[] = [Buffer.from(SIGNATURE), int32(0), int32(0)]
  for (const tuple of tuples) {
    if (tuple.length !== columnTypes.length) {
      throw new Error(
        `copyFromBinary: tuple has ${tuple.length} field(s), expected ${columnTypes.length}`,
      )
    }
    chunks.push(int16(tuple.length))
    for (const [index, type] of columnTypes.entries()) {
      const data = encodeField(type, tuple[index])
      if (data === null) {
        chunks.push(int32(-1))
      } else {
        chunks.push(int32(data.length), data)
      }
    }
  }
  chunks.push(int16(-1))
  return Buffer.concat(chunks)
}
