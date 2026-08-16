import { correlationId, instanceId, moduleLogger } from 'server:utils'
import { hasCodec } from 'std:codec'
import type { Operation, Task } from 'std:effect'
import { attempt, operation, race, sleep, until, useScope, withResolvers } from 'std:effect'
import { createEvent } from 'std:event'
import { install } from 'std:plugin'
import type { Result } from 'std:result'
import { appendCauses, fail, isFailure, isJust } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { ACK_TIMEOUT_MS, OUTCOME_TTL_MS, REQUEST_TIMEOUT_MS } from '../const'
import { Broker, Policy, Transport } from '../definition'
import { CoreErrors } from '../errors'
import type { ActionMeta } from '../types/action'
import type { BrokerActions, BrokerContext, BrokerOptions, CallOptions } from '../types/broker'
import type { Reply, Request } from '../types/common'
import type { PolicyDispatch } from '../types/policy'
import type { Service } from '../types/service'
import type { Trace } from '../types/trace'
import type { TransportDispatch } from '../types/transport'
import { TraceContext } from '../utils/context'
import { childTrace, laneOf, rootTrace } from '../utils/trace'
import { fromWireFailure } from '../utils/wire'

import { BrokerRef } from './context'
import { createActionSignal, createOutcomeStore, createReplyCache } from './outcome'
import { InternalTransport } from './transport'

interface Arm<T> {
  readonly t: string
  readonly value: T
}

/** Tags a race arm so the winner is identifiable. Losing arms are halted, never the task. */
const arm = <T>(t: string, factory: () => Operation<T>): Operation<Arm<T>> => ({
  *[Symbol.iterator]() {
    const value = yield* factory()

    return { t, value }
  },
})

/**
 * Awaits a DETACHED dispatch task WITHOUT racing (and thus never halting) it. std's task promise
 * contract resolves a Result and never rejects (halts arrive as `fail('halted')`), so this is a
 * plain await bridged through `until`.
 */
const settleTask = (task: Task<Reply>): Operation<Result<Reply>> => ({
  *[Symbol.iterator]() {
    return yield* until(Promise.resolve(task) as Promise<Result<Reply>>)
  },
})

const requireLive = operation(function* () {
  const ctx = yield* BrokerRef.expect()

  if (ctx.state.destroyed) {
    return yield* fail(CoreErrors.Destroyed, `broker "${ctx.name}" is destroyed`)
  }

  if (!ctx.state.started) {
    return yield* fail(CoreErrors.Configuration, `broker "${ctx.name}" is not started`)
  }

  if (ctx.state.paused) {
    return yield* fail(CoreErrors.Paused, `broker "${ctx.name}" is paused`)
  }

  return ctx
})

interface FulfillmentInput {
  readonly ctx: BrokerContext
  readonly request: Request
  readonly meta: ActionMeta | undefined
  readonly options: CallOptions
  readonly targetServiceId: string | undefined
}

const watchDetached = operation(function* (input: {
  readonly ctx: BrokerContext
  readonly request: Request
  readonly serviceId: string
  readonly task: Task<Reply>
}) {
  const settled = yield* settleTask(input.task)
  const reply = isFailure(settled) ? undefined : settled.value
  const state = !reply || reply.kind === 'failure' ? 'failed' : 'fulfilled'

  input.ctx.outcomes.record({
    cid: input.request.cid,
    state,
    ts: Date.now(),
    serviceId: input.serviceId,
    actionId: input.request.trace.actionId,
    error: reply
      ? reply.kind === 'failure'
        ? reply.failure.error
        : undefined
      : String((settled as Result.Failure<unknown>).error),
  })

  yield* input.ctx.log.debug('detached dispatch settled', {
    cid: input.request.cid,
    state,
    requestId: input.request.trace.requestId,
  })
})

/**
 * The fulfillment wrapper around every transport dispatch:
 * - no ack within `ackTimeoutMs` → the work never started → `TimeoutUnreached` (retry-safe);
 * - acked but no reply within `timeoutMs` → outcome unknown → `TimeoutPending` + abandon handling
 *   per the action's `onDisconnect` (`cancel` halts the work, `detach` lets it finish and records
 *   the real outcome for `Broker.actions.outcome(cid)`).
 */
function* dispatchWithFulfillment(input: FulfillmentInput): Generator<unknown, Reply, unknown> {
  const { ctx, request, meta, options } = input
  const acked = withResolvers<void>()
  const signal = createActionSignal()
  let ackFired = false

  const dispatch: TransportDispatch = {
    request,
    signal,
    sources: options.sources,
    acked: () => {
      if (!ackFired) {
        ackFired = true
        acked.resolve(undefined as void)
      }
    },
  }

  const task = ctx.scope.run(() => Transport.actions.dispatchRoot(dispatch) as Operation<Reply>, {
    detached: true,
  })
  const done = () => settleTask(task)
  const settle = function* (result: Result<Reply>) {
    if (isFailure(result)) {
      return yield* result
    }

    return result.value
  }

  const ackTimeoutMs = options.ackTimeoutMs ?? ctx.options.ackTimeoutMs
  const requestTimeoutMs = options.timeoutMs ?? ctx.options.requestTimeoutMs

  const first = (yield* race(
    ackTimeoutMs > 0
      ? [
          arm('done', done),
          arm('ack', () => acked.operation),
          arm('ack-timeout', () => sleep(ackTimeoutMs)),
        ]
      : [arm('done', done), arm('ack', () => acked.operation)],
  )) as Arm<unknown>

  if (first.t === 'done') {
    return yield* settle(first.value as Result<Reply>)
  }

  if (first.t === 'ack-timeout') {
    yield* task.halt()

    return yield* fail(
      CoreErrors.TimeoutUnreached,
      `dispatch to "${request.service}.${request.action}" was not acknowledged within ${ackTimeoutMs}ms — the handler never started, retry is safe`,
      `transport: cid:${request.cid}`,
    )
  }

  if (requestTimeoutMs <= 0) {
    return yield* settle(yield* done())
  }

  const second = (yield* race([
    arm('done', done),
    arm('timeout', () => sleep(requestTimeoutMs)),
  ])) as Arm<unknown>

  if (second.t === 'done') {
    return yield* settle(second.value as Result<Reply>)
  }

  const mode = meta?.onDisconnect ?? 'cancel'
  const serviceId = input.targetServiceId ?? request.service

  signal.fire()

  if (mode === 'cancel') {
    yield* task.halt()

    ctx.outcomes.record({
      cid: request.cid,
      state: 'cancelled',
      ts: Date.now(),
      serviceId,
      actionId: request.trace.actionId,
    })
  } else {
    ctx.scope.run(() => watchDetached({ ctx, request, serviceId, task }), { detached: true })
  }

  return yield* fail(
    CoreErrors.TimeoutPending,
    `dispatch to "${request.service}.${request.action}" was acknowledged but no reply arrived within ${requestTimeoutMs}ms — outcome unknown, reconcile via Broker.actions.outcome("${request.cid}")`,
    `transport: cid:${request.cid} onDisconnect:${mode}`,
  )
}

interface ExchangeInput {
  readonly serviceRef: Service | string
  readonly action: string
  readonly params: unknown
  readonly options: CallOptions
}

const runExchange = operation(function* (input: ExchangeInput) {
  const ctx = yield* requireLive()

  const serviceName =
    typeof input.serviceRef === 'string' ? input.serviceRef : input.serviceRef.name
  const declared = typeof input.serviceRef === 'string' ? undefined : input.serviceRef
  const local = ctx.registry.get(serviceName)
  const meta = (local?.service ?? declared)?.actions[input.action]?.meta

  const parent = input.options.trace ?? (yield* TraceContext.get())
  const base =
    parent ??
    (yield* rootTrace({
      origin: input.options.origin ?? 'internal',
      serviceId: `${ctx.name}#${ctx.nodeId}`,
    }))
  const trace: Trace = yield* childTrace(base, {
    service: serviceName,
    action: input.action,
    transport: 'internal',
  })

  const cid = yield* correlationId()
  const request: Request = {
    cid,
    service: serviceName,
    action: input.action,
    params: input.params,
    meta: input.options.meta ?? {},
    trace,
    idempotencyKey: input.options.idempotencyKey,
  }

  if (request.idempotencyKey) {
    const cached = ctx.replies.get(request.idempotencyKey)

    if (cached) {
      return cached
    }
  }

  const key = `${serviceName}\0${input.action}\0${yield* JsonCodec.actions.stringify(
    input.params ?? null,
  )}`
  const dispatchCtx: PolicyDispatch = {
    key,
    principal: request.meta.authorization,
    streaming: meta ? meta.wire.streamingIn || meta.wire.streamingOut : false,
    trace,
    request,
    overrides: meta?.policies ?? {},
  }

  const terminal = () =>
    dispatchWithFulfillment({
      ctx,
      request,
      meta,
      options: input.options,
      targetServiceId: local?.serviceId,
    }) as Operation<Reply>

  const result = yield* attempt(() => Policy.actions.dispatchRoot(dispatchCtx, terminal))

  if (isFailure(result)) {
    appendCauses(
      result,
      `call:${serviceName}.${input.action} cid:${cid} req:${trace.requestId} lane:${laneOf(trace)}`,
    )

    return yield* result
  }

  const reply = result.value as Reply

  if (request.idempotencyKey && reply.kind !== 'failure') {
    ctx.replies.set(request.idempotencyKey, reply)
  }

  if ((input.options.outcome || meta?.outcome) && reply.kind !== 'stream') {
    ctx.outcomes.record({
      cid,
      state: reply.kind === 'failure' ? 'failed' : 'fulfilled',
      ts: Date.now(),
      serviceId: local?.serviceId ?? serviceName,
      actionId: trace.actionId,
      error: reply.kind === 'failure' ? reply.failure.error : undefined,
    })
  }

  return reply
})

const eventTrace = operation(function* () {
  const ctx = yield* BrokerRef.expect()
  const ambient = yield* TraceContext.get()

  return (
    ambient ??
    (yield* rootTrace({
      origin: 'internal',
      serviceId: `${ctx.name}#${ctx.nodeId}`,
    }))
  )
})

// oxlint-disable-next-line max-params
const callAction = operation(function* (
  serviceRef: Service | string,
  action: string,
  params?: unknown,
  options?: CallOptions,
) {
  const reply: Reply = yield* runExchange({
    serviceRef,
    action,
    params,
    options: options ?? {},
  })

  if (reply.kind === 'failure') {
    const name = typeof serviceRef === 'string' ? serviceRef : serviceRef.name
    const failure = fromWireFailure(reply.failure)

    appendCauses(failure, `call:${name}.${action} cid:${reply.cid}`)

    return yield* failure
  }

  return reply.kind === 'stream' ? reply.flow : reply.value
})

/**
 * The default dispatch kernel. Requires an installed IO impl (ids) — installs the JSON codec
 * baseline and the internal transport itself. Every call carries the Trace spine; every dispatch
 * goes through the policy onion and the fulfillment wrapper.
 */
export const DefaultBroker = Broker.implement<BrokerContext, [BrokerOptions?]>({
  name: 'default-broker',
  version: '0.1.0',
  *setup(options = {}) {
    if (!(yield* hasCodec())) {
      yield* install(JsonCodec)
    }

    const scope = yield* useScope()
    const log = yield* moduleLogger('server:core/broker')
    const node = yield* attempt(() => instanceId())

    if (isFailure(node)) {
      return yield* fail(
        CoreErrors.Configuration,
        'the broker requires an installed IO implementation — install BunIO/NodeIO/WebIO first',
        ...node.causes,
      )
    }

    const outcomeTtlMs = options.outcomeTtlMs ?? OUTCOME_TTL_MS
    const ctx: BrokerContext = {
      name: options.name ?? 'broker',
      nodeId: node.value,
      scope,
      log: log.child({ broker: options.name ?? 'broker' }),
      options: {
        ackTimeoutMs: options.ackTimeoutMs ?? ACK_TIMEOUT_MS,
        requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        outcomeTtlMs,
      },
      registry: new Map(),
      bus: createEvent<Record<string, [unknown, Trace?]>>(),
      outcomes: createOutcomeStore({ ttlMs: outcomeTtlMs }),
      replies: createReplyCache({ ttlMs: outcomeTtlMs }),
      state: { started: false, paused: false, destroyed: false },
    }

    yield* BrokerRef.set(ctx)
    yield* install(InternalTransport)
    yield* ctx.log.debug('broker ready', { nodeId: ctx.nodeId })

    return ctx
  },
}).build({
  start: operation(function* () {
    const ctx = yield* BrokerRef.expect()

    ctx.state.started = true

    yield* ctx.log.info('broker started', { nodeId: ctx.nodeId })
  }),

  isStarted: operation(function* () {
    const ctx = yield* BrokerRef.expect()

    return ctx.state.started && !ctx.state.destroyed
  }),

  pause: operation(function* () {
    const ctx = yield* BrokerRef.expect()

    ctx.state.paused = true

    yield* ctx.log.warn('broker paused', {})
  }),

  resume: operation(function* () {
    const ctx = yield* BrokerRef.expect()

    ctx.state.paused = false

    yield* ctx.log.info('broker resumed', {})
  }),

  isPaused: operation(function* () {
    const ctx = yield* BrokerRef.expect()

    return ctx.state.paused
  }),

  destroy: operation(function* () {
    const ctx = yield* BrokerRef.expect()

    ctx.state.destroyed = true
    ctx.state.started = false
    ctx.bus.clear()

    yield* ctx.log.info('broker destroyed', {})
  }),

  register: operation(function* (service: Service) {
    const ctx = yield* BrokerRef.expect()

    if (ctx.state.destroyed) {
      return yield* fail(CoreErrors.Destroyed, `broker "${ctx.name}" is destroyed`)
    }

    if (ctx.registry.has(service.name)) {
      return yield* fail(
        CoreErrors.Configuration,
        `service "${service.name}" is already registered`,
      )
    }

    const instance = yield* instanceId()
    const serviceId = `${service.name}@${service.version}#${instance}`

    if (service.setup) {
      yield* service.setup()
    }

    ctx.registry.set(service.name, { service, serviceId })
    ctx.bus.emit('service.registered', { name: service.name, serviceId })

    yield* ctx.log.debug('service registered', { service: service.name, serviceId })
  }),

  unregister: operation(function* (service: Service | string) {
    const ctx = yield* BrokerRef.expect()
    const name = typeof service === 'string' ? service : service.name

    ctx.registry.delete(name)
    ctx.bus.emit('service.unregistered', { name })

    yield* ctx.log.debug('service unregistered', { service: name })
  }),

  hosts: operation(function* (service: Service | string) {
    const ctx = yield* BrokerRef.expect()
    const name = typeof service === 'string' ? service : service.name

    if (ctx.registry.has(name)) {
      return true
    }

    const transports = yield* Transport.actions.getTransports()

    for (const entry of transports) {
      const hosted = yield* entry.actions.hosts(name)

      if (isJust(hosted) && hosted.value) {
        return true
      }
    }

    return false
  }),

  getServices: operation(function* () {
    const ctx = yield* BrokerRef.expect()

    return [...ctx.registry.keys()]
  }),

  call: callAction as BrokerActions['call'],

  // oxlint-disable-next-line max-params
  exchange: operation(function* (
    serviceRef: Service | string,
    action: string,
    params?: unknown,
    options?: CallOptions,
  ) {
    return yield* runExchange({ serviceRef, action, params, options: options ?? {} })
  }),

  emit: operation(function* (name: string, payload?: unknown) {
    const ctx = yield* BrokerRef.expect()
    const trace = yield* eventTrace()

    yield* Transport.actions.emitRoot({
      name,
      payload,
      trace,
      scope: 'emit',
      origin: ctx.nodeId,
    })
  }),

  broadcast: operation(function* (name: string, payload?: unknown) {
    const ctx = yield* BrokerRef.expect()
    const trace = yield* eventTrace()

    yield* Transport.actions.broadcastRoot({
      name,
      payload,
      trace,
      scope: 'broadcast',
      origin: ctx.nodeId,
    })
  }),

  on: operation(function* (name: string, handler: (payload: unknown, trace?: Trace) => void) {
    const ctx = yield* BrokerRef.expect()

    return ctx.bus.on(name, handler)
  }),

  outcome: operation(function* (cid: string) {
    const ctx = yield* BrokerRef.expect()

    return ctx.outcomes.get(cid)
  }),
})
