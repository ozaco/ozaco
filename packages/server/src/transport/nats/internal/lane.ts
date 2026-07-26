// oxlint-disable import/exports-last -- readers and writers alternate; grouping them beats sorting
import type { Carried, Source } from 'server:core'
import { DataType } from 'server:core'
import { Codec } from 'std:codec'
import type { Operation, Scope, Stream, StreamQueue } from 'std:effect'
import { attempt, createStreamQueue, each, into, spawn, until } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail, isFailure, isSuccess } from 'std:result'

import type { JsMsg, MsgHdrs } from 'nats'

import type { PumpOutcome } from '../../shared/types'
import {
  EMPTY_PAYLOAD,
  LANE_BINARY,
  LANE_ENCODING,
  LANE_END,
  LANE_ERROR,
  LANE_EVENT,
  LANE_PART,
  LANE_PART_FIELD,
  LANE_PART_FILE,
  LANE_PART_FILE_END,
  streamNames,
} from '../const'
import type { Nats } from '../types'

import { useNatsContext } from './context'
import { laneSubject, PARTS_LANE } from './subjects'
import {
  binaryHeaders,
  endHeaders,
  errorHeaders,
  failureFromPayload,
  failureToPayload,
  partHeaders,
} from './wire'

/** Leave room for subject + headers inside the server's `max_payload`; a message over it is dropped. */
const chunkLimit = (nats: Nats.Context): number =>
  Math.max(1024, ((nats.connection.info?.max_payload as number | undefined) ?? 1_048_576) - 8192)

/**
 * Publish one blob of raw bytes, split to fit `max_payload`.
 *
 * A stream's chunk sizes are whatever the producer happened to emit — a file read, a socket read —
 * so nothing guarantees they fit. Splitting is legal ONLY for raw bytes: a codec-encoded value is
 * one message by contract (the reader decodes per message), so an oversized value is an error the
 * publish raises rather than a corruption the reader discovers.
 */
const publishBytes = function* (
  nats: Nats.Context,
  subject: string,
  bytes: Uint8Array,
): Operation<void> {
  const limit = chunkLimit(nats)
  const headers = binaryHeaders()

  if (bytes.byteLength <= limit) {
    yield* until(nats.js.publish(subject, bytes, { headers }), `nats:lane ${subject}`)
    return
  }

  for (let offset = 0; offset < bytes.byteLength; offset += limit) {
    yield* until(
      nats.js.publish(subject, bytes.subarray(offset, offset + limit), { headers }),
      `nats:lane ${subject}`,
    )
  }
}

// oxlint-disable-next-line max-params
const publishMarked = function* (
  nats: Nats.Context,
  subject: string,
  headers: MsgHdrs,
  payload: Uint8Array = EMPTY_PAYLOAD,
): Operation<void> {
  yield* until(nats.js.publish(subject, payload, { headers }), `nats:lane ${subject}`)
}

/**
 * A lane's LAST word — end or error — falls back to a plain core publish when the JetStream
 * publish fails. The core client buffers outbound traffic across a reconnect, so a marker written
 * during a connection blip still lands in the stream when the link returns — and a lane whose
 * terminator is lost leaves its reader parked forever, which is the one outcome worth two tries.
 */
// oxlint-disable-next-line max-params
const publishMarker = function* (
  nats: Nats.Context,
  subject: string,
  headers: MsgHdrs,
  payload: Uint8Array = EMPTY_PAYLOAD,
): Operation<void> {
  try {
    yield* until(nats.js.publish(subject, payload, { headers }), `nats:lane ${subject}`)
  } catch {
    try {
      nats.connection.publish(subject, payload, { headers })
    } catch {
      /* connection torn down for good */
    }
  }
}

/**
 * Drain a lane onto a subject.
 *
 * `bytes` is DECLARED — it comes from the channel the author wrote, never from sniffing a value —
 * and it also travels ON each message (`LANE_ENCODING`), so the reader decodes what the writer
 * actually sent even when the reader holds no declaration at all.
 *
 * Every publish is awaited: a PubAck is JetStream saying "stored", and awaiting it is both the
 * error surface (a vanished stream fails the pump instead of silently dropping the body) and the
 * pacing — the producer runs at ingest speed rather than flooding the connection.
 */
// oxlint-disable-next-line max-params
export const pumpLane = function* (
  nats: Nats.Context,
  subject: string,
  source: Stream<unknown, unknown>,
  bytes = false,
): Operation<void> {
  let outcome: PumpOutcome

  /**
   * Bytes go out untouched; values go out ONE MESSAGE EACH.
   *
   * `encodeStream` writes each value with no delimiter between them, so anything reassembling the
   * bytes has to guess where one ends — a run of `1 2 3 4 5` came back as the single number `12345`.
   * The message boundary already carries the framing; encoding per value keeps it.
   */
  const publish = bytes
    ? (chunk: unknown) => publishBytes(nats, subject, chunk as Uint8Array)
    : function* (value: unknown) {
        const encoded = (yield* Codec.actions.encode(value)) as Uint8Array
        yield* until(nats.js.publish(subject, encoded), `nats:lane ${subject}`)
      }

  try {
    /**
     * Iterated by hand, because the CLOSE VALUE is half the protocol: a source that closes with a
     * failure (an upload socket that died mid-file) must become the lane's ERROR marker, never a
     * clean END — an END here is the receiver saving a truncated file as a complete one.
     */
    const subscription = yield* source
    while (true) {
      const next = yield* subscription.next()
      if (next.done) {
        outcome = isFailure(next.value) ? next.value : 'end'
        break
      }
      yield* publish(next.value)
    }
  } catch (error) {
    outcome = asFailure(error)
  } finally {
    if (outcome === 'end') {
      yield* publishMarker(nats, subject, endHeaders())
    } else {
      const failure = outcome ?? (fail('cancelled', 'pump halted') as Result.Failure<unknown>)
      const payload = yield* attempt(Codec.actions.encode(failureToPayload(failure)))
      yield* publishMarker(
        nats,
        subject,
        errorHeaders(),
        isSuccess(payload) ? (payload.value as Uint8Array) : EMPTY_PAYLOAD,
      )
    }
  }
}

/**
 * Drain a multipart body onto ONE lane, parts framed in wire order.
 *
 * One lane and not one per file, because order IS the multipart contract: the sender's parser
 * yields the next part only after the current file drained, and a subject per part would hand the
 * reader a set where it needs a sequence. A `field` message carries its value in the payload; a
 * `file` message opens a file whose raw chunks follow until `file-end` closes it.
 */
export const pumpParts = function* (
  nats: Nats.Context,
  subject: string,
  parts: Stream<Source.Part, unknown>,
): Operation<void> {
  let outcome: PumpOutcome

  try {
    // Iterated by hand — see the note in `pumpLane`: a failure-closed source (the upload socket
    // died mid-body) must terminate the lane with ERROR, and that applies doubly here, where an
    // inner FILE stream closing with a failure poisons the whole body rather than one part.
    const subscription = yield* parts
    while (true) {
      const next = yield* subscription.next()
      if (next.done) {
        outcome = isFailure(next.value) ? next.value : 'end'
        break
      }

      const part = next.value
      if (part.kind === 'field') {
        const payload = (yield* Codec.actions.encode({
          name: part.name,
          value: part.value,
        } satisfies Nats.PartField)) as Uint8Array
        yield* publishMarked(nats, subject, partHeaders(LANE_PART_FIELD), payload)
      } else {
        const payload = (yield* Codec.actions.encode({
          name: part.name,
          ...(part.filename === undefined ? {} : { filename: part.filename }),
          ...(part.mediaType === undefined ? {} : { mediaType: part.mediaType }),
        } satisfies Nats.PartFile)) as Uint8Array
        yield* publishMarked(nats, subject, partHeaders(LANE_PART_FILE), payload)

        const file = yield* part.stream
        while (true) {
          const chunk = yield* file.next()
          if (chunk.done) {
            if (isFailure(chunk.value)) {
              throw chunk.value
            }
            break
          }
          yield* publishBytes(nats, subject, chunk.value as Uint8Array)
        }

        yield* publishMarked(nats, subject, partHeaders(LANE_PART_FILE_END))
      }
    }
  } catch (error) {
    outcome = asFailure(error)
  } finally {
    if (outcome === 'end') {
      yield* publishMarker(nats, subject, endHeaders())
    } else {
      const failure = outcome ?? (fail('cancelled', 'pump halted') as Result.Failure<unknown>)
      const payload = yield* attempt(Codec.actions.encode(failureToPayload(failure)))
      yield* publishMarker(
        nats,
        subject,
        errorHeaders(),
        isSuccess(payload) ? (payload.value as Uint8Array) : EMPTY_PAYLOAD,
      )
    }
  }
}

/**
 * The reading end of one lane subject: an ORDERED ephemeral consumer replaying from sequence 1.
 *
 * The replay is the point of the whole migration — the LANE stream keeps its messages, so a reader
 * that attaches after the writer began still gets chunk zero. Iteration ends when the lane's
 * end/error marker arrives; the consumer itself is ephemeral and evaporates once stopped.
 */
const consumeLane = function* (
  nats: Nats.Context,
  subject: string,
  handle: (msg: JsMsg) => Operation<'continue' | 'done'>,
) {
  // No `deliver_policy` on purpose. The ordered consumer's default — StartSequence at seq 1 — IS
  // "replay everything", and it is the only spelling this client accepts: passing
  // `DeliverPolicy.All` explicitly makes nats 2.29.3 send `opt_start_seq` alongside it, which the
  // server rejects, and `consume()` swallows that rejection into an eternal hang.
  const consumer = yield* until(
    nats.js.consumers.get(streamNames(nats.prefix).lane, { filterSubjects: subject }),
    `nats:lane-consumer ${subject}`,
  )
  const messages = yield* until(consumer.consume(), `nats:lane-consume ${subject}`)

  // Registered so transport teardown can STOP a mid-lane reader rather than halt it: a task parked
  // inside the iterator below cannot be halted cleanly, but stopping the source ends it on its own.
  nats.consumers.set(`lane:${subject}`, messages)

  try {
    for (const msg of yield* each(into<JsMsg>(messages as AsyncIterable<JsMsg>))) {
      if ((yield* handle(msg)) === 'done') {
        return
      }
      yield* each.next()
    }
  } finally {
    nats.consumers.delete(`lane:${subject}`)
    try {
      messages.stop()
    } catch {
      /* already stopped */
    }
  }
}

/**
 * Read a subject back as a lane.
 *
 * Nothing here takes a `bytes` flag: the encoding rides each message (`LANE_ENCODING`), so producer
 * and consumer agree by construction — a reader with no declaration still decodes correctly.
 */
export const readLane = function* (
  nats: Nats.Context,
  subject: string,
  hostScope?: Scope,
): Operation<Stream<unknown, true | Result.Failure<unknown>>> {
  // Buffered, not broadcast: the reader below starts the moment this returns, while the decoder
  // that consumes it only subscribes a tick later — a channel drops everything in between, which is
  // exactly the opening frames of a feed.
  const raw = createStreamQueue<unknown, true | Result.Failure<unknown>>()

  const reader = function* () {
    let closed = false
    try {
      yield* consumeLane(nats, subject, function* (msg) {
        const event = msg.headers?.get(LANE_EVENT)

        if (event === LANE_END) {
          raw.close(true)
          closed = true
          return 'done'
        }

        if (event === LANE_ERROR) {
          const payload = yield* attempt(Codec.actions.decode(msg.data))
          raw.close(
            isSuccess(payload)
              ? failureFromPayload(payload.value as Nats.StreamErrorPayload)
              : (fail('cancelled', 'lane closed with an undecodable error') as never),
          )
          closed = true
          return 'done'
        }

        // A message this reader cannot decode ENDS the lane with a failure — it never escapes as
        // a raw throw, because the reader may be running on the transport's own scope.
        if (msg.headers?.get(LANE_ENCODING) === LANE_BINARY) {
          raw.add(msg.data)
          return 'continue'
        }

        const value = yield* attempt(Codec.actions.decode(msg.data))
        if (!isSuccess(value)) {
          raw.close(value)
          closed = true
          return 'done'
        }
        raw.add(value.value as never)
        return 'continue'
      })
    } finally {
      if (!closed) {
        raw.close(asFailure(fail('cancelled', 'reader halted')))
      }
    }
  }

  if (hostScope) {
    hostScope.run(reader)
  } else {
    yield* spawn(reader)
  }

  return raw
}

/**
 * Read a parts lane back into the ordered `Source.Part` stream a handler expects.
 *
 * File sub-streams are queues: the lane keeps arriving in wire order while a slow (or skipping)
 * consumer lags, and a part it never drains simply stays in its queue until the whole lane closes —
 * there is no parser on this side left waiting, so nothing can deadlock.
 */
export const readParts = function* (
  nats: Nats.Context,
  subject: string,
): Operation<Stream<Source.Part, unknown>> {
  const parts = createStreamQueue<Source.Part, true | Result.Failure<unknown>>()

  yield* spawn(function* () {
    let file: StreamQueue<Uint8Array, unknown> | null = null
    let closed = false

    const closeAll = (value: true | Result.Failure<unknown>) => {
      if (file) {
        // a file still open when the lane ends was truncated — that is an error, not an EOF
        file.close(value === true ? asFailure(fail('cancelled', 'parts lane closed early')) : value)
        file = null
      }
      parts.close(value)
      closed = true
    }

    try {
      yield* consumeLane(nats, subject, function* (msg) {
        const event = msg.headers?.get(LANE_EVENT)

        if (event === LANE_END) {
          closeAll(true)
          return 'done'
        }
        if (event === LANE_ERROR) {
          const payload = yield* attempt(Codec.actions.decode(msg.data))
          closeAll(
            isSuccess(payload)
              ? failureFromPayload(payload.value as Nats.StreamErrorPayload)
              : (fail('cancelled', 'lane closed with an undecodable error') as never),
          )
          return 'done'
        }

        const part = msg.headers?.get(LANE_PART)

        if (part === LANE_PART_FIELD) {
          const field = yield* attempt(Codec.actions.decode(msg.data))
          if (!isSuccess(field)) {
            closeAll(field)
            return 'done'
          }
          const decoded = field.value as Nats.PartField
          parts.add({ kind: 'field', name: decoded.name, value: decoded.value })
          return 'continue'
        }

        if (part === LANE_PART_FILE) {
          const open = yield* attempt(Codec.actions.decode(msg.data))
          if (!isSuccess(open)) {
            closeAll(open)
            return 'done'
          }
          const decoded = open.value as Nats.PartFile
          const stream = createStreamQueue<Uint8Array, unknown>()
          file = stream
          parts.add({
            kind: 'file',
            name: decoded.name,
            filename: decoded.filename,
            mediaType: decoded.mediaType,
            stream,
          })
          return 'continue'
        }

        if (part === LANE_PART_FILE_END) {
          file?.close(true)
          file = null
          return 'continue'
        }

        // a raw chunk of the currently open file
        file?.add(msg.data)
        return 'continue'
      })
    } finally {
      if (!closed) {
        closeAll(asFailure(fail('cancelled', 'reader halted')))
      }
    }
  })

  return parts as Stream<Source.Part, unknown>
}

/** The lane names one dispatch publishes its inputs on, derived from the cid alone. */
export const inputLaneNames = (payload: Nats.DispatchPayload): string[] => {
  const names: string[] = []
  for (let i = 0; i < (payload.lanes?.streams ?? 0); i++) {
    names.push(String(i))
  }
  return names
}

/**
 * Pump every input the call carries, starting IMMEDIATELY after the dispatch is stored.
 *
 * Not after the reply — that was the old deadlock: an action that consumes its input lane before
 * answering waited on chunks the caller had not started sending. The LANE stream replays, so
 * publishing before the owner's reader exists loses nothing.
 */
export const pumpInputLanes = (
  nats: Nats.Context,
  cid: string,
  req: { sources: Source.Any[]; wire?: { sends: Carried[] } | undefined },
): void => {
  const lanes = req.sources.filter(source => source.type === DataType.stream) as Source.Lane[]
  const sends = req.wire?.sends.filter(carried => carried.type === DataType.stream)

  for (let index = 0; index < lanes.length; index++) {
    const lane = lanes[index]!
    const bytes = sends?.[index]?.bytes ?? false
    const subject = laneSubject(nats.prefix, cid, 'in', String(index))

    nats.scope.run(function* () {
      try {
        yield* pumpLane(nats, subject, lane.stream, bytes)
      } catch {
        /* input pump errors surface to the receiver as the lane's error marker */
      }
    })
  }

  const parts = req.sources.find(source => source.type === DataType.multistream) as
    | Source.Lanes
    | undefined

  if (parts) {
    const subject = laneSubject(nats.prefix, cid, 'in', PARTS_LANE)
    nats.scope.run(function* () {
      try {
        yield* pumpParts(nats, subject, parts.parts)
      } catch {
        /* ditto */
      }
    })
  }
}

/** The owner's side of the same manifest: rebuild every input source the dispatch declared. */
export const captureInputLanes = function* (cid: string, payload: Nats.DispatchPayload) {
  const nats = yield* useNatsContext()

  const streams: Stream<unknown, void>[] = []
  for (const name of inputLaneNames(payload)) {
    const stream = yield* readLane(nats, laneSubject(nats.prefix, cid, 'in', name))
    streams.push(stream as Stream<unknown, void>)
  }

  const parts = payload.lanes?.parts
    ? yield* readParts(nats, laneSubject(nats.prefix, cid, 'in', PARTS_LANE))
    : undefined

  return { streams, parts }
}
