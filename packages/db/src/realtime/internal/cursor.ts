// oxlint-disable import/exports-last
import { attempt, operation } from 'std:effect'
import { isSuccess } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

interface Cursor {
  readonly value: unknown
  readonly id: string
  readonly column: string
  readonly direction: 'asc' | 'desc'
}

// cursors serialize through the installed codec (no hand-rolled JSON), base64url-wrapped to stay opaque
export const encodeCursor = operation(function* (cursor: Cursor) {
  const text = yield* JsonCodec.actions.stringify(cursor)
  return Buffer.from(text).toString('base64url')
})

export const decodeCursor = operation(function* (raw: string) {
  const text = Buffer.from(raw, 'base64url').toString('utf8')
  const parsed = yield* attempt(JsonCodec.actions.parse<Cursor>(text))
  return isSuccess(parsed) ? parsed.value : null
})
