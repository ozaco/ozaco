// oxlint-disable import/exports-last -- readers and writers alternate; grouping them beats sorting
import type { Carried, Source } from 'server:core'
import { DataType } from 'server:core'
import { Codec } from 'std:codec'
import type { Operation, Scope, Stream } from 'std:effect'
import { action, attempt, createStreamQueue, race, sleep, spawn, until } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail, isFailure, isSuccess } from 'std:result'

import type { JsMsg, MsgHdrs } from 'nats'
import { AckPolicy, DeliverPolicy } from 'nats'

import type { PumpOutcome } from '../../shared/types'
import {
  EMPTY_PAYLOAD,
  LANE_ABANDON_MS,
  LANE_BINARY,
  LANE_BUFFER_MAX_BYTES,
  LANE_BUFFER_MAX_MESSAGES,
  LANE_CREDIT_TIMEOUT_MS,
  LANE_ENCODING,
  LANE_END,
  LANE_ERROR,
  LANE_EVENT,
  LANE_FETCH_EXPIRES_MS,
  LANE_FETCH_MESSAGES,
  LANE_GRANT_STEP_BYTES,
  LANE_MAX_AGE_NS,
  LANE_PART,
  LANE_PART_FIELD,
  LANE_PART_FILE,
  LANE_PART_FILE_END,
  LANE_STALE_MS,
  LANE_TICK,
  LANE_TICK_MS,
  LANE_WINDOW_BYTES,
  streamNames,
} from '../const'
import { NatsErrors } from '../errors'
import type { Nats } from '../types'

import { useNatsContext } from './context'
import { creditSubject, laneSubject, PARTS_LANE } from './subjects'
import {
  binaryHeaders,
  endHeaders,
  errorHeaders,
  failureFromPayload,
  failureToPayload,
  partHeaders,
  tickHeaders,
} from './wire'

/** Leave room for subject + headers inside the server's `max_payload`; a message over it is dropped. */
const chunkLimit = (nats: Nats.Context): number =>
  Math.max(1024, ((nats.connection.info?.max_payload as number | undefined) ?? 1_048_576) - 8192)

/**
 * The WRITER's half of the credit protocol.
 *
 * The pump may keep {@link LANE_WINDOW_BYTES} in flight on its own; beyond that every byte must be
 * covered by a grant the reader published as its consumer actually drained. Credit messages are
 * control-plane JSON — fixed `{ grant }` / `{ stop }`, never the pluggable codec — because grants
 * are written from a synchronous release hook and both sides must agree even with no codec at all.
 */
interface CreditWindow {
  /** blocks until `size` more bytes fit the window; raises when the reader said stop or vanished */
  reserve(size: number): Operation<void>
  close(): void
}

const openCreditWindow = (nats: Nats.Context, subject: string): CreditWindow => {
  let granted = LANE_WINDOW_BYTES
  let published = 0
  let stopped: Result.Failure<unknown> | undefined
  let waiter: (() => void) | undefined

  const sub = nats.connection.subscribe(creditSubject(subject), {
    callback: (_error, msg) => {
      try {
        const body = JSON.parse(new TextDecoder().decode(msg.data)) as {
          grant?: number
          stop?: boolean
        }
        if (body.stop) {
          stopped = fail(
            'cancelled',
            `lane ${subject} reader closed its window`,
          ) as Result.Failure<unknown>
        } else if (typeof body.grant === 'number' && body.grant + LANE_WINDOW_BYTES > granted) {
          granted = body.grant + LANE_WINDOW_BYTES
        }
      } catch {
        /* a malformed grant is ignored, never fatal */
      }
      waiter?.()
    },
  })

  const grantArrived = function* (): Operation<'grant'> {
    yield* action<void>(resolve => {
      waiter = resolve
      return () => {
        waiter = undefined
      }
    }, 'nats:lane-credit')
    return 'grant' as const
  }

  const expired = function* (): Operation<'timeout'> {
    yield* sleep(LANE_CREDIT_TIMEOUT_MS)
    return 'timeout' as const
  }

  return {
    *reserve(size) {
      while (true) {
        if (stopped) {
          return yield* stopped
        }
        if (published + size <= granted) {
          published += size
          return
        }

        if ((yield* race([grantArrived(), expired()])) === 'timeout') {
          return yield* fail(
            NatsErrors.Timeout,
            `lane ${subject} window never reopened — its reader is gone or stopped draining`,
          )
        }
      }
    },
    close() {
      try {
        if (!sub.isClosed()) {
          sub.unsubscribe()
        }
      } catch {
        /* connection torn down */
      }
    },
  }
}

/**
 * Publish one blob of raw bytes, split to fit `max_payload`.
 *
 * A stream's chunk sizes are whatever the producer happened to emit — a file read, a socket read —
 * so nothing guarantees they fit. Splitting is legal ONLY for raw bytes: a codec-encoded value is
 * one message by contract (the reader decodes per message), so an oversized value is an error the
 * publish raises rather than a corruption the reader discovers.
 */
// oxlint-disable-next-line max-params
const publishBytes = function* (
  nats: Nats.Context,
  subject: string,
  bytes: Uint8Array,
  window: CreditWindow,
): Operation<void> {
  const limit = chunkLimit(nats)
  const headers = binaryHeaders()

  if (bytes.byteLength <= limit) {
    yield* window.reserve(bytes.byteLength)
    yield* until(nats.js.publish(subject, bytes, { headers }), `nats:lane ${subject}`)
    return
  }

  for (let offset = 0; offset < bytes.byteLength; offset += limit) {
    const fragment = bytes.subarray(offset, offset + limit)
    yield* window.reserve(fragment.byteLength)
    yield* until(nats.js.publish(subject, fragment, { headers }), `nats:lane ${subject}`)
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
 * The writer's heartbeat: while a pump lives, its lane visibly does too.
 *
 * An owner SIGKILLed after the `__stream__` reply has nobody left to publish an end marker, and a
 * reader cannot tell "writer is dead" from "writer is thinking" by silence alone — an SSE feed
 * legitimately says nothing for minutes. The tick is what makes those two silences different.
 */
const spawnTicker = function* (nats: Nats.Context, subject: string) {
  return yield* spawn(function* () {
    while (true) {
      yield* sleep(LANE_TICK_MS)
      yield* attempt(() => publishMarked(nats, subject, tickHeaders()))
    }
  })
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
  const window = openCreditWindow(nats, subject)

  const publish = bytes
    ? (chunk: unknown) => publishBytes(nats, subject, chunk as Uint8Array, window)
    : function* (value: unknown) {
        const encoded = (yield* Codec.actions.encode(value)) as Uint8Array
        yield* window.reserve(encoded.byteLength)
        yield* until(nats.js.publish(subject, encoded), `nats:lane ${subject}`)
      }

  const ticker = yield* spawnTicker(nats, subject)

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
    window.close()
    try {
      yield* ticker.halt()
    } catch {
      /* already halted with us */
    }

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

  const window = openCreditWindow(nats, subject)
  const ticker = yield* spawnTicker(nats, subject)

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
        yield* window.reserve(payload.byteLength)
        yield* publishMarked(nats, subject, partHeaders(LANE_PART_FIELD), payload)
      } else {
        const payload = (yield* Codec.actions.encode({
          name: part.name,
          ...(part.filename === undefined ? {} : { filename: part.filename }),
          ...(part.mediaType === undefined ? {} : { mediaType: part.mediaType }),
        } satisfies Nats.PartFile)) as Uint8Array
        yield* window.reserve(payload.byteLength)
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
          yield* publishBytes(nats, subject, chunk.value as Uint8Array, window)
        }

        yield* publishMarked(nats, subject, partHeaders(LANE_PART_FILE_END))
      }
    }
  } catch (error) {
    outcome = asFailure(error)
  } finally {
    window.close()
    try {
      yield* ticker.halt()
    } catch {
      /* already halted with us */
    }

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
 * The reader's bound, shared by every queue one lane feeds.
 *
 * `retain` runs when a message lands in a local queue, `release` when the consumer actually takes
 * it, and `whenBelow` is where the LANE READER parks while the buffer sits above its marks — the
 * next batch is simply not fetched. The stream is the buffer; this process is not.
 */
interface LaneGate {
  retain(size: number): void
  release(size: number): void
  /** `'stuck'` after {@link LANE_ABANDON_MS} above the marks — the consumer stopped draining */
  whenBelow(): Operation<'ready' | 'stuck'>
  /** set by {@link consumeLane}: every release reports the CUMULATIVE drained bytes, which is
   * what a credit grant is made of */
  onReleased?: (cumulative: number) => void
}

const laneGate = (): LaneGate => {
  let bytes = 0
  let messages = 0
  let drained = 0
  let waiter: (() => void) | undefined

  const high = () => bytes >= LANE_BUFFER_MAX_BYTES || messages >= LANE_BUFFER_MAX_MESSAGES
  const low = () => bytes <= LANE_BUFFER_MAX_BYTES / 2 && messages <= LANE_BUFFER_MAX_MESSAGES / 2

  const gate: LaneGate = {
    retain(size) {
      bytes += size
      messages++
    },
    release(size) {
      bytes -= size
      messages--
      drained += size
      gate.onReleased?.(drained)
      if (low() && waiter) {
        const wake = waiter
        waiter = undefined
        wake()
      }
    },
    *whenBelow() {
      if (!high()) {
        return 'ready' as const
      }

      const drainedInTime = function* (): Operation<'ready'> {
        yield* action<void>(resolve => {
          if (!high()) {
            resolve()
            return () => {}
          }
          waiter = resolve
          return () => {
            waiter = undefined
          }
        }, 'nats:lane-drain')
        return 'ready' as const
      }

      const abandoned = function* (): Operation<'stuck'> {
        yield* sleep(LANE_ABANDON_MS)
        return 'stuck' as const
      }

      return yield* race([drainedInTime(), abandoned()])
    },
  }

  return gate
}

/** A stream queue that reports what it holds to the gate — sizes travel a parallel FIFO, so the
 * release matches the retain byte for byte. */
interface GatedQueue<T, TClose> {
  add(value: T, size: number): void
  close(value: TClose): void
  readonly stream: Stream<T, TClose>
}

const gatedQueue = <T, TClose>(gate: LaneGate): GatedQueue<T, TClose> => {
  const raw = createStreamQueue<T, TClose>()
  const sizes: number[] = []

  return {
    add(value, size) {
      sizes.push(size)
      gate.retain(size)
      raw.add(value)
    },
    close(value) {
      raw.close(value)
    },
    stream: {
      *[Symbol.iterator]() {
        const subscription = yield* raw
        return {
          *next() {
            const next = yield* subscription.next()
            if (!next.done) {
              gate.release(sizes.shift() ?? 0)
            }
            return next
          },
        }
      },
    },
  }
}

/** What one lane reader plugs into {@link consumeLane}. */
interface LaneReader {
  gate: LaneGate
  handle(msg: JsMsg): Operation<'continue' | 'done'>
  /** the lane went silent past {@link LANE_STALE_MS} — close your queues; the loop returns after */
  expired(): void
  /** our OWN consumer stopped draining past {@link LANE_ABANDON_MS} — same contract as expired */
  abandoned(): void
}

/**
 * The reading end of one lane subject: an ephemeral consumer replaying from sequence 1, drained in
 * BATCHES.
 *
 * The replay is the point of the whole migration — a reader that attaches after the writer began
 * still gets chunk zero. Batches are what bound this process: the next fetch is issued only while
 * the gate sits under its marks, so a slow consumer parks the reader instead of growing its RAM.
 * A batch that brings NOTHING is the liveness check — no data and no tick past the stale window
 * means the writer is gone, and the reader says so instead of waiting forever.
 *
 * (The consumer is created explicitly via `jsm.consumers.add` — the client's ORDERED consumer both
 * rejects an explicit `DeliverPolicy.All` and re-creates itself per fetch; a plain ephemeral does
 * neither. Losing gap-recovery costs nothing here: the stale window already covers a lost link.)
 */
const consumeLane = function* (nats: Nats.Context, subject: string, reader: LaneReader) {
  const stream = streamNames(nats.prefix).lane
  const credit = creditSubject(subject)

  /**
   * The reader's half of the credit protocol: as the CONSUMER drains, cumulative grants go back to
   * the writer in {@link LANE_GRANT_STEP_BYTES} steps — sync JSON from the release hook, because a
   * grant is control plane, not payload. A transfer smaller than the writer's free window never
   * produces a single credit message.
   */
  let lastGrant = 0
  reader.gate.onReleased = cumulative => {
    if (cumulative - lastGrant < LANE_GRANT_STEP_BYTES) {
      return
    }
    lastGrant = cumulative
    try {
      nats.connection.publish(
        credit,
        new TextEncoder().encode(JSON.stringify({ grant: cumulative })),
      )
    } catch {
      /* the writer's timeout covers a lost grant */
    }
  }

  const info = yield* until(
    nats.jsm.consumers.add(stream, {
      filter_subject: subject,
      ack_policy: AckPolicy.None,
      deliver_policy: DeliverPolicy.All,
      // outlives any legitimate drain-park; the LANE stream itself only holds messages this long
      inactive_threshold: LANE_MAX_AGE_NS,
    }),
    `nats:lane-consumer ${subject}`,
  )
  const consumer = yield* until(
    nats.js.consumers.get(stream, info.name),
    `nats:lane-bind ${subject}`,
  )

  let last = Date.now()

  try {
    while (true) {
      // BACKPRESSURE: no fetch while the local buffer is full — the stream holds the lane for us.
      // A buffer that stays full past the abandon window means OUR consumer is gone; the lane is
      // closed rather than parked until process exit.
      if ((yield* reader.gate.whenBelow()) === 'stuck') {
        reader.abandoned()
        return
      }

      const batch = yield* until(
        consumer.fetch({ max_messages: LANE_FETCH_MESSAGES, expires: LANE_FETCH_EXPIRES_MS }),
        `nats:lane-fetch ${subject}`,
      )

      // iterated via `until` on the raw async iterator — a batch ENDS at its expiry, and a task
      // parked in an `into(...)` of a live iterator is the one thing a halt cannot unwind
      const iterator = (batch as AsyncIterable<JsMsg>)[Symbol.asyncIterator]()
      while (true) {
        const next = yield* until(iterator.next(), `nats:lane-read ${subject}`)
        if (next.done) {
          break
        }
        last = Date.now()
        if ((yield* reader.handle(next.value)) === 'done') {
          return
        }
      }

      // LIVENESS: neither data nor a keepalive tick for the whole stale window — the writer died
      // without its last word, and "wait forever" must not be how the reader finds out
      if (Date.now() - last >= LANE_STALE_MS) {
        reader.expired()
        return
      }
    }
  } finally {
    // tell a still-live writer to stop feeding a lane nobody reads — fire-and-forget, its credit
    // timeout is the fallback if this very publish is what the teardown lost
    try {
      nats.connection.publish(credit, new TextEncoder().encode(JSON.stringify({ stop: true })))
    } catch {
      /* connection torn down */
    }

    // hygiene, both best-effort: a finished lane's chunks should not sit in server memory for five
    // minutes, and the ephemeral consumer need not wait out its inactivity window
    yield* attempt(
      until(nats.jsm.streams.purge(stream, { filter: subject }), `nats:lane-purge ${subject}`),
    )
    yield* attempt(
      until(nats.jsm.consumers.delete(stream, info.name), `nats:lane-unbind ${subject}`),
    )
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
  const gate = laneGate()
  // Buffered, not broadcast: the reader below starts the moment this returns, while the decoder
  // that consumes it only subscribes a tick later — a channel drops everything in between, which is
  // exactly the opening frames of a feed.
  const queue = gatedQueue<unknown, true | Result.Failure<unknown>>(gate)

  const reader = function* () {
    let closed = false
    const close = (value: true | Result.Failure<unknown>) => {
      queue.close(value)
      closed = true
    }

    try {
      yield* consumeLane(nats, subject, {
        gate,
        expired: () =>
          close(
            asFailure(
              fail(
                NatsErrors.Timeout,
                `lane ${subject} went silent — its writer is gone (no data or keepalive for ${LANE_STALE_MS}ms)`,
              ),
            ),
          ),
        abandoned: () =>
          close(asFailure(fail('cancelled', `lane ${subject} consumer stopped draining`))),
        *handle(msg) {
          const event = msg.headers?.get(LANE_EVENT)

          if (event === LANE_TICK) {
            return 'continue'
          }

          if (event === LANE_END) {
            close(true)
            return 'done'
          }

          if (event === LANE_ERROR) {
            const payload = yield* attempt(Codec.actions.decode(msg.data))
            close(
              isSuccess(payload)
                ? failureFromPayload(payload.value as Nats.StreamErrorPayload)
                : (fail('cancelled', 'lane closed with an undecodable error') as never),
            )
            return 'done'
          }

          // A message this reader cannot decode ENDS the lane with a failure — it never escapes as
          // a raw throw, because the reader may be running on the transport's own scope.
          if (msg.headers?.get(LANE_ENCODING) === LANE_BINARY) {
            queue.add(msg.data, msg.data.byteLength)
            return 'continue'
          }

          const value = yield* attempt(Codec.actions.decode(msg.data))
          if (!isSuccess(value)) {
            close(value)
            return 'done'
          }
          queue.add(value.value as never, msg.data.byteLength)
          return 'continue'
        },
      })
    } finally {
      if (!closed) {
        close(asFailure(fail('cancelled', 'reader halted')))
      }
    }
  }

  if (hostScope) {
    hostScope.run(reader)
  } else {
    yield* spawn(reader)
  }

  return queue.stream
}

/**
 * Read a parts lane back into the ordered `Source.Part` stream a handler expects.
 *
 * File sub-streams are queues sharing the lane's ONE gate: whatever queue the consumer neglects —
 * a skipped file, an undrained tail — still counts against the same bound, so the lane reader
 * parks instead of buffering without limit. There is no parser on this side left waiting, so
 * nothing can deadlock.
 */
export const readParts = function* (
  nats: Nats.Context,
  subject: string,
): Operation<Stream<Source.Part, unknown>> {
  const gate = laneGate()
  const parts = gatedQueue<Source.Part, true | Result.Failure<unknown>>(gate)

  yield* spawn(function* () {
    let file: GatedQueue<Uint8Array, unknown> | null = null
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
      yield* consumeLane(nats, subject, {
        gate,
        expired: () =>
          closeAll(
            asFailure(
              fail(
                NatsErrors.Timeout,
                `lane ${subject} went silent — its writer is gone (no data or keepalive for ${LANE_STALE_MS}ms)`,
              ),
            ),
          ),
        abandoned: () =>
          closeAll(asFailure(fail('cancelled', `lane ${subject} consumer stopped draining`))),
        *handle(msg) {
          const event = msg.headers?.get(LANE_EVENT)

          if (event === LANE_TICK) {
            return 'continue'
          }
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
            parts.add(
              { kind: 'field', name: decoded.name, value: decoded.value },
              msg.data.byteLength,
            )
            return 'continue'
          }

          if (part === LANE_PART_FILE) {
            const open = yield* attempt(Codec.actions.decode(msg.data))
            if (!isSuccess(open)) {
              closeAll(open)
              return 'done'
            }
            const decoded = open.value as Nats.PartFile
            const stream = gatedQueue<Uint8Array, unknown>(gate)
            file = stream
            parts.add(
              {
                kind: 'file',
                name: decoded.name,
                filename: decoded.filename,
                mediaType: decoded.mediaType,
                stream: stream.stream,
              },
              msg.data.byteLength,
            )
            return 'continue'
          }

          if (part === LANE_PART_FILE_END) {
            file?.close(true)
            file = null
            return 'continue'
          }

          // a raw chunk of the currently open file
          file?.add(msg.data, msg.data.byteLength)
          return 'continue'
        },
      })
    } finally {
      if (!closed) {
        closeAll(asFailure(fail('cancelled', 'reader halted')))
      }
    }
  })

  return parts.stream as Stream<Source.Part, unknown>
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
