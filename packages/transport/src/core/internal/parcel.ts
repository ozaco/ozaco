import type { Operation } from 'std:effect'
import { race, sleep } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { CHUNK_HEADER_ALLOWANCE, PARCEL_IDLE_MS, PARCEL_MIN_WAIT_MS, PARCEL_PREFIX } from '../const'
import { TransportErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { TransportDef } from '../types/transport'

import { flowLane, frameBytesOf, openProducer } from './lane'

/**
 * The parcel sideband of the package plane: a request (or reply) whose encoded payload does not
 * fit one backend message travels on a lane of its own (`$parcel.<cid>.in` / `.out`) while the
 * RPC message itself carries nothing but an `oz-parcel: <bytes>` header.
 *
 * Why not the driver's chunking (`internal/chunk.ts`), which splits any oversize publish: a
 * request is served by a competing-consumer GROUP, so the parts of one chunked request would be
 * spread over the group's members and no member would ever hold the whole thing; and a native
 * request/reply (NATS) hands the caller exactly ONE reply message, so a chunked reply loses
 * every part but the first. A parcel lane is addressed by the exchange's correlation id, so
 * both directions reach exactly the one peer that is in this exchange.
 *
 * The lane is credit-paced, so the payload crosses in bounded frames instead of one enormous
 * message, and `transient`: on a backend that persists deliveries (JetStream) a parcel stays on
 * plain pub/sub and leaves nothing behind in the stream.
 */

/** The lane wiring both sides of a parcel share. */
const setup = (timeoutMs: number, ready?: () => Operation<void>): Helpers.LaneSetup => ({
  transient: true,
  timeoutMs,
  ready,
})

/** The lane one direction of an exchange uses: `in` carries the request, `out` the reply. */
export const parcelTopic = (cid: string, direction: 'in' | 'out'): string =>
  `${PARCEL_PREFIX}${cid}.${direction}`

/** The largest payload this backend carries in ONE message — anything above it needs a parcel.
 * `null` when the backend is unbounded (nothing ever needs one). */
export function* parcelThreshold(driver: TransportDef.Driver): Operation<number | null> {
  const limit = driver.payloadLimit
    ? yield* driver.payloadLimit()
    : driver.capabilities.maxPayloadBytes

  return limit === null ? null : Math.max(1, limit - CHUNK_HEADER_ALLOWANCE)
}

/** How long to hold a parcel open for a peer that announced how long it waits: its own patience,
 * with a beat under it so a prompt peer is never cut off, and the idle window over it. */
export const waitOf = (announced: string | undefined): number => {
  const wait = Number(announced)

  return Number.isFinite(wait) && wait > 0
    ? Math.min(PARCEL_IDLE_MS, Math.max(wait, PARCEL_MIN_WAIT_MS))
    : PARCEL_IDLE_MS
}

/**
 * Send a payload over its parcel lane, frame by frame. `ready` runs once the lane is open and
 * before the first credit is awaited — that is when the other side may be told to attach (the
 * request message, or the reply that announces the parcel), so no announcement can be missed.
 */
export function* sendParcel(runtime: Helpers.Runtime, parcel: Helpers.Parcel): Operation<void> {
  const { topic, data, waitMs, ready } = parcel
  const options = setup(waitMs, ready)
  const frameBytes = yield* frameBytesOf(runtime.driver, options)
  const producer = yield* openProducer(runtime, topic, options)

  for (let offset = 0; offset < data.length; offset += frameBytes) {
    // a view, not a copy: what the payload costs is one frame at a time on the wire
    yield* producer.send(data.subarray(offset, Math.min(offset + frameBytes, data.length)))
  }

  yield* producer.end(undefined)
}

/**
 * Read a parcel whole: the frames of `topic` written into one buffer of the announced size.
 * Bounded by the pause BETWEEN frames, not by the transfer — a payload of any size may take as
 * long as it takes, a stalled one gives up after {@link PARCEL_IDLE_MS}.
 *
 * WHOLE is the point and the cost: the package plane hands a handler a decoded VALUE, so the
 * payload is materialized here (`credit * frameBytes` is what is in flight, the payload itself
 * is what is resident). A body that must NOT be materialized belongs on the stream plane —
 * `readable`/`writable`, or a branded stream in an action's input — where it is never assembled
 * at all.
 */
export function* readParcel(
  runtime: Helpers.Runtime,
  topic: string,
  size: number,
): Operation<Uint8Array> {
  const subscription = yield* flowLane<Uint8Array, unknown>(runtime, topic, setup(PARCEL_IDLE_MS))
  // written straight into its final buffer as frames land: collecting the frames first and
  // concatenating afterwards would hold the payload TWICE at the moment it completes
  const data = new Uint8Array(size)
  let received = 0

  for (;;) {
    const winner = yield* race([
      (function* () {
        const step = yield* subscription.next()
        return { step }
      })(),
      (function* () {
        yield* sleep(PARCEL_IDLE_MS)
        return { timeout: true as const }
      })(),
    ])

    if ('timeout' in winner) {
      return yield* fail(
        TransportErrors.Timeout,
        `parcel "${topic}" stalled at ${received} of ${size} bytes`,
      )
    }

    if (winner.step.done) {
      if (isFailure(winner.step.value)) {
        return yield* winner.step.value
      }
      break
    }

    const frame = winner.step.value

    if (received + frame.length > size) {
      return yield* fail(
        TransportErrors.Encoding,
        `parcel "${topic}" overran the ${size} bytes it announced`,
      )
    }

    data.set(frame, received)
    received += frame.length
  }

  if (received !== size) {
    return yield* fail(
      TransportErrors.Encoding,
      `parcel "${topic}" carried ${received} bytes, ${size} were announced`,
    )
  }

  return data
}
