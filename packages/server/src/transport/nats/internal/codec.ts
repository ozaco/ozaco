import type { Result } from 'std:result'
import { fail, isFailure, succeed } from 'std:result'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface Wire {
  value?: unknown
  error?: unknown
  message?: string
  causes?: string[]
}

export const encodeBody = (value: unknown): Uint8Array =>
  encoder.encode(JSON.stringify(value ?? ''))

export const decodeBody = (data: Uint8Array): unknown => {
  if (data.length === 0) {
    return undefined
  }
  return JSON.parse(decoder.decode(data)) as unknown
}

export const encodeResult = (result: Result<unknown, unknown>): Uint8Array => {
  if (isFailure(result)) {
    return encoder.encode(
      JSON.stringify({
        error: result.error,
        message: result.message,
        causes: result.causes,
      } satisfies Wire),
    )
  }
  return encoder.encode(
    JSON.stringify({
      value: result.value,
    } satisfies Wire),
  )
}

export const decodeResult = (data: Uint8Array): Result<unknown, unknown> => {
  if (data.length === 0) {
    return succeed(undefined)
  }
  const wire = JSON.parse(decoder.decode(data)) as Wire
  if (wire.value) {
    return succeed(wire.value)
  }
  return fail(wire.error, wire.message ?? '', ...(wire.causes ?? []))
}
