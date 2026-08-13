// oxlint-disable import/exports-last
import { operation } from 'std:effect'
import { fail } from 'std:result'

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

/** Encode a keyset cursor as an opaque base64 token. `Date` boundary values survive the round trip
 * via a `$date` marker. */
export const encodeCursor = (payload: CursorPayload): string => {
  const value =
    payload.value instanceof Date ? { $date: payload.value.toISOString() } : payload.value
  return btoa(encodeURIComponent(JSON.stringify({ ...payload, value })))
}

/** Decode a cursor token; fails `db.cursor` on garbage instead of throwing. */
export const decodeCursor = operation(function* (cursor: string) {
  try {
    const parsed = JSON.parse(decodeURIComponent(atob(cursor))) as CursorPayload
    if (typeof parsed.column !== 'string' || typeof parsed.id !== 'string') {
      return yield* fail(DbErrors.Cursor, 'malformed pagination cursor')
    }
    const value = isWireDate(parsed.value) ? new Date(parsed.value.$date) : parsed.value
    return { ...parsed, value } as CursorPayload
  } catch {
    return yield* fail(DbErrors.Cursor, 'malformed pagination cursor')
  }
})
