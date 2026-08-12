import type { CodecDef } from 'std:codec'
import { Codec } from 'std:codec'
import { attempt, operation } from 'std:effect'
import { isSuccess } from 'std:result'

// Frame (de)serialization — the client mirror of the server gateway's `encodeWsBody`/`parseWsPayload`,
// routed through the registered `std:codec` (JSON by default) instead of a hardcoded serializer, so a
// consumer that installs a different codec gets it here too. A `preferred` codec impl pins the
// dispatch to that implementation instead of the protocol's priority routing (it must still be
// installed in scope). Strings and binary pass through untouched; every other value is
// codec-encoded to a text frame on send. On receive, a text frame that looks structured (`{`/`[`)
// is codec-parsed (degrading to the raw string on a parse failure, like the gateway), everything
// else is handed through as-is. A codec must be registered in scope.

export const encodeFrame = operation(function* (data: unknown, preferred?: CodecDef) {
  if (typeof data === 'string') {
    return data
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return data
  }
  return yield* (preferred ?? Codec).actions.stringify(data)
})

export const decodeFrame = operation(function* (data: unknown, preferred?: CodecDef) {
  if (typeof data !== 'string') {
    return data
  }
  const trimmed = data.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = yield* attempt((preferred ?? Codec).actions.parse(data))
    return isSuccess(parsed) ? parsed.value : data
  }
  return data
})
