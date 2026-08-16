import {
  CoreErrors,
  decodeEnvelope,
  encodeEnvelope,
  invokeLocal,
  statusFor,
  toWireFailure,
} from 'server:core'
import type { Reply, Request, Wire } from 'server:core'
import { runSafe } from 'server:utils'
import {
  attempt,
  box,
  createQueue,
  ensure,
  flow,
  fork,
  operation,
  race,
  spawn,
  until,
  withResolvers,
} from 'std:effect'
import type { Operation, Task } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { Result } from 'std:result'

import { AckPolicy, DeliverPolicy, ReplayPolicy } from '@nats-io/jetstream'

import { NatsErrors } from '../errors'
import type { Nats } from '../types'

import { causesOf } from './failure'
import { openInputSources, OUTPUT_LANE, pumpFlowLane } from './lanes'
import { createRemoteSignal } from './signal'
import { durableOf } from './subjects'

type DispatchEnvelope = Extract<Wire.Envelope, { k: 'dispatch' }>

interface Arm<T> {
  readonly t: string
  readonly value: T
}

/** Tags a race arm so the winner is identifiable (losing arms are halted, never the task). */
const arm = <T>(t: string, factory: () => Operation<T>): Operation<Arm<T>> => ({
  *[Symbol.iterator]() {
    const value = yield* factory()

    return { t, value }
  },
})

/** Owner-side truth for `outcome(cid)` — written ONLY when the caller cannot get the reply. */
const publishOutcome = operation(function* (ctx: Nats.Context, record: Wire.OutcomeRecord) {
  const encoded = yield* encodeEnvelope({ k: 'outcome', cid: record.cid, outcome: record })
  const published = yield* attempt(() =>
    until(ctx.js.publish(ctx.subjects.outcome(record.cid), encoded, { msgID: record.cid })),
  )

  if (isFailure(published)) {
    yield* ctx.log.error('outcome publish failed', {
      cid: record.cid,
      state: record.state,
      causes: causesOf(published),
    })

    return
  }

  yield* ctx.log.debug('outcome recorded', { cid: record.cid, state: record.state })
})

/**
 * Runs ONE consumed dispatch: rebuild the request, arm the control subject (cancel/abandoned),
 * open the declared input lanes, run `invokeLocal` (the ack envelope fires the moment the handler
 * starts), then publish the reply with full fidelity. When the caller cancelled — or abandoned
 * the dispatch, or the reply cannot be delivered — the outcome record is published so
 * `outcome(cid)` finds the truth.
 */
const handleDispatch = operation(function* (ctx: Nats.Context, envelope: DispatchEnvelope) {
  const { cid } = envelope
  const requestId = envelope.trace.requestId
  const log = ctx.log.child({ cid, requestId })
  const replySubject = ctx.subjects.reply(cid)

  const publishReply = (reply: Wire.Envelope) =>
    box(function* () {
      ctx.nc.publish(replySubject, yield* encodeEnvelope(reply))
    })

  const entry = ctx.broker.registry.get(envelope.service)

  if (!entry) {
    yield* log.warn('dispatch for a service this node no longer hosts', {
      service: envelope.service,
    })
    yield* publishReply({
      k: 'reply-failure',
      cid,
      failure: {
        error: CoreErrors.NoRoute,
        message: `service "${envelope.service}" is not registered on this node`,
        causes: [`transport:nats consume cid:${cid}`],
        status: 404,
      },
    })

    return
  }

  const request: Request = {
    cid,
    service: envelope.service,
    action: envelope.action,
    params: envelope.params,
    meta: envelope.meta ?? {},
    trace: envelope.trace,
    idempotencyKey: envelope.idempotencyKey,
  }

  const outcomeBase = { cid, serviceId: entry.serviceId, actionId: envelope.trace.actionId }
  const signal = createRemoteSignal()
  const aborted = withResolvers<void>()
  let cancelled = false
  let abandoned = false

  // Armed BEFORE the handler starts. A PLAIN subscription: `abandoned` may be followed by
  // `cancel` (cancel-after-abandoned is valid). The callback lives in plain JS-land and only
  // ferries bytes — decoding and routing by `k` happens in effect-land in the fork below.
  const control = createQueue<Uint8Array, never>()
  const cancelSub = ctx.nc.subscribe(ctx.subjects.cancel(cid), {
    callback: (error, msg) => {
      if (!error) {
        control.add(msg.data)
      }
    },
  })

  yield* ensure(() => {
    cancelSub.unsubscribe()
  })

  yield* fork(function* () {
    while (true) {
      const item = yield* control.next()
      const decoded = yield* box(() => decodeEnvelope(item.value))

      if (isFailure(decoded)) {
        yield* log.warn('undecodable control envelope dropped', { causes: causesOf(decoded) })

        continue
      }

      if (decoded.value.k === 'abandoned') {
        // the caller moved on (detach / TimeoutPending) but wants the work finished: fire the
        // handler's signal WITHOUT halting, and remember that the reply may find nobody
        abandoned = true
        signal.fire()

        continue
      }

      if (decoded.value.k === 'cancel') {
        cancelled = true
        abandoned = true
        signal.fire()
        aborted.resolve(undefined as void)
      }
    }
  })

  const ackPayload = yield* encodeEnvelope({ k: 'ack', cid })

  if (cancelled) {
    // the cancel raced ahead of the invoke — the handler never starts
    yield* publishOutcome(ctx, { ...outcomeBase, state: 'cancelled', ts: Date.now() })

    return
  }

  // input lanes for the planes the ACTION declares ∩ the caller announced — readers (and their
  // ephemeral consumers) are forks of this dispatch, torn down when it settles
  const action = entry.service.actions[envelope.action]
  const sources = action
    ? yield* openInputSources(ctx, {
        cid,
        declared: action.meta.wire.input,
        lanes: envelope.lanes,
      })
    : undefined

  const running: Task<Result<Reply>> = yield* spawn(() =>
    box(() =>
      invokeLocal({
        entry,
        request,
        signal,
        sources,
        acked: () => {
          ctx.nc.publish(replySubject, ackPayload)
        },
      }),
    ),
  )

  // Awaits the boxed task without racing IT (racing the task itself would halt it): the settle
  // arm resolves the boxed Result and rejects only on halt; the abort arm wins on cancel.
  const first = (yield* race([
    arm('settled', () =>
      attempt(() => until(Promise.resolve(running) as unknown as Promise<Result<Reply>>)),
    ),
    arm('cancelled', () => aborted.operation),
  ])) as Arm<unknown>

  if (first.t === 'cancelled') {
    yield* running.halt()
    yield* log.warn('dispatch cancelled by the caller', {
      service: envelope.service,
      action: envelope.action,
    })
    yield* publishOutcome(ctx, { ...outcomeBase, state: 'cancelled', ts: Date.now() })

    return
  }

  const outer = first.value as Result<Result<Reply>>
  const settled: Result<Reply> = isFailure(outer) ? outer : outer.value

  if (isFailure(settled)) {
    // an infrastructure fault inside the invoke — handler failures fold into a failure REPLY
    yield* log.error('invoke raised', {
      error: String(settled.error),
      causes: [...settled.causes],
    })

    const delivered = yield* publishReply({
      k: 'reply-failure',
      cid,
      failure: toWireFailure(settled, { status: statusFor(settled) }),
    })

    if (isFailure(delivered) || abandoned) {
      yield* publishOutcome(ctx, {
        ...outcomeBase,
        state: 'failed',
        ts: Date.now(),
        error: String(settled.error),
      })
    }

    return
  }

  const reply = settled.value

  if (reply.kind === 'failure') {
    const delivered = yield* publishReply({ k: 'reply-failure', cid, failure: reply.failure })

    if (isFailure(delivered) || abandoned) {
      yield* publishOutcome(ctx, {
        ...outcomeBase,
        state: 'failed',
        ts: Date.now(),
        error: reply.failure.error,
      })
    }

    return
  }

  if (reply.kind === 'value') {
    const delivered = yield* publishReply({
      k: 'reply',
      cid,
      value: reply.value,
      status: reply.status,
      meta: reply.meta,
    })

    if (isFailure(delivered)) {
      yield* log.error('reply publish failed — recording the outcome instead', {
        causes: causesOf(delivered),
      })
    }

    if (isFailure(delivered) || abandoned) {
      // an abandoned caller may never see the reply — the outcome stream keeps the truth
      yield* publishOutcome(ctx, { ...outcomeBase, state: 'fulfilled', ts: Date.now() })
    }

    return
  }

  const announced = yield* publishReply({
    k: 'reply-stream',
    cid,
    bytes: reply.bytes,
    status: reply.status,
    meta: reply.meta,
  })

  if (isFailure(announced)) {
    yield* publishOutcome(ctx, { ...outcomeBase, state: 'fulfilled', ts: Date.now() })

    return
  }

  yield* pumpFlowLane(ctx, {
    subject: ctx.subjects.lane(cid, OUTPUT_LANE),
    source: reply.flow,
    bytes: reply.bytes,
    label: `cid:${cid} req:${requestId}`,
  })

  if (abandoned) {
    yield* publishOutcome(ctx, { ...outcomeBase, state: 'fulfilled', ts: Date.now() })
  }
})

interface OwnerLoopInput {
  readonly service: string
  readonly durable: string
}

/**
 * The shared-durable consume loop of one hosted service. Every owner instance consumes the SAME
 * durable, so JetStream load-balances dispatches across them. Messages are acked immediately
 * (at-most-once) — retries belong to the fulfillment model, never to redelivery.
 */
const ownerLoop = operation(function* (ctx: Nats.Context, input: OwnerLoopInput) {
  const consumer = yield* until(ctx.js.consumers.get(ctx.streams.rpc, input.durable))
  const messages = yield* until(consumer.consume())

  yield* ensure(() => {
    messages.stop()
  })

  yield* ctx.log.debug('rpc consumer live', { service: input.service, durable: input.durable })

  const feed = yield* flow(messages)

  while (true) {
    const item = yield* feed.next()

    if (item.done) {
      return
    }

    const msg = item.value

    msg.ack()

    if (msg.redelivered) {
      yield* ctx.log.warn('redelivered rpc dispatch', { service: input.service, seq: msg.seq })
    }

    const decoded = yield* box(() => decodeEnvelope(msg.data))

    if (isFailure(decoded)) {
      yield* ctx.log.error('undecodable rpc dispatch dropped', {
        service: input.service,
        causes: causesOf(decoded),
      })

      continue
    }

    const dispatch = decoded.value

    if (dispatch.k !== 'dispatch') {
      continue
    }

    yield* ctx.log.debug('dispatch consumed', {
      cid: dispatch.cid,
      requestId: dispatch.trace.requestId,
      service: dispatch.service,
      action: dispatch.action,
    })

    // one boxed task per dispatch — a failing handler can never crash the transport scope
    void runSafe(ctx.scope, () => handleDispatch(ctx, dispatch))
  }
})

const guardedLoop = operation(function* (ctx: Nats.Context, input: OwnerLoopInput) {
  const ran = yield* attempt(() => ownerLoop(ctx, input))

  if (isFailure(ran)) {
    yield* ctx.log.error('rpc consume loop failed', {
      service: input.service,
      causes: causesOf(ran),
    })
  }
})

/**
 * Ensures the service's shared durable consumer exists (create-or-update, idempotent across
 * instances) and forks the consume loop for it. Called for every service already registered at
 * install time and on each later `service.registered` bus event.
 */
export const ensureOwner = operation(function* (ctx: Nats.Context, service: string) {
  if (ctx.owners.has(service)) {
    return
  }

  const durable = durableOf(ctx.queueGroup, service)
  const created = yield* attempt(() =>
    until(
      ctx.jsm.consumers.add(ctx.streams.rpc, {
        durable_name: durable,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        replay_policy: ReplayPolicy.Instant,
        max_deliver: 1,
        filter_subject: ctx.subjects.rpc(service),
      }),
    ),
  )

  if (isFailure(created)) {
    return yield* fail(
      NatsErrors.Consume,
      `the RPC consumer "${durable}" for service "${service}" could not be ensured`,
      ...causesOf(created),
    )
  }

  const task = ctx.scope.run(() => box(() => guardedLoop(ctx, { service, durable })))

  ctx.owners.set(service, task as Task<Result<void>>)
})

/**
 * Stops consuming for an unregistered service. The durable itself is NOT deleted — other
 * instances may share it; a durable with no consumers simply leaves dispatches unacked until the
 * caller's `TimeoutUnreached` fires (retry-safe by design).
 */
export const stopOwner = (ctx: Nats.Context, service: string): void => {
  const task = ctx.owners.get(service)

  if (task) {
    ctx.owners.delete(service)
    Promise.resolve(task.halt()).catch(() => undefined)
  }
}
