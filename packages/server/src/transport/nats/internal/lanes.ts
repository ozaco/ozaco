// oxlint-disable import/exports-last
import {
  createMultistreamAssembler,
  DataType,
  flowOf,
  fromWireFailure,
  inputLaneOf,
  pumpMultistream,
  statusFor,
  toWireFailure,
} from 'server:core'
import type { Multistream, MultistreamAssembler, Wire } from 'server:core'
import { Codec } from 'std:codec'
import {
  attempt,
  box,
  createQueue,
  ensure,
  flow,
  fork,
  operation,
  scoped,
  sleep,
  until,
} from 'std:effect'
import type { Flow, Operation, Queue } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { Result } from 'std:result'

import { AckPolicy, DeliverPolicy, JetStreamApiError, ReplayPolicy } from '@nats-io/jetstream'
import { nanos } from '@nats-io/nats-core'

import { NatsErrors } from '../errors'
import type { Nats } from '../types'

import { causesOf } from './failure'
import { encodeLaneFrame, parseLaneFrame } from './frames'
import type { LaneFrame } from './frames'

/** The reply stream's output lane id; input planes ride `in:<DataType>` lanes (`inputLaneOf`). */
export const OUTPUT_LANE = '0'

/**
 * PubAck errors of a FULL `<P>_LANE` workqueue (`discard: new`), probed against nats-server
 * 2.14.5: `JetStreamApiError` err_code 10077 `"maximum bytes exceeded"` (status 503) when
 * `max_bytes` is hit. 10076 is the `max_msgs` sibling and 10023 the generic "insufficient
 * resources" — all three are the park-and-retry class, never a hard fault.
 */
const FULL_STREAM_CODES: ReadonlySet<number> = new Set([10_077, 10_076, 10_023])

export const isStreamFull = (error: unknown): boolean =>
  error instanceof JetStreamApiError && FULL_STREAM_CODES.has(error.code)

/** Park backoff against a full lane stream: 50ms doubling to 1s. */
const RETRY_BASE_MS = 50
const RETRY_CAP_MS = 1000

/** Delivered-but-unacked messages the reader may buffer client-side (they still count against
 * `laneMaxBytes` — only an ack frees stream space). */
const LANE_PREFETCH = 16

/** The server sweeps abandoned ephemeral lane consumers after this idle window. */
const READER_INACTIVE_MS = 30_000

/**
 * Publishes ONE lane frame with the workqueue backpressure loop. When the reader stops draining,
 * unacked bytes accumulate to `laneMaxBytes` and the LANE stream REJECTS the publish
 * (`discard: new`); this parks (50ms doubling to 1s, counted in `diagnostics.laneRetries`) until
 * space frees — real end-to-end backpressure — or `laneFullTimeoutMs` elapses, which fails the
 * pump with `NatsErrors.LaneFull`.
 */
export const publishLaneFrame = operation(function* (
  ctx: Nats.Context,
  subject: string,
  frame: LaneFrame,
) {
  const encoded = encodeLaneFrame(frame)
  const deadline = Date.now() + ctx.jetstream.laneFullTimeoutMs
  let backoffMs = RETRY_BASE_MS

  while (true) {
    const published = yield* attempt(() =>
      until(ctx.js.publish(subject, encoded.payload, { headers: encoded.headers })),
    )

    if (!isFailure(published)) {
      return
    }

    if (!isStreamFull(published.error)) {
      return yield* fail(
        NatsErrors.Publish,
        `lane frame publish to "${subject}" failed`,
        `transport:nats lane ${subject} seq:${frame.seq}`,
        ...causesOf(published),
      )
    }

    if (Date.now() >= deadline) {
      return yield* fail(
        NatsErrors.LaneFull,
        `the lane stream stayed full for ${ctx.jetstream.laneFullTimeoutMs}ms while publishing to "${subject}" — the consumer is not draining (laneMaxBytes: ${ctx.jetstream.laneMaxBytes})`,
        `transport:nats lane ${subject} seq:${frame.seq}`,
      )
    }

    ctx.diagnostics.laneRetries += 1

    yield* sleep(backoffMs)

    backoffMs = Math.min(backoffMs * 2, RETRY_CAP_MS)
  }
})

export interface LaneReader {
  /** Pulls the next well-formed frame. The message is acked ON TAKE — that ack IS the pacing. */
  next(): Operation<LaneFrame>
}

/**
 * The single scope-bound reader of one lane subject: an EPHEMERAL explicit-ack consumer
 * (workqueue streams refuse ack-none/ordered consumers — probed err 10084) with
 * `DeliverPolicy.All`, so a late attach replays every frame still unacked. Reading is
 * PULL-paced: a message is only taken — and acked — when the local consumer asks for the next
 * frame; a slow consumer therefore leaves unacked bytes in the stream until `laneMaxBytes` parks
 * the remote producer. Teardown stops the iterator and deletes the consumer eagerly (the server
 * would sweep it after `inactive_threshold` anyway).
 */
export const createLaneReader = operation(function* (ctx: Nats.Context, subject: string) {
  const info = yield* until(
    ctx.jsm.consumers.add(ctx.streams.lane, {
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      replay_policy: ReplayPolicy.Instant,
      filter_subject: subject,
      inactive_threshold: nanos(READER_INACTIVE_MS),
    }),
  )
  const consumer = yield* until(ctx.js.consumers.get(ctx.streams.lane, info.name))
  const messages = yield* until(consumer.consume({ max_messages: LANE_PREFETCH }))

  yield* ensure(function* () {
    messages.stop()

    yield* box(() => until(consumer.delete()))
  })

  const feed = yield* flow(messages)

  const reader: LaneReader = {
    next: operation(function* () {
      while (true) {
        const item = yield* feed.next()

        if (item.done) {
          // the consumer vanished under us (deleted/idle-swept) — surface it as a truncation
          const truncated: LaneFrame = {
            kind: 'error',
            seq: -1,
            failure: {
              error: NatsErrors.Wire,
              message: `the lane consumer on "${subject}" ended before a terminal frame`,
              causes: [`transport:nats lane ${subject}`],
            },
          }

          return truncated
        }

        const msg = item.value
        const frame = parseLaneFrame(msg)

        msg.ack()

        if (!frame) {
          yield* ctx.log.warn('unframed lane message dropped', { subject })

          continue
        }

        return frame
      }
    }),
  }

  return reader
})

interface LaneFinish {
  readonly subject: string
  readonly label: string
  readonly seq: number
  readonly pumped: Result<unknown>
}

/** Publishes the terminal `end`/`error` frame of a finished pump and records give-ups. */
const finishLane = operation(function* (ctx: Nats.Context, finish: LaneFinish) {
  const inner = isFailure(finish.pumped) ? undefined : finish.pumped.value
  const closeFailure = isFailure(finish.pumped)
    ? finish.pumped
    : isFailure(inner)
      ? (inner as Result.Failure<unknown>)
      : undefined

  if (closeFailure) {
    ctx.diagnostics.laneFailures.push(String(closeFailure.error))
  }

  const seq = finish.seq + 1
  const terminal: LaneFrame = closeFailure
    ? {
        kind: 'error',
        seq,
        failure: toWireFailure(closeFailure, { status: statusFor(closeFailure) }),
      }
    : { kind: 'end', seq }

  // small terminal frames usually fit the headroom even when data chunks park; a full-timeout
  // here is logged — the reader's max_age sweeper reclaims the lane either way
  const published = yield* box(() => publishLaneFrame(ctx, finish.subject, terminal))

  if (isFailure(published)) {
    yield* ctx.log.error('lane terminal frame publish failed', {
      subject: finish.subject,
      label: finish.label,
      causes: causesOf(published),
    })

    return
  }

  yield* ctx.log.debug('lane pumped', {
    subject: finish.subject,
    label: finish.label,
    frames: seq,
    faulted: closeFailure !== undefined,
  })
})

export interface FlowLaneInput {
  readonly subject: string
  readonly source: Flow<unknown, unknown>
  /** Raw byte items published as-is vs codec-encoded values. */
  readonly bytes: boolean
  /** Log/breadcrumb label, e.g. `cid:… plane:stream`. */
  readonly label: string
}

/**
 * Pumps a value/byte flow into one lane subject — the owner's reply stream AND the caller's
 * `stream` input plane share this. Terminal markers close the lane; a pump failure (lane stayed
 * full, publish fault, truncated source) closes with the `error` frame and lands in
 * `diagnostics.laneFailures`.
 */
export const pumpFlowLane = operation(function* (ctx: Nats.Context, input: FlowLaneInput) {
  let seq = 0

  const pumped = yield* box(function* () {
    const subscription = yield* input.source

    while (true) {
      const item = yield* subscription.next()

      if (item.done) {
        return item.value
      }

      const data = input.bytes
        ? (item.value as Uint8Array)
        : yield* Codec.actions.encode(item.value)

      seq += 1

      yield* publishLaneFrame(ctx, input.subject, { kind: 'data', seq, data })
    }
  })

  yield* finishLane(ctx, { subject: input.subject, label: input.label, seq, pumped })
})

export interface PartsLaneInput {
  readonly subject: string
  readonly source: Multistream
  readonly label: string
}

/**
 * CALLER side of a multipart input plane: folds the {@link Multistream} through the shared
 * `Wire.PartFrame` vocabulary — `p: 'chunk'` frames carry the RAW file bytes as the message payload
 * (lane kind `chunk`), every other part travels codec-encoded under kind `data`.
 */
export const pumpPartsLane = operation(function* (ctx: Nats.Context, input: PartsLaneInput) {
  let seq = 0

  const emit = (part: Wire.PartFrame): Operation<void> => ({
    *[Symbol.iterator]() {
      seq += 1

      if (part.p === 'chunk') {
        yield* publishLaneFrame(ctx, input.subject, { kind: 'chunk', seq, data: part.data })

        return
      }

      const data = yield* Codec.actions.encode(part)

      yield* publishLaneFrame(ctx, input.subject, { kind: 'data', seq, data })
    },
  })

  const pumped = yield* box(() => pumpMultistream(input.source, emit))

  yield* finishLane(ctx, { subject: input.subject, label: input.label, seq, pumped })
})

/** OWNER reader of the `in:multistream` lane — rebuilds the handler's Multistream. */
const readPartsLane = operation(function* (
  ctx: Nats.Context,
  cid: string,
  assembler: MultistreamAssembler,
) {
  yield* scoped(function* () {
    const subject = ctx.subjects.lane(cid, inputLaneOf(DataType.multistream))
    const reader = yield* createLaneReader(ctx, subject)

    while (true) {
      const frame = yield* reader.next()

      if (frame.kind === 'chunk') {
        assembler.push({ p: 'chunk', data: frame.data })

        continue
      }

      if (frame.kind === 'data') {
        const decoded = yield* box(() => Codec.actions.decode<Wire.PartFrame>(frame.data))

        if (isFailure(decoded)) {
          assembler.end(decoded)

          return
        }

        assembler.push(decoded.value)

        continue
      }

      if (frame.kind === 'end') {
        assembler.end()

        return
      }

      assembler.end(fromWireFailure(frame.failure))

      return
    }
  })
})

/** OWNER reader of the `in:stream` lane — feeds the queue behind `useSource(DataType.stream)`. */
const readStreamLane = operation(function* (
  ctx: Nats.Context,
  cid: string,
  queue: Queue<unknown, unknown>,
) {
  yield* scoped(function* () {
    const subject = ctx.subjects.lane(cid, inputLaneOf(DataType.stream))
    const reader = yield* createLaneReader(ctx, subject)

    while (true) {
      const frame = yield* reader.next()

      if (frame.kind === 'chunk') {
        // stream planes are codec values — a raw chunk here is a foreign producer, pass bytes up
        queue.add(frame.data)

        continue
      }

      if (frame.kind === 'data') {
        const decoded = yield* box(() => Codec.actions.decode(frame.data))

        if (isFailure(decoded)) {
          queue.close(decoded)

          return
        }

        queue.add(decoded.value)

        continue
      }

      if (frame.kind === 'end') {
        queue.close(true)

        return
      }

      queue.close(fromWireFailure(frame.failure))

      return
    }
  })
})

export interface InputPlanesInput {
  readonly cid: string
  /** The action's declared input kinds (its wire manifest). */
  readonly declared: readonly string[]
  /** The caller's lane announce from the dispatch envelope. */
  readonly lanes: Wire.LaneManifest | undefined
}

/**
 * OWNER side: starts one lane reader per input plane that is BOTH declared by the action and
 * announced by the caller's dispatch envelope — no consumers for planes that never come. Readers
 * run as background forks of the CURRENT scope (the dispatch task), so dispatch settle tears
 * every reader — and its ephemeral consumer — down.
 */
export const openInputSources = operation(function* (ctx: Nats.Context, input: InputPlanesInput) {
  const sources = new Map<string, unknown>()

  if (input.lanes?.parts && input.declared.includes('parts')) {
    const assembler = createMultistreamAssembler()

    yield* fork(() => box(() => readPartsLane(ctx, input.cid, assembler)))
    sources.set(DataType.multistream, assembler.multistream)
  }

  if ((input.lanes?.streams ?? 0) > 0 && input.declared.includes('stream')) {
    const queue = createQueue<unknown, unknown>()

    yield* fork(() => box(() => readStreamLane(ctx, input.cid, queue)))
    sources.set(DataType.stream, flowOf<unknown, unknown>({ next: queue.next }))
  }

  return sources.size > 0 ? (sources as ReadonlyMap<string, unknown>) : undefined
})
