// oxlint-disable import/exports-last
import type {
  ActionSignal,
  Multistream,
  OutcomeState,
  Part,
  PartClose,
  Reply,
  Request,
  TransportDispatch,
  TransportEvent,
  Wire,
} from 'server:core'
import {
  CoreErrors,
  DataType,
  Transport,
  WIRE_VERSION,
  createMultistreamAssembler,
  fromWireFailure,
  inputLaneOf,
  invokeLocal,
  isInputLane,
  pumpMultistream,
  statusFor,
  toWireFailure,
} from 'server:core'
import { runSafe } from 'server:utils'
import type { Flow, Subscription } from 'std:effect'
import { attempt, box, createQueue, ensure, fork, operation, withResolvers } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure, succeed } from 'std:result'
import type { AnyType } from 'std:shared'

import { LANE_CREDIT_STEP, LANE_WINDOW, OUTPUT_LANE } from '../const'
import type { WorkerWire } from '../types'

type DispatchEnvelope = Extract<Wire.Envelope, { k: 'dispatch' }>
type ReplyStreamEnvelope = Extract<Wire.Envelope, { k: 'reply-stream' }>
type LaneEnvelope = Extract<Wire.Envelope, { k: 'lane' }>
type LaneCreditEnvelope = Extract<Wire.Envelope, { k: 'lane-credit' }>

/**
 * TEST-ONLY white-box diagnostics — NOT part of the carrier API. Tracks the maximum number of
 * lane items ever buffered on THIS side of the port (received − consumed) across all queue-backed
 * lanes. The backpressure suite resets it, streams a large flow, and asserts the peak stayed
 * within `LANE_WINDOW + LANE_CREDIT_STEP`.
 */
export const laneDiagnostics = {
  maxBuffered: 0,
  reset(): void {
    laneDiagnostics.maxBuffered = 0
  },
}

/** `peer.senders` registry key of one flowing lane. */
const laneKey = (cid: string, lane: string): string => `${cid}#${lane}`

/** A lazily-swept TTL map — the owner-side reply cache backing `idempotencyKey` dedupe. */
export const createTtlCache = <T>(ttlMs: number): WorkerWire.TtlCache<T> => {
  const entries = new Map<string, { readonly ts: number; readonly value: T }>()

  const sweep = () => {
    const cutoff = Date.now() - ttlMs

    for (const [key, entry] of entries) {
      if (entry.ts < cutoff) {
        entries.delete(key)
      }
    }
  }

  return {
    get(key: string) {
      sweep()

      return entries.get(key)?.value
    },
    set(key: string, value: T) {
      sweep()
      entries.set(key, { ts: Date.now(), value })
    },
  }
}

/** A fire-able {@link ActionSignal} — fired when a `cancel`/`abandoned` envelope arrives. */
export const createFireableSignal = (): WorkerWire.FireableSignal => {
  const listeners = new Set<() => void>()
  let aborted = false

  return {
    aborted: () => aborted,
    onAbort(listener: () => void) {
      if (aborted) {
        listener()

        return () => {}
      }

      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    fire() {
      if (aborted) {
        return
      }

      aborted = true

      for (const listener of listeners) {
        listener()
      }

      listeners.clear()
    },
  }
}

/** A fresh peer with a stub port — the caller wires the real port right after. */
export const createPeer = (index: number): WorkerWire.Peer => ({
  index,
  port: { post: () => {}, terminate: () => {} },
  online: false,
  dead: false,
  outbox: [],
  pending: new Map(),
  streams: new Map(),
  senders: new Map(),
  running: new Map(),
})

/** Best-effort logging from plain callbacks — boxed so a logging failure cannot kill the scope. */
export const logSync = (
  ctx: WorkerWire.Context,
  entry: {
    readonly level: 'debug' | 'warn'
    readonly message: string
    readonly data: Record<string, unknown>
  },
): void => {
  try {
    void runSafe(ctx.scope, () => ctx.log[entry.level](entry.message, entry.data)).catch(() => {})
  } catch {
    // scope already tearing down — logging is best-effort
  }
}

/** Post now when the peer is online; queue into the outbox otherwise. Dead peers swallow. */
export const post = (peer: WorkerWire.Peer, message: WorkerWire.PortMessage): void => {
  if (peer.dead) {
    return
  }

  if (!peer.online) {
    peer.outbox.push(message)

    return
  }

  peer.port.post(message)
}

/** Like {@link post}, but folds structured-clone errors into a Failure instead of throwing. */
export const postSafe = (
  peer: WorkerWire.Peer,
  message: WorkerWire.PortMessage,
): Result.Failure<string> | undefined => {
  try {
    post(peer, message)

    return undefined
  } catch (error) {
    return fail(
      CoreErrors.BadRequest,
      `worker wire message is not structured-cloneable: ${String(error)}`,
    ) as unknown as Result.Failure<string>
  }
}

const flushOutbox = (ctx: WorkerWire.Context, peer: WorkerWire.Peer): void => {
  const queued = peer.outbox.splice(0)

  for (const message of queued) {
    const posted = postSafe(peer, message)

    if (posted) {
      logSync(ctx, {
        level: 'warn',
        message: 'queued wire message dropped (not structured-cloneable)',
        data: { peer: peer.index, kind: message.k },
      })
    }
  }
}

const settlePending = (peer: WorkerWire.Peer, cid: string, result: Result<Reply>): void => {
  const pending = peer.pending.get(cid)

  if (!pending) {
    return
  }

  peer.pending.delete(cid)
  pending.settle(result)
}

const unavailableFailure = (cid: string, reason: string): Result.Failure<string> =>
  fail(
    CoreErrors.Unavailable,
    `worker died before replying (${reason})`,
    `transport:worker cid:${cid}`,
  ) as unknown as Result.Failure<string>

/** Truncates every input-plane sink of a bridge with the failure. */
const killBridge = (
  bridge: WorkerWire.InputBridge | undefined,
  failure: Result.Failure<string>,
): void => {
  if (!bridge) {
    return
  }

  for (const plane of bridge.planes.values()) {
    plane.kill(failure)
  }
}

/**
 * Marks a peer dead: settles every pending dispatch with `Unavailable`, closes every open lane
 * (stream receivers AND input-plane sinks) with a Failure, releases every parked lane producer,
 * halts every running inbound handler and terminates the worker. Idempotent.
 */
export const killPeer = (ctx: WorkerWire.Context, peer: WorkerWire.Peer, reason: string): void => {
  if (peer.dead) {
    return
  }

  peer.dead = true
  peer.online = false
  peer.outbox.length = 0

  for (const [cid] of peer.pending) {
    settlePending(peer, cid, unavailableFailure(cid, reason))
  }

  for (const [cid, receiver] of peer.streams) {
    receiver.queue.close(unavailableFailure(cid, reason))
  }

  peer.streams.clear()

  // Parked producers must not stay parked forever — fail their pumps with Unavailable.
  for (const sender of peer.senders.values()) {
    const gate = sender.gate

    sender.gate = undefined
    gate?.reject(unavailableFailure(sender.cid, reason))
  }

  peer.senders.clear()

  for (const [cid, running] of peer.running) {
    killBridge(running.inputs, unavailableFailure(cid, reason))
    running.signal.fire()

    if (running.task) {
      void Promise.resolve(running.task.halt()).catch(() => {})
    }
  }

  peer.running.clear()

  try {
    peer.port.terminate()
  } catch {
    // already gone
  }

  logSync(ctx, {
    level: 'warn',
    message: 'worker peer removed',
    data: { peer: peer.index, reason },
  })
}

const createReceiver = (cid: string, lane: string): WorkerWire.LaneReceiver => ({
  cid,
  lane,
  queue: createQueue<unknown, unknown>(),
  consumed: 0,
  buffered: 0,
})

/** Counts one consumed item; every `LANE_CREDIT_STEP` the cumulative grant goes back on the wire. */
const creditConsumed = (peer: WorkerWire.Peer, receiver: WorkerWire.LaneReceiver): void => {
  receiver.buffered -= 1
  receiver.consumed += 1

  if (receiver.consumed % LANE_CREDIT_STEP === 0) {
    post(peer, {
      k: 'lane-credit',
      cid: receiver.cid,
      lane: receiver.lane,
      grant: receiver.consumed,
    })
  }
}

/** Feeds one lane envelope into a receiver queue; returns true when the lane closed. */
const feedReceiver = (receiver: WorkerWire.LaneReceiver, envelope: LaneEnvelope): boolean => {
  if (envelope.error) {
    receiver.queue.close(fromWireFailure(envelope.error))

    return true
  }

  if (envelope.end) {
    receiver.queue.close(true)

    return true
  }

  receiver.queue.add(envelope.data as unknown)
  receiver.buffered += 1
  laneDiagnostics.maxBuffered = Math.max(laneDiagnostics.maxBuffered, receiver.buffered)

  return false
}

/** Wraps a receiver queue as a METERED Flow — consumption drives the credit window. */
const meteredLaneFlow = (
  peer: WorkerWire.Peer,
  receiver: WorkerWire.LaneReceiver,
): Flow<unknown, unknown> => ({
  *[Symbol.iterator]() {
    const subscription: Subscription<unknown, unknown> = {
      *next() {
        const item = yield* receiver.queue.next()

        if (!item.done) {
          creditConsumed(peer, receiver)
        }

        return item
      },
    }

    return subscription
  },
})

const meteredPartData = (
  inner: Flow<Uint8Array, PartClose>,
  credit: () => void,
): Flow<Uint8Array, PartClose> => ({
  *[Symbol.iterator]() {
    const subscription = yield* inner
    const wrapped: Subscription<Uint8Array, PartClose> = {
      *next() {
        const item = yield* subscription.next()

        // `done` counts too — it stands for the producer's `file-end` frame.
        credit()

        return item
      },
    }

    return wrapped
  },
})

/** Meters a rebuilt {@link Multistream}: every frame the handler consumes earns credit. */
const meteredMultistream = (inner: Multistream, credit: () => void): Multistream => ({
  parts: {
    *[Symbol.iterator]() {
      const subscription = yield* inner.parts
      const wrapped: Subscription<Part, PartClose> = {
        *next() {
          const item = yield* subscription.next()

          if (item.done) {
            return item
          }

          credit()

          if (item.value.kind === 'file') {
            const value: Part = { ...item.value, data: meteredPartData(item.value.data, credit) }

            return { done: false, value }
          }

          return item
        },
      }

      return wrapped
    },
  },
})

interface BridgeInput {
  readonly peer: WorkerWire.Peer
  readonly envelope: DispatchEnvelope
}

/**
 * Builds the owner-side input bridge for a dispatch that declared source lanes. Sinks are created
 * EAGERLY from the envelope's lane manifest and registered before the invoke spawns, so neither an
 * immediate `useSource` in the handler nor an early `in:*` frame can lose the race. Consumption is
 * metered — every frame/value the handler drains earns the producer credit.
 */
const createInputBridge = ({ peer, envelope }: BridgeInput): WorkerWire.InputBridge | undefined => {
  const manifest = envelope.lanes

  if (!manifest || (!manifest.parts && manifest.streams <= 0)) {
    return undefined
  }

  const sources = new Map<string, unknown>()
  const planes = new Map<string, WorkerWire.InputPlane>()

  if (manifest.parts) {
    const lane = inputLaneOf(DataType.multistream)
    const assembler = createMultistreamAssembler()
    const meter = { consumed: 0 }
    const credit = () => {
      meter.consumed += 1

      if (meter.consumed % LANE_CREDIT_STEP === 0) {
        post(peer, { k: 'lane-credit', cid: envelope.cid, lane, grant: meter.consumed })
      }
    }

    sources.set(DataType.multistream, meteredMultistream(assembler.multistream, credit))
    planes.set(lane, {
      feed(message) {
        if (message.error) {
          assembler.end(fromWireFailure(message.error))
        } else if (message.end) {
          assembler.end()
        } else {
          assembler.push(message.data as unknown as Wire.PartFrame)
        }
      },
      kill(failure) {
        assembler.end(failure)
      },
    })
  }

  if (manifest.streams > 0) {
    const lane = inputLaneOf(DataType.stream)
    const receiver = createReceiver(envelope.cid, lane)

    sources.set(DataType.stream, meteredLaneFlow(peer, receiver))
    planes.set(lane, {
      feed(message) {
        feedReceiver(receiver, message)
      },
      kill(failure) {
        receiver.queue.close(failure)
      },
    })
  }

  return { sources, planes }
}

const openStream = (peer: WorkerWire.Peer, envelope: ReplyStreamEnvelope): void => {
  const receiver = createReceiver(envelope.cid, OUTPUT_LANE)

  peer.streams.set(envelope.cid, receiver)
  settlePending(
    peer,
    envelope.cid,
    succeed({
      kind: 'stream',
      cid: envelope.cid,
      status: envelope.status,
      meta: envelope.meta ?? {},
      flow: meteredLaneFlow(peer, receiver),
      bytes: envelope.bytes,
    } as Reply),
  )
}

const feedLane = (peer: WorkerWire.Peer, envelope: LaneEnvelope): void => {
  const receiver = peer.streams.get(envelope.cid)

  if (!receiver) {
    return
  }

  if (feedReceiver(receiver, envelope)) {
    peer.streams.delete(envelope.cid)
  }
}

/** Raises a producer's cumulative grant; releases the parked gate once the window has room. */
const grantCredit = (peer: WorkerWire.Peer, envelope: LaneCreditEnvelope): void => {
  const sender = peer.senders.get(laneKey(envelope.cid, envelope.lane))

  if (!sender) {
    return
  }

  sender.granted = Math.max(sender.granted, envelope.grant)

  if (sender.gate && sender.sent - sender.granted < LANE_WINDOW) {
    const gate = sender.gate

    sender.gate = undefined
    gate.resolve(undefined as void)
  }
}

/** Posts one lane item, parking first while the credit window is exhausted. */
const sendLaneItem = operation(function* (
  peer: WorkerWire.Peer,
  sender: WorkerWire.LaneSender,
  data: unknown,
) {
  while (sender.sent - sender.granted >= LANE_WINDOW) {
    const gate = withResolvers<void>('lane credit window')

    sender.gate = gate

    yield* gate.operation
  }

  const posted = postSafe(peer, {
    k: 'lane',
    cid: sender.cid,
    lane: sender.lane,
    seq: sender.sent,
    data: data as AnyType,
  })

  if (posted) {
    return yield* posted
  }

  sender.sent += 1
})

interface FlowPumpInput {
  readonly peer: WorkerWire.Peer
  readonly sender: WorkerWire.LaneSender
  readonly flow: Flow<unknown, unknown>
}

/** Drains a value Flow through {@link sendLaneItem}; a Failure close re-raises. */
const pumpFlow = operation(function* ({ peer, sender, flow }: FlowPumpInput) {
  const subscription = yield* flow

  while (true) {
    const item = yield* subscription.next()

    if (item.done) {
      if (isFailure(item.value)) {
        return yield* item.value
      }

      return
    }

    yield* sendLaneItem(peer, sender, item.value)
  }
})

interface LanePumpInput {
  readonly peer: WorkerWire.Peer
  readonly cid: string
  readonly lane: string
  /** `multistream` folds {@link Wire.PartFrame}s; anything else drains a value Flow. */
  readonly plane: string
  readonly source: unknown
}

/**
 * The producer side of ONE lane: registers the credit ledger, drains the source through the
 * window (parking at `LANE_WINDOW` items in flight), then posts the terminal envelope (`end`, or
 * `error` carrying the Wire.Failure). Failures are contained HERE — a broken source fails the
 * lane, never the carrier scope.
 */
const pumpLane = operation(function* ({ peer, cid, lane, plane, source }: LanePumpInput) {
  const sender: WorkerWire.LaneSender = { cid, lane, sent: 0, granted: 0, gate: undefined }
  const key = laneKey(cid, lane)

  peer.senders.set(key, sender)

  yield* ensure(() => {
    peer.senders.delete(key)
  })

  const pumped = yield* attempt(() =>
    plane === DataType.multistream
      ? pumpMultistream(source as Multistream, frame => sendLaneItem(peer, sender, frame))
      : pumpFlow({ peer, sender, flow: source as Flow<unknown, unknown> }),
  )

  if (peer.dead) {
    return
  }

  if (isFailure(pumped)) {
    post(peer, { k: 'lane', cid, lane, seq: sender.sent, error: toWireFailure(pumped) })

    return
  }

  post(peer, { k: 'lane', cid, lane, seq: sender.sent, end: true })
})

interface InboundInput {
  readonly ctx: WorkerWire.Context
  readonly peer: WorkerWire.Peer
  readonly request: Request
  readonly signal: ActionSignal
  readonly sources?: Map<string, unknown> | undefined
}

/** Owner side: resolve the target — child role via the local registry, host role via the router. */
const resolveInbound = operation(function* ({ ctx, peer, request, signal, sources }: InboundInput) {
  const acked = () => post(peer, { k: 'ack', cid: request.cid })

  if (ctx.role === 'host') {
    return yield* Transport.actions.dispatchRoot({ request, acked, signal, sources })
  }

  const entry = ctx.broker.registry.get(request.service)

  if (!entry) {
    return yield* fail(
      CoreErrors.NoRoute,
      `service "${request.service}" is not registered on this worker`,
      `transport:${ctx.name} dispatch cid:${request.cid}`,
    )
  }

  return yield* invokeLocal({ entry, request, acked, signal, sources })
})

const postOutcome = (input: {
  readonly ctx: WorkerWire.Context
  readonly peer: WorkerWire.Peer
  readonly request: Request
  readonly state: OutcomeState
  readonly error?: string | undefined
}): void => {
  const { ctx, peer, request } = input
  const serviceId = ctx.broker.registry.get(request.service)?.serviceId ?? request.service

  post(peer, {
    k: 'outcome',
    cid: request.cid,
    outcome: {
      cid: request.cid,
      state: input.state,
      ts: Date.now(),
      serviceId,
      actionId: request.trace.actionId,
      error: input.error,
    },
  })
}

interface DeliverInput {
  readonly ctx: WorkerWire.Context
  readonly peer: WorkerWire.Peer
  readonly request: Request
  readonly reply: Reply
}

/** Posts a Reply back over the port with full fidelity; streams continue as lane envelopes. */
const deliverReply = operation(function* ({ ctx, peer, request, reply }: DeliverInput) {
  const cid = request.cid

  if (reply.kind === 'failure') {
    post(peer, {
      k: 'reply-failure',
      cid,
      failure: {
        ...reply.failure,
        status: reply.failure.status ?? reply.status,
        meta: reply.failure.meta ?? (Object.keys(reply.meta).length > 0 ? reply.meta : undefined),
      },
    })

    return
  }

  if (reply.kind === 'value') {
    const envelope = {
      k: 'reply',
      cid,
      value: reply.value,
      status: reply.status,
      meta: reply.meta,
    } as const
    const posted = postSafe(peer, envelope)

    if (posted) {
      // The value itself cannot cross the port — the caller gets a failure, the outcome record
      // still says the work fulfilled (the reply just could not be delivered).
      post(peer, { k: 'reply-failure', cid, failure: toWireFailure(posted, { status: 500 }) })
      postOutcome({ ctx, peer, request, state: 'fulfilled', error: 'reply-not-cloneable' })

      return
    }

    if (request.idempotencyKey) {
      ctx.replies.set(request.idempotencyKey, envelope)
    }

    return
  }

  post(peer, { k: 'reply-stream', cid, bytes: reply.bytes, status: reply.status, meta: reply.meta })
  yield* pumpLane({ peer, cid, lane: OUTPUT_LANE, plane: DataType.stream, source: reply.flow })
})

/** The owner-side task behind one inbound dispatch: invoke, deliver, honor cancel bookkeeping. */
const runInbound = operation(function* (input: InboundInput) {
  const { ctx, peer, request } = input
  const settled = yield* attempt(() => resolveInbound(input))
  const running = peer.running.get(request.cid)

  if (isFailure(settled)) {
    peer.running.delete(request.cid)
    post(peer, {
      k: 'reply-failure',
      cid: request.cid,
      failure: toWireFailure(settled, { status: statusFor(settled) }),
    })

    if (running?.cancelled) {
      postOutcome({ ctx, peer, request, state: 'failed', error: String(settled.error) })
    }

    return
  }

  const reply = settled.value

  yield* deliverReply({ ctx, peer, request, reply })
  peer.running.delete(request.cid)

  // A detach-mode dispatch that outlived a `cancel` publishes its real outcome for the host store.
  if (running?.cancelled) {
    postOutcome({
      ctx,
      peer,
      request,
      state: reply.kind === 'failure' ? 'failed' : 'fulfilled',
      error: reply.kind === 'failure' ? reply.failure.error : undefined,
    })
  }
})

/** Sync entry for inbound `dispatch` envelopes — replay, register, then run boxed on the scope. */
const acceptInbound = (
  ctx: WorkerWire.Context,
  peer: WorkerWire.Peer,
  envelope: DispatchEnvelope,
): void => {
  const request: Request = {
    cid: envelope.cid,
    service: envelope.service,
    action: envelope.action,
    params: envelope.params,
    meta: envelope.meta ?? {},
    trace: envelope.trace,
    idempotencyKey: envelope.idempotencyKey,
  }

  if (request.idempotencyKey) {
    const cached = ctx.replies.get(request.idempotencyKey)

    if (cached) {
      post(peer, { k: 'ack', cid: request.cid })
      post(peer, { ...cached, cid: request.cid })
      logSync(ctx, {
        level: 'debug',
        message: 'duplicate dispatch replayed from the reply cache',
        data: { cid: request.cid, key: request.idempotencyKey },
      })

      return
    }
  }

  const signal = createFireableSignal()
  const mode =
    ctx.broker.registry.get(request.service)?.service.actions[request.action]?.meta.onDisconnect ??
    'cancel'
  // The input bridge is registered SYNCHRONOUSLY here — before the invoke spawns and before any
  // trailing `in:*` lane envelope can be processed — so no frame and no `useSource` is ever lost.
  const inputs = createInputBridge({ peer, envelope })
  const running: WorkerWire.RunningDispatch = {
    task: undefined,
    cancelled: false,
    inputs,
    signal,
    mode,
  }

  peer.running.set(request.cid, running)

  // box(): a failing dispatch must never crash the carrier scope (structured concurrency).
  running.task = ctx.scope.run(() =>
    box(() => runInbound({ ctx, peer, request, signal, sources: inputs?.sources })),
  )

  void Promise.resolve(running.task).catch(() => {})
}

/** Inbound `abandoned`: the caller is gone — fire the signal, keep the handler running. */
const abandonInbound = (peer: WorkerWire.Peer, cid: string): void => {
  peer.running.get(cid)?.signal.fire()
}

/** Inbound `cancel`: fire the abandon signal; halt unless the action declared `detach`. */
const cancelInbound = (peer: WorkerWire.Peer, cid: string): void => {
  const running = peer.running.get(cid)

  if (!running) {
    return
  }

  running.cancelled = true
  running.signal.fire()
  // The caller's input pumps died with its dispatch task — truncate the planes so a detach
  // handler draining them mid-stream raises instead of suspending forever.
  killBridge(
    running.inputs,
    fail(
      CoreErrors.Cancelled,
      'the caller abandoned this dispatch — its input lanes are truncated',
      `transport:worker cid:${cid}`,
    ) as unknown as Result.Failure<string>,
  )

  if (running.mode !== 'detach') {
    peer.running.delete(cid)

    if (running.task) {
      void Promise.resolve(running.task.halt()).catch(() => {})
    }
  }
}

/**
 * THE port message handler — deliberately synchronous so envelope ORDER is preserved (a
 * `reply-stream` must open its queue before the lane envelopes behind it are processed, a
 * `dispatch` must register its input bridge before the `in:*` lanes behind it). Only inbound
 * dispatch handlers hop onto the scope (boxed).
 */
export const createMessageHandler =
  (ctx: WorkerWire.Context, peer: WorkerWire.Peer) =>
  (raw: unknown): void => {
    const message = raw as WorkerWire.PortMessage

    if (!message || typeof message !== 'object' || typeof message.k !== 'string') {
      return
    }

    switch (message.k) {
      case 'online': {
        peer.online = true
        flushOutbox(ctx, peer)
        break
      }
      case 'ack': {
        peer.pending.get(message.cid)?.acked()
        break
      }
      case 'reply': {
        settlePending(
          peer,
          message.cid,
          succeed({
            kind: 'value',
            cid: message.cid,
            status: message.status,
            meta: message.meta ?? {},
            value: message.value,
          } as Reply),
        )
        break
      }
      case 'reply-failure': {
        const { failure } = message

        settlePending(
          peer,
          message.cid,
          succeed({
            kind: 'failure',
            cid: message.cid,
            status: failure.status ?? statusFor(fromWireFailure(failure)),
            meta: failure.meta ?? {},
            failure,
          } as Reply),
        )
        break
      }
      case 'reply-stream': {
        openStream(peer, message)
        break
      }
      case 'lane': {
        if (isInputLane(message.lane)) {
          peer.running.get(message.cid)?.inputs?.planes.get(message.lane)?.feed(message)
        } else {
          feedLane(peer, message)
        }
        break
      }
      case 'lane-credit': {
        grantCredit(peer, message)
        break
      }
      case 'outcome': {
        ctx.broker.outcomes.record(message.outcome)
        break
      }
      case 'event': {
        // Deliver on the local bus; never re-broadcast (and drop own echoes by origin).
        if (message.origin !== ctx.broker.nodeId) {
          ctx.broker.bus.emit(message.name, message.payload, message.trace)
        }
        break
      }
      case 'dispatch': {
        acceptInbound(ctx, peer, message)
        break
      }
      case 'abandoned': {
        abandonInbound(peer, message.cid)
        break
      }
      case 'cancel': {
        cancelInbound(peer, message.cid)
        break
      }
      default: {
        break
      }
    }
  }

interface DispatchViaInput {
  readonly ctx: WorkerWire.Context
  readonly peer: WorkerWire.Peer
  readonly dispatch: TransportDispatch
}

/**
 * Caller side of one dispatch: register the pending entry, post the dispatch envelope (with its
 * lane manifest), pump every source plane behind it as `in:*` lane envelopes, then suspend until
 * an incoming envelope settles it (or the peer dies — `Unavailable`). Abandonment posts a
 * NON-halting `abandoned` envelope; only the halt of this dispatch task itself (broker cancel
 * semantics, scope teardown) posts `cancel`.
 */
export const dispatchVia = operation(function* ({ ctx, peer, dispatch }: DispatchViaInput) {
  const { request } = dispatch
  const sources = dispatch.sources && dispatch.sources.size > 0 ? dispatch.sources : undefined

  if (sources) {
    for (const plane of sources.keys()) {
      if (plane !== DataType.multistream && plane !== DataType.stream) {
        return yield* fail(
          CoreErrors.Unsupported,
          `the worker carrier cannot move a "${plane}" source lane`,
          `transport:${ctx.name} dispatch cid:${request.cid}`,
        )
      }
    }
  }

  const resolvers = withResolvers<Result<Reply>>()
  const pending: WorkerWire.PendingDispatch = { settle: resolvers.resolve, acked: dispatch.acked }

  peer.pending.set(request.cid, pending)

  const unsubscribe = dispatch.signal?.onAbort(() => {
    post(peer, { k: 'abandoned', cid: request.cid })
  })

  // Runs on normal settles (entry already removed — no cancel) AND on halt teardown, where a
  // still-registered pending entry means the dispatch was torn down mid-flight → cancel semantics.
  yield* ensure(function* () {
    unsubscribe?.()

    if (peer.pending.delete(request.cid)) {
      post(peer, { k: 'cancel', cid: request.cid })
    }
  })

  const posted = postSafe(peer, {
    k: 'dispatch',
    v: WIRE_VERSION,
    cid: request.cid,
    service: request.service,
    action: request.action,
    trace: request.trace,
    params: request.params,
    meta: request.meta,
    idempotencyKey: request.idempotencyKey,
    lanes: sources
      ? { streams: sources.has(DataType.stream) ? 1 : 0, parts: sources.has(DataType.multistream) }
      : undefined,
  })

  if (posted) {
    peer.pending.delete(request.cid)

    return yield* posted
  }

  if (sources) {
    // Source planes stream BEHIND the dispatch envelope (port order); the pumps are children of
    // this dispatch and live exactly as long as it does.
    for (const [plane, source] of sources) {
      yield* fork(() =>
        pumpLane({ peer, cid: request.cid, lane: inputLaneOf(plane), plane, source }),
      )
    }
  }

  logSync(ctx, {
    level: 'debug',
    message: 'dispatch posted to worker',
    data: { cid: request.cid, service: request.service, action: request.action, peer: peer.index },
  })

  const settled = yield* resolvers.operation

  if (isFailure(settled)) {
    return yield* settled
  }

  return settled.value
})

/** Posts an `event` envelope to every live peer (payload clone failures are logged, not raised). */
export const postEvent = (ctx: WorkerWire.Context, event: TransportEvent): void => {
  const envelope: Wire.Envelope = {
    k: 'event',
    name: event.name,
    payload: event.payload,
    trace: event.trace,
    scope: event.scope,
    origin: event.origin,
  }

  for (const peer of ctx.peers) {
    if (peer.dead) {
      continue
    }

    const posted = postSafe(peer, envelope)

    if (posted) {
      logSync(ctx, {
        level: 'warn',
        message: 'event payload not structured-cloneable — dropped',
        data: { name: event.name, peer: peer.index },
      })
    }
  }
}
