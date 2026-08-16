import {
  CoreErrors,
  DataType,
  decodeEnvelope,
  encodeEnvelope,
  fromWireFailure,
  inputLaneOf,
  statusFor,
  WIRE_VERSION,
} from 'server:core'
import type { Multistream, Outcome, Reply, TransportDispatch, Wire } from 'server:core'
import { runSafe } from 'server:utils'
import { Codec } from 'std:codec'
import { attempt, box, createQueue, ensure, operation, resource, until } from 'std:effect'
import type { Flow, Subscription } from 'std:effect'
import { fail, isFailure, just, nothing } from 'std:result'

import { NatsErrors } from '../errors'
import type { Nats } from '../types'

import { NatsRef } from './context'
import { causesOf, isConsumerNotFound } from './failure'
import { createLaneReader, OUTPUT_LANE, pumpFlowLane, pumpPartsLane } from './lanes'
import { durableOf } from './subjects'

/** How long a positive `hosts()` answer is trusted before the next consumers.info round trip. */
const HOSTS_TTL_MS = 5000

/** The input planes this carrier moves over lanes; anything else (socket) is unsupported. */
const CARRIED_PLANES: ReadonlySet<string> = new Set([DataType.multistream, DataType.stream])

/**
 * The Flow behind a `stream` reply: subscribing creates an EPHEMERAL explicit-ack consumer on the
 * LANE workqueue filtered to this dispatch's output lane (DeliverPolicy.All — frames published
 * before the subscription replay in order). Reading is PULL-paced and each message is acked on
 * take, so a slow drain leaves unacked bytes in the stream until `laneMaxBytes` parks the owner's
 * pump — end-to-end backpressure. `end` closes with `true`; `error` closes with the restored
 * Failure so `drainFlow`/`collectFlow` raise the truncation. Teardown deletes the consumer
 * eagerly instead of waiting for the server's inactivity sweep.
 */
const createLaneFlow = (ctx: Nats.Context, cid: string, bytes: boolean): Flow<unknown, unknown> =>
  resource<Subscription<unknown, unknown>>(function* (provide) {
    const reader = yield* createLaneReader(ctx, ctx.subjects.lane(cid, OUTPUT_LANE))

    let closed: unknown

    yield* provide({
      next: operation(function* () {
        if (closed !== undefined) {
          return { done: true, value: closed } as IteratorResult<unknown, unknown>
        }

        const frame = yield* reader.next()

        if (frame.kind === 'data' || frame.kind === 'chunk') {
          const value = bytes ? frame.data : yield* Codec.actions.decode(frame.data)

          return { done: false, value } as IteratorResult<unknown, unknown>
        }

        closed = frame.kind === 'end' ? true : fromWireFailure(frame.failure)

        return { done: true, value: closed } as IteratorResult<unknown, unknown>
      }),
    })
  })

/**
 * Starts the DETACHED input-plane pumps of one dispatch (multistream + stream lanes) right after
 * the dispatch's PubAck. Detached: the pumps outlive this dispatch operation (a fast reply must
 * not sever a still-uploading source), are boxed so they can never fail the transport scope, and
 * publish their own terminal `error` marker when they fail (lane-full timeout included).
 */
const startInputPumps = (
  ctx: Nats.Context,
  cid: string,
  sources: ReadonlyMap<string, unknown>,
): void => {
  const parts = sources.get(DataType.multistream)

  if (parts) {
    void runSafe(ctx.scope, () =>
      pumpPartsLane(ctx, {
        subject: ctx.subjects.lane(cid, inputLaneOf(DataType.multistream)),
        source: parts as Multistream,
        label: `cid:${cid} plane:${DataType.multistream}`,
      }),
    )
  }

  const values = sources.get(DataType.stream)

  if (values) {
    void runSafe(ctx.scope, () =>
      pumpFlowLane(ctx, {
        subject: ctx.subjects.lane(cid, inputLaneOf(DataType.stream)),
        source: values as Flow<unknown, unknown>,
        bytes: false,
        label: `cid:${cid} plane:${DataType.stream}`,
      }),
    )
  }
}

/**
 * The caller side of one dispatch. The reply inbox (core NATS) is subscribed BEFORE the dispatch
 * is published; the dispatch goes through JetStream with `msgID: idempotencyKey ?? cid`, making
 * the RPC stream's duplicate window the cross-broker double-execution guard. No transport-level
 * timeouts exist here — the broker's fulfillment wrapper owns ALL timing; when it halts this
 * operation (cancel mode, ack timeout, scope teardown) the teardown publishes the `cancel`
 * envelope. The wrapper's abandon signal (detach mode / TimeoutPending — signal fired WITHOUT a
 * halt) is mirrored to the owner as an `abandoned` envelope on the same subject, so remote detach
 * handlers observe `signal.aborted() === true` exactly like local ones while the work keeps
 * running. Input planes (`dispatch.sources`) are announced in the envelope's lane manifest and
 * pumped over `in:<DataType>` lanes on detached tasks after the PubAck.
 */
export const dispatchAction = operation(function* ({
  request,
  acked,
  signal,
  sources,
}: TransportDispatch) {
  const ctx = yield* NatsRef.expect()
  const { cid } = request

  const planes = sources ? [...sources.keys()] : []
  const foreign = planes.filter(plane => !CARRIED_PLANES.has(plane))

  if (foreign.length > 0) {
    return yield* fail(
      NatsErrors.Unsupported,
      `input plane(s) "${foreign.join('", "')}" are not carried over the NATS transport (multistream/stream only)`,
      `transport:nats dispatch cid:${cid}`,
    )
  }

  const log = ctx.log.child({ cid, requestId: request.trace.requestId })
  const subject = ctx.subjects.rpc(request.service)
  const inbox = createQueue<Uint8Array, never>()
  const replySub = ctx.nc.subscribe(ctx.subjects.reply(cid), {
    callback: (error, msg) => {
      if (!error) {
        inbox.add(msg.data)
      }
    },
  })

  const cancelPayload = yield* encodeEnvelope({ k: 'cancel', cid })
  const abandonedPayload = yield* encodeEnvelope({ k: 'abandoned', cid })
  let settled = false

  // remote detach visibility: fired signal + no halt = the caller moved on but wants the work
  // done — `abandoned` fires the owner-side ActionSignal without cancelling anything. A later
  // halt still publishes `cancel` below (cancel-after-abandoned is a valid sequence).
  const offAbort = signal?.onAbort(() => {
    ctx.nc.publish(ctx.subjects.cancel(cid), abandonedPayload)
  })

  yield* ensure(function* () {
    offAbort?.()

    if (!settled) {
      // halted before a reply (fulfillment cancel / teardown) — tell the owner to stop
      yield* box(function* () {
        ctx.nc.publish(ctx.subjects.cancel(cid), cancelPayload)
      })
    }

    yield* box(function* () {
      replySub.unsubscribe()
    })
  })

  const lanes: Wire.LaneManifest | undefined =
    planes.length > 0
      ? {
          streams: planes.includes(DataType.stream) ? 1 : 0,
          parts: planes.includes(DataType.multistream),
        }
      : undefined

  const payload = yield* encodeEnvelope({
    k: 'dispatch',
    v: WIRE_VERSION,
    cid,
    service: request.service,
    action: request.action,
    trace: request.trace,
    params: request.params,
    meta: request.meta,
    idempotencyKey: request.idempotencyKey,
    lanes,
  })

  yield* log.debug('dispatch published', { service: request.service, action: request.action })

  const published = yield* attempt(() =>
    until(ctx.js.publish(subject, payload, { msgID: request.idempotencyKey ?? cid })),
  )

  if (isFailure(published)) {
    settled = true

    return yield* fail(
      NatsErrors.Publish,
      `dispatch publish to "${subject}" failed`,
      `transport:nats dispatch ${subject} cid:${cid}`,
      ...causesOf(published),
    )
  }

  if (published.value.duplicate) {
    // the idempotency window already holds this key — the original execution owns the reply;
    // do NOT cancel it (settled stays true so the teardown sends nothing)
    settled = true

    yield* log.warn('dispatch suppressed by the idempotency window', {
      idempotencyKey: request.idempotencyKey,
    })

    return yield* fail(
      CoreErrors.Conflict,
      `a dispatch with idempotencyKey "${request.idempotencyKey}" already executed within the dedupe window — reconcile via its outcome instead of retrying`,
      `transport:nats dispatch ${subject} cid:${cid}`,
    )
  }

  if (sources && lanes) {
    startInputPumps(ctx, cid, sources)
  }

  while (true) {
    const item = yield* inbox.next()
    const decoded = yield* box(() => decodeEnvelope(item.value))

    if (isFailure(decoded)) {
      yield* log.warn('undecodable reply envelope dropped', { causes: causesOf(decoded) })

      continue
    }

    const envelope = decoded.value

    if (envelope.k === 'ack') {
      acked()

      continue
    }

    if (envelope.k === 'reply') {
      settled = true

      const reply: Reply = {
        kind: 'value',
        cid,
        status: envelope.status,
        meta: envelope.meta ?? {},
        value: envelope.value,
      }

      return reply
    }

    if (envelope.k === 'reply-failure') {
      settled = true

      const { failure } = envelope
      const reply: Reply = {
        kind: 'failure',
        cid,
        status: failure.status ?? statusFor(fromWireFailure(failure)),
        meta: failure.meta ?? {},
        failure,
      }

      return reply
    }

    if (envelope.k === 'reply-stream') {
      settled = true

      const reply: Reply = {
        kind: 'stream',
        cid,
        status: envelope.status,
        meta: envelope.meta ?? {},
        flow: createLaneFlow(ctx, cid, envelope.bytes),
        bytes: envelope.bytes,
      }

      return reply
    }
  }
})

/**
 * A service is hosted when its shared durable exists on the RPC stream (someone registered it,
 * on any node). Positives are cached for 5s to keep the hot path off the JetStream API;
 * consumer-not-found is a definitive `just(false)`; any other error means "unknown" —
 * `nothing()` keeps this carrier a fallback candidate instead of lying.
 */
export const hostsAction = operation(function* (service: string) {
  const ctx = yield* NatsRef.expect()
  const durable = durableOf(ctx.queueGroup, service)
  const cached = ctx.hostsCache.get(durable)

  if (cached !== undefined && cached > Date.now()) {
    return just(true)
  }

  const info = yield* attempt(() => until(ctx.jsm.consumers.info(ctx.streams.rpc, durable)))

  if (!isFailure(info)) {
    ctx.hostsCache.set(durable, Date.now() + HOSTS_TTL_MS)

    return just(true)
  }

  if (isConsumerNotFound(info)) {
    return just(false)
  }

  yield* ctx.log.warn('hosts probe failed', { service, causes: causesOf(info) })

  return nothing<boolean>()
})

/**
 * Reads the owner-published outcome record for a dispatch (direct last-by-subject get on the
 * OUTCOME stream). `nothing()` when no owner ever recorded one — or the TTL already swept it.
 */
export const outcomeAction = operation(function* (cid: string) {
  const ctx = yield* NatsRef.expect()
  const fetched = yield* attempt(() =>
    until(
      ctx.jsm.streams.getMessage(ctx.streams.outcome, {
        last_by_subj: ctx.subjects.outcome(cid),
      }),
    ),
  )

  if (isFailure(fetched) || !fetched.value) {
    return nothing<Outcome>()
  }

  const stored = fetched.value
  const decoded = yield* box(() => decodeEnvelope(stored.data))

  if (isFailure(decoded) || decoded.value.k !== 'outcome') {
    return nothing<Outcome>()
  }

  return just(decoded.value.outcome as Outcome)
})
