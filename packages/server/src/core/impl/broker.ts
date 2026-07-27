import { Codec } from 'std:codec'
import { mapError, operation, useContext, useScope } from 'std:effect'
import { createEvent } from 'std:event'
import { install } from 'std:plugin'
import { fail } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { CoreErrors, DataType, INTERNAL_ORIGIN } from '../const'
import { Broker, Policy, Tracer, Transport } from '../definitions'
import { checkBrokerSettings, withCallSpan } from '../internal/call-helpers'
import { BrokerSettingContext, patchSetting } from '../internal/context'
import {
  findServiceId,
  principalDiscriminator,
  resolveGroups,
  simplifyFailureCauses,
} from '../internal/helpers'
import { getNodeId, getServiceId } from '../internal/id'
import { carriedOf, valuesOf } from '../internal/wire'
import type { Action } from '../types/action'
import type { BrokerDef } from '../types/broker'
import type { Response } from '../types/common'
import type { PolicyDef } from '../types/policy'
import type { Service } from '../types/service'
import type { Source } from '../types/source'
import type { TransportDef } from '../types/transport'
import { ActionRequestContext, toRequestEnvelope, TraceContext } from '../utils/context'
import { fault } from '../utils/fault'
import { acceptsLane, producesLane } from '../utils/is'
import { resolvePolicySettings } from '../utils/policy'

import { DefaultTracer } from './tracer'
import { InternalTransport } from './transport'

/**
 * The whole call, once. {@link BrokerDef.Actions.call} takes the answer out of it; `exchange`
 * hands it over whole. One body, so the two can never drift in what a call actually does.
 */
// oxlint-disable-next-line max-params
const runCall = operation(function* (
  target: Service | string,
  path: string,
  sources: Source.Any[] = [],
  options: BrokerDef.CallOptions = {},
) {
  yield* checkBrokerSettings()

  const broker = yield* useContext(DefaultBrokerImpl)

  // The address is the two values the caller already has. Asking the plugin runtime which service
  // owned an action — the old `getService(target)` — meant a node holding no definition could not
  // address anything at all, which is exactly a gateway's position: mounted, never running.
  const serviceName = typeof target === 'string' ? target : target.name
  const actionMeta =
    typeof target === 'string'
      ? undefined
      : ((yield* target.actions._get(path)) as Action.Meta<unknown> | undefined)

  /**
   * Refuse a malformed source AT the boundary, where it can still be named.
   *
   * Left alone, an entry that is not a source is simply filtered out by kind — so the call went
   * through with no arguments and failed schema validation instead, which points at the action's
   * input rather than at the caller who passed a bare value where a source belongs.
   */
  const stray = sources.findIndex(
    source => !source || !Object.values(DataType).includes((source as Source.Any).type),
  )

  if (stray !== -1) {
    return yield* fault(
      CoreErrors.Validation,
      `sources[${stray}] is not a Source — expected one of ${Object.values(DataType).join(', ')}`,
      `${serviceName}.${path}`,
    )
  }

  // The value the policies key on. Sources travel whole; this is only the cache/bucket discriminator.
  const params = sources
    .filter(source => source.type === DataType.normal)
    .map(source => (source as Source.Normal).value)

  return yield* withCallSpan({ broker, serviceName, actionKey: path }, function* (traceContext) {
    // the ActionRequest envelope that carries `.meta` (auth headers etc.); propagated to remote
    // transports so a cross-node action can rebuild its request context, and reused below as the
    // per-principal policy discriminator.
    const actionRequest = yield* ActionRequestContext.get()

    const contexts: TransportDef.DispatchContexts = {
      trace: traceContext,
      ...(actionRequest === undefined ? {} : { request: toRequestEnvelope(actionRequest) }),
    }

    const req: TransportDef.DispatchRequest = {
      // INTERNAL unless someone says otherwise. A call nobody marked as coming from outside did
      // not come from outside, and the marker is a symbol so no payload can claim the other one.
      origin: options.origin ?? INTERNAL_ORIGIN,
      service: serviceName,
      path,
      meta: options.meta ?? {},
      sources,

      // What this call carries and what its answer will hold, projected from the declaration the
      // CALLER holds. A carrier needs `receives` before it sends: a return channel has to exist
      // before the answer does. Absent when the address was a bare name — then a carrier has to
      // be conservative, which is honest rather than silently wrong.
      ...(actionMeta === undefined
        ? {}
        : {
            wire: {
              sends: carriedOf(actionMeta.wire.input),
              receives: carriedOf(actionMeta.wire.output),
            },
          }),

      contexts,
    }

    const core = () => {
      const op = Transport.actions.dispatchRoot(req)
      return broker.shortenCauses ? mapError(op, simplifyFailureCauses) : op
    }

    const settings = yield* resolvePolicySettings(actionMeta)

    // derive the caller identity from the ActionRequest's headers (the request envelope that
    // actually carries `.meta`; the raw host Request does not). Kept SEPARATE from `key` so a
    // policy can opt out of per-principal isolation (vary:'none') — by default Cache/Bucket fold
    // it in, so identical-param calls from different principals never share a cache slot / batch.
    const principal = principalDiscriminator(actionRequest)

    const policyCtx: PolicyDef.DispatchContext = {
      req,
      serviceName,
      actionKey: path,
      action: actionMeta,
      settings,
      params,
      key: `${serviceName}\u0000${path}\u0000${yield* JsonCodec.actions.stringify(params)}`,
      principal,
      // From the DECLARATION, not from what the caller happened to pass. `options.streams`
      // only ever saw the inbound half, so an action that answers with a lane looked
      // non-streaming to every policy that asked.
      isStreaming: acceptsLane(actionMeta) || producesLane(actionMeta),
      trace: broker.trace,
    }

    // when tracing, run the policy chain under the call span so per-policy spans nest beneath
    // it; otherwise dispatch directly (byte-identical to the untraced path)
    return yield* broker.trace
      ? TraceContext.with(traceContext, () => Policy.actions.dispatchRoot(policyCtx, core))
      : Policy.actions.dispatchRoot(policyCtx, core)
  })
})

const DefaultBrokerImpl = Broker.implement({
  name: 'server/default-broker',
  version: '0.0.0',
  *setup(options?: BrokerDef.Options) {
    const name = options?.name ?? 'default-broker'
    const nodeId = options?.nodeId ?? (yield* getNodeId())
    const shortenCauses = options?.shortenCauses ?? true
    const trace = options?.trace ?? false

    const services: BrokerDef.Context['services'] = new Map(Object.entries(options?.services ?? {}))
    const bus: BrokerDef.Context['bus'] = createEvent()
    const scope = yield* useScope()

    if ((yield* Tracer.context.get()) === undefined) {
      yield* install(DefaultTracer)
    }
    if ((yield* Codec.context.get()) === undefined) {
      yield* install(JsonCodec)
    }

    yield* install(InternalTransport)

    return {
      name,
      nodeId,

      shortenCauses,
      trace,

      scope,

      services,
      bus,
    }
  },
})

export const DefaultBroker = DefaultBrokerImpl.build({
  start: operation(function* () {
    yield* patchSetting({ started: true })

    const ctx = yield* useContext(DefaultBrokerImpl)
    ctx.bus.emit('broker.started')
    return ctx
  }),

  isStarted: operation(function* () {
    return (yield* BrokerSettingContext.get())!.started
  }),

  pause: operation(function* (cause) {
    yield* patchSetting({ paused: cause })

    const ctx = yield* useContext(DefaultBrokerImpl)
    ctx.bus.emit('broker.paused')
  }),

  isPaused: operation(function* () {
    const brokerSettings = yield* BrokerSettingContext.get()

    if (brokerSettings?.destroying) {
      return 'destructing'
    }

    return brokerSettings!.paused
  }),

  resume: operation(function* () {
    yield* patchSetting({ paused: false })

    const ctx = yield* useContext(DefaultBrokerImpl)
    ctx.bus.emit('broker.resumed')
  }),

  destroy: operation(function* () {
    yield* patchSetting({ started: false, destroying: true })

    const ctx = yield* useContext(DefaultBrokerImpl)

    ctx.bus.emit('broker.stopped')
    ctx.bus.emit('broker.destroyed')

    ctx.services.clear()
    ctx.bus.clear()
  }),

  register: operation(function* (service, rawServiceName) {
    const serviceId = yield* getServiceId()
    const serviceName = `${rawServiceName ?? `${service.name}@${service.version}`}#${serviceId}`

    const ctx = yield* useContext(DefaultBrokerImpl)

    // Registering the SAME object twice is a no-op — a service that self-wires on install and an
    // app that also calls register by hand should not punish each other. A DIFFERENT service
    // claiming a name already taken is still a real clash and still fails.
    const existing = ctx.services.get(serviceName)

    if (existing === service) {
      return
    }
    if (existing !== undefined) {
      return yield* fault(CoreErrors.Exists, `service "${serviceName}" already registered`)
    }

    ctx.services.set(serviceName, service)
    ctx.bus.emit('service.registered', service)
  }),

  unregister: operation(function* (target) {
    const ctx = yield* useContext(DefaultBrokerImpl)

    if (typeof target === 'string') {
      if (!ctx.services.has(target)) {
        return yield* fail(CoreErrors.NotFound, `service "${target}" not registered`)
      }
      ctx.services.delete(target)
      ctx.bus.emit('service.unregistered', target)
      return
    }

    const id = findServiceId(ctx.services, target)
    if (!id) {
      return yield* fail(CoreErrors.NotFound, `service "${target.name}" not registered`)
    }

    ctx.services.delete(id)
    ctx.bus.emit('service.unregistered', target)
  }),

  /**
   * The answer, and only the answer.
   *
   * A service asking another service wants what it RETURNED; a status is a surface's concern, and
   * making every one of these unwrap an envelope to get past it was a tax on the common case.
   */
  // oxlint-disable-next-line max-params
  call: operation(function* (
    target: Service | string,
    path: string,
    sources: Source.Any[] = [],
    options: BrokerDef.CallOptions = {},
  ) {
    const response = (yield* runCall(target, path, sources, options)) as Response
    return valuesOf(response.sources)[0]
  }),

  emit: operation(function* (name, payload, groups) {
    const ctx = yield* useContext(DefaultBrokerImpl)
    const resolved = resolveGroups(ctx.services, groups)
    // the span the emitter is inside travels WITH the event — a DB change fanning out across
    // nodes used to lose its trace parent the moment it left the process
    const trace = yield* TraceContext.get()

    // the ROOT router, not the protocol's single-impl slot: `Transport.actions.emit` reaches only
    // the last-installed carrier, which is how the delivery contract silently skipped every other
    // one (dispatch had learned this lesson already — see `dispatchRoot` above)
    yield* Transport.actions.emitRoot({
      name,
      payload,
      origin: ctx.nodeId,
      ...(resolved ? { groups: resolved } : {}),
      ...(trace ? { traceContext: trace } : {}),
    })
  }),

  /** The same call, answered whole — status, headers and every source the action produced. */
  // oxlint-disable-next-line max-params
  exchange: operation(function* (
    target: Service | string,
    path: string,
    sources: Source.Any[] = [],
    options: BrokerDef.CallOptions = {},
  ) {
    return (yield* runCall(target, path, sources, options)) as Response
  }) as BrokerDef.Actions['exchange'],

  broadcast: operation(function* (name, payload, groups) {
    const ctx = yield* useContext(DefaultBrokerImpl)
    const resolved = resolveGroups(ctx.services, groups)
    const trace = yield* TraceContext.get()

    yield* Transport.actions.broadcastRoot({
      name,
      payload,
      origin: ctx.nodeId,
      ...(resolved ? { groups: resolved } : {}),
      ...(trace ? { traceContext: trace } : {}),
    })
  }),

  on: operation(function* (name, listener) {
    return (yield* useContext(DefaultBrokerImpl)).bus.on(name, listener)
  }),

  /**
   * Is this address served, and from where — without running anything to find out.
   *
   * The previous router had no such question: it dispatched, caught the failure and asked a
   * predicate whether to try the next carrier. Because that predicate keyed on `not-found`, an
   * action's own 404 looked exactly like "not hosted here" and the body ran a second time on
   * another node, side effects included.
   */
  hosts: operation(function* (target: Service | string, path: string) {
    const ctx = yield* useContext(DefaultBrokerImpl)
    const name = typeof target === 'string' ? target : target.name

    for (const [registered, service] of ctx.services) {
      const mine = registered.startsWith(`${name}@`) || service.name === name

      if (mine && (yield* service.actions._has(path))) {
        return true
      }
    }

    return false
  }),

  getServices: operation(function* () {
    return (yield* useContext(DefaultBrokerImpl)).services
  }),

  listActions: operation(function* () {
    const ctx = yield* useContext(DefaultBrokerImpl)
    const result: { service: Service; action: Action }[] = []

    for (const service of ctx.services.values()) {
      // the service's own table, not a walk over `service.actions` — that is a proxy, and it
      // answers every key with another callable proxy rather than with `undefined`
      for (const [, action] of yield* service.actions._list()) {
        result.push({ service, action })
      }
    }

    return result
  }),
})
