// oxlint-disable import/exports-last
import { CodecErrors } from 'std:codec'
import { attempt, operation } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { DbErrors } from '../errors'

export interface CursorPayload {
  readonly column: string
  readonly direction: 'asc' | 'desc'
  readonly value: unknown
  readonly id: string
}

interface WireValue {
  readonly $date: string
}

const isWireDate = (value: unknown): value is WireValue =>
  typeof value === 'object' && value !== null && typeof (value as WireValue).$date === 'string'

const malformed = operation(function* () {
  return yield* fail(DbErrors.Cursor, 'malformed pagination cursor')
})

/** Encode a keyset cursor as an opaque base64 token. `Date` boundary values survive the round trip
 * via a `$date` marker. */
export const encodeCursor = operation(function* (payload: CursorPayload) {
  const value =
    payload.value instanceof Date ? { $date: payload.value.toISOString() } : payload.value
  const json = yield* JsonCodec.actions.stringify({ ...payload, value })
  return btoa(encodeURIComponent(json))
})

/** Decode a cursor token; fails `db.cursor` on garbage instead of throwing. */
export const decodeCursor = operation(function* (cursor: string) {
  const text = yield* attempt(function* () {
    return decodeURIComponent(atob(cursor))
  })
  if (isFailure(text)) {
    return yield* malformed()
  }
  const decoded = yield* attempt(() => JsonCodec.actions.parse<CursorPayload>(text.value))
  if (isFailure(decoded)) {
    // only unreadable JSON is the caller's fault — a missing JsonCodec install must surface as
    // itself instead of being reported as a bad cursor
    return decoded.error === CodecErrors.Parse ? yield* malformed() : yield* decoded
  }
  const parsed = decoded.value
  if (typeof parsed?.column !== 'string' || typeof parsed.id !== 'string') {
    return yield* malformed()
  }
  const value = isWireDate(parsed.value) ? new Date(parsed.value.$date) : parsed.value
  return { ...parsed, value } as CursorPayload
})
