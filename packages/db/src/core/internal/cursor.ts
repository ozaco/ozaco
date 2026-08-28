import { CodecErrors } from 'std:codec'
import { attempt } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { DbErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { Spec } from '../types/spec'

const isWireDate = (value: unknown): value is Helpers.WireDate =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Helpers.WireDate).$date === 'string'

function* malformed() {
  return yield* fail(DbErrors.Cursor, 'malformed pagination cursor')
}

/** Encode a keyset cursor as an opaque base64 token — one entry per sort key. `Date` boundary
 * values survive the round trip via a `$date` marker. */
export function* encodeCursor(cursor: Spec.Cursor) {
  const keys = cursor.keys.map(key => ({
    field: key.field,
    direction: key.direction,
    value: key.value instanceof Date ? { $date: key.value.toISOString() } : key.value,
  }))
  const json = yield* JsonCodec.actions.stringify({ keys })

  return btoa(encodeURIComponent(json))
}

/** Decode a cursor token; fails `db.cursor` on garbage instead of throwing. */
export function* decodeCursor(token: string) {
  const text = yield* attempt(function* () {
    return decodeURIComponent(atob(token))
  })

  if (isFailure(text)) {
    return yield* malformed()
  }

  const decoded = yield* attempt(() => JsonCodec.actions.parse<Spec.Cursor>(text.value))

  if (isFailure(decoded)) {
    // only unreadable JSON is the caller's fault — a missing JsonCodec install must surface as
    // itself instead of being reported as a bad cursor
    return decoded.error === CodecErrors.Parse ? yield* malformed() : yield* decoded
  }

  const parsed = decoded.value

  if (!Array.isArray(parsed?.keys) || parsed.keys.length === 0) {
    return yield* malformed()
  }

  const keys = parsed.keys.map(key => {
    if (typeof key?.field !== 'string' || (key.direction !== 'asc' && key.direction !== 'desc')) {
      return null
    }

    return {
      field: key.field,
      direction: key.direction,
      value: isWireDate(key.value) ? new Date(key.value.$date) : key.value,
    }
  })

  if (keys.some(key => key === null)) {
    return yield* malformed()
  }

  return { keys } as Spec.Cursor
}
