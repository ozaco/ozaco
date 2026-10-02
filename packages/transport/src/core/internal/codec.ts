import { Codec } from 'std:codec'
import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import type { Result } from 'std:result'
import { appendCauses, fail, isFailure } from 'std:result'
import { Trace } from 'std:trace'

import { HEADERS, KINDS } from '../const'
import { TransportErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { TransportDef } from '../types/transport'

const EMPTY = new Uint8Array(0)

function* noop() {}

const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/** A wire origin read back — only the fields it may carry, each of its own type (the other side
 * is a peer, not a source of arbitrary shapes). */
const originOf = (value: unknown): TransportDef.Origin | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const { service, operation, spanId, traceId, flags, recorded } = value as Record<string, unknown>

  return {
    service: textOf(service),
    operation: textOf(operation),
    spanId: textOf(spanId),
    traceId: textOf(traceId),
    flags: typeof flags === 'number' ? flags : undefined,
    recorded: recorded === true,
  }
}

/** The cause an origin adds to the failure it came with: `remote: <operation> @ <service> span
 * <spanId first 8>`, the parts it names (nothing when it names none). */
const remoteOf = (origin: TransportDef.Origin): string | undefined => {
  const parts = [
    origin.operation,
    origin.service === undefined ? undefined : `@ ${origin.service}`,
    origin.spanId === undefined ? undefined : `span ${origin.spanId.slice(0, 8)}`,
  ].filter(part => part !== undefined)

  return parts.length === 0 ? undefined : `remote: ${parts.join(' ')}`
}

/** The trace a failure the other side recorded belongs to: the one it names, else the caller's
 * active one. */
function* recordedIn(origin: TransportDef.Origin): Operation<string | undefined> {
  if (origin.traceId !== undefined) {
    return origin.traceId
  }

  const context = yield* Trace.actions.activeContext()

  return context?.traceId
}

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
    return yield* fail(TransportErrors.Encoding, 'cannot encode value', encoded)
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
    return yield* fail(TransportErrors.Encoding, `cannot decode message on "${raw.topic}"`, decoded)
  }

  return decoded.value
}

/**
 * A failure as bytes: {@link Helpers.WireFailure} — its tag, message and causes (the routed
 * codec — JsonCodec — carries its nested failures as `{ error, message, causes }`; a fold's `raw`
 * never leaves the process; peers on one transport are trusted) and, for a reply, `origin`: where
 * it was answered.
 */
export function* encodeFailure(
  failure: Result.Failure<unknown>,
  origin?: TransportDef.Origin,
): Operation<Uint8Array> {
  const wire: Helpers.WireFailure = {
    error: failure.error,
    message: failure.message,
    causes: failure.causes,
    ...(origin === undefined ? {} : { origin }),
  }

  return (yield* encodeValue(wire)).data
}

/**
 * Rebuild a failure from its wire form — re-raised by the caller with `yield*`: its tag, message
 * and causes, its nested failures as real Failures (a remote fold is `std:result.unknown` and its
 * message, nothing more — no `raw`). A reply's origin adds the `remote: <operation> @ <service>
 * span <id8>` cause; a failure the other side RECORDED is marked recorded (remotely) in that trace
 * right here, so no span or log on this side records it a second time. An older peer's wire — the
 * Failure itself, JSON-encoded as `{ error, message, causes, _d }` — decodes the same way.
 */
export function* decodeFailure(raw: TransportDef.Raw): Operation<Result.Failure<unknown>> {
  const wire = yield* decodeValue<unknown>(raw)

  if (typeof wire !== 'object' || wire === null) {
    return fail(TransportErrors.Encoding, `malformed failure on "${raw.topic}"`)
  }

  const { error, message, causes, origin } = wire as Record<keyof Helpers.WireFailure, unknown>
  const failure = fail(
    error,
    typeof message === 'string' ? message : '',
    ...(Array.isArray(causes)
      ? causes.filter(cause => typeof cause === 'string' || isFailure(cause))
      : []),
  )

  const from = originOf(origin)

  if (from === undefined) {
    return failure
  }

  appendCauses(failure, remoteOf(from))

  if (from.recorded) {
    const traceId = yield* recordedIn(from)

    if (traceId !== undefined) {
      yield* Trace.actions.markRecorded(failure, traceId, {
        remote: true,
        spanId: from.spanId,
        flags: from.flags,
      })
    }
  }

  return failure
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
