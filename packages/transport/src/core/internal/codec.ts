import { Codec } from 'std:codec'
import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'

import { HEADERS, KINDS } from '../const'
import { TransportErrors } from '../errors'
import type { TransportDef } from '../types/transport'

const EMPTY = new Uint8Array(0)

function* noop() {}

/** An empty payload (credit frames, end frames without a close value). */
export const empty = (): Uint8Array => EMPTY

/** Encode a value for the wire: `Uint8Array` travels raw (`oz-kind: bytes`), anything else goes
 * through the routed codec (`oz-kind: value`). */
export function* encodeValue(value: unknown, headers: TransportDef.Headers = {}) {
  if (value instanceof Uint8Array) {
    return { data: value, headers: { ...headers, [HEADERS.kind]: KINDS.bytes } }
  }

  const encoded = yield* attempt(() => Codec.actions.encode(value))

  if (isFailure(encoded)) {
    return yield* fail(TransportErrors.Encoding, 'cannot encode value', String(encoded.error))
  }

  return { data: encoded.value, headers: { ...headers, [HEADERS.kind]: KINDS.value } }
}

/** The inverse of {@link encodeValue}: raw bytes stay bytes, codec payloads decode to `T`. */
export function* decodeValue<T>(raw: TransportDef.Raw) {
  if (raw.headers[HEADERS.kind] === KINDS.bytes) {
    return raw.data as T
  }

  if (raw.data.length === 0) {
    return undefined as T
  }

  const decoded = yield* attempt(() => Codec.actions.decode<T>(raw.data))

  if (isFailure(decoded)) {
    return yield* fail(
      TransportErrors.Encoding,
      `cannot decode message on "${raw.topic}"`,
      String(decoded.error),
    )
  }

  return decoded.value
}

/** A failure as bytes — the `Result.Failure` itself is the wire shape (its symbol members do not
 * survive the codec, `error`/`message`/`causes` do); rebuilt as a real failure on receipt. */
export function* encodeFailure(failure: Result.Failure<unknown>) {
  return (yield* encodeValue(failure)).data
}

/** Rebuild a failure from its wire form — re-raised by the caller with `yield*`. */
export function* decodeFailure(raw: TransportDef.Raw): Operation<Result.Failure<unknown>> {
  const wire = yield* decodeValue<Result.Failure<unknown>>(raw)

  return fail(wire.error as string, wire.message, ...(wire.causes ?? []))
}

/** Lift a delivered raw message to a typed {@link TransportDef.Message}. */
export function* toMessage<T>(raw: TransportDef.Raw) {
  const value = yield* decodeValue<T>(raw)

  return {
    topic: raw.topic,
    value,
    headers: raw.headers,
    seq: raw.seq,
    ack: raw.ack ?? noop,
    nak: raw.nak ?? noop,
  } satisfies TransportDef.Message<T>
}
