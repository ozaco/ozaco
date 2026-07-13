import { Codec } from 'std:codec'
import { mapError, operation, useContext } from 'std:effect'
import { createEvent } from 'std:event'
import { getService, install } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import { CoreErrors } from '../const'
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
import type { Action } from '../types/action'
import type { BrokerDef } from '../types/broker'
import type { PolicyDef } from '../types/policy'
import type { Service } from '../types/service'
import type { TransportDef } from '../types/transport'
import { ActionRequestContext, toRequestEnvelope, TraceContext } from '../utils/context'
import { resolvePolicySettings } from '../utils/policy'

import { DefaultTracer } from './tracer'
import { InternalTransport } from './transport'

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

    if (ctx.services.has(serviceName)) {
      return yield* fail(CoreErrors.Exists, `service "${serviceName}" already registered`)
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

  call: operation(function* (
    target: Action,
    params: unknown[] = [],
    options: BrokerDef.CallOptions = {},
  ) {
    yield* checkBrokerSettings()

    const broker = yield* useContext(DefaultBrokerImpl)
    const raw = yield* getService(target)

    return yield* withCallSpan(
      { broker, serviceName: raw.options.name, actionKey: raw.key },
      function* (traceContext) {
        // the ActionRequest envelope that carries `.meta` (auth headers etc.); propagated to remote
        // transports so a cross-node action can rebuild its request context, and reused below as the
        // per-principal policy discriminator.
        const actionRequest = yield* ActionRequestContext.get()

        const contexts: TransportDef.DispatchContexts = {
          trace: traceContext,
          ...(options.rawReq === undefined ? {} : { raw: options.rawReq }),
          ...(actionRequest === undefined ? {} : { request: toRequestEnvelope(actionRequest) }),
        }

        const req = {
          serviceName: raw.options.name,
          actionKey: raw.key,
          params,
          ...(options.streams === undefined
            ? {}
            : {
                streams: options.streams as AnyType,
              }),
          contexts,
        }

        const core = () => {
          const op = Transport.actions.dispatchRoot(req)
          return broker.shortenCauses ? mapError(op, simplifyFailureCauses) : op
        }

        const actionMeta = raw.meta as Action.Meta<unknown> | undefined
        const settings = yield* resolvePolicySettings(actionMeta)

        // derive the caller identity from the ActionRequest's headers (the request envelope that
        // actually carries `.meta`; the raw host Request does not). Kept SEPARATE from `key` so a
        // policy can opt out of per-principal isolation (vary:'none') — by default Cache/Bucket fold
        // it in, so identical-param calls from different principals never share a cache slot / batch.
        const principal = principalDiscriminator(actionRequest)

        const policyCtx: PolicyDef.DispatchContext = {
          req,
          serviceName: raw.options.name,
          actionKey: raw.key,
          action: actionMeta,
          settings,
          params,
          key: `${raw.options.name}\u0000${raw.key}\u0000${yield* JsonCodec.actions.stringify(params)}`,
          principal,
          isStreaming: options.streams !== undefined,
          trace: broker.trace,
        }

        // when tracing, run the policy chain under the call span so per-policy spans nest beneath
        // it; otherwise dispatch directly (byte-identical to the untraced path)
        return yield* broker.trace
          ? TraceContext.with(traceContext, () => Policy.actions.dispatchRoot(policyCtx, core))
          : Policy.actions.dispatchRoot(policyCtx, core)
      },
    )
  }) as BrokerDef.Actions['call'],

  emit: operation(function* (name, payload, groups) {
    const ctx = yield* useContext(DefaultBrokerImpl)
    const resolved = resolveGroups(ctx.services, groups)

    yield* Transport.actions.emit(
      resolved ? { name, payload, groups: resolved } : { name, payload },
    )
  }),

  broadcast: operation(function* (name, payload, groups) {
    const ctx = yield* useContext(DefaultBrokerImpl)
    const resolved = resolveGroups(ctx.services, groups)

    yield* Transport.actions.broadcast(
      resolved ? { name, payload, groups: resolved } : { name, payload },
    )
  }),

  on: operation(function* (name, listener) {
    return (yield* useContext(DefaultBrokerImpl)).bus.on(name, listener)
  }),

  getService: operation(function* (target) {
    const ctx = yield* useContext(DefaultBrokerImpl)

    if (typeof target === 'string') {
      const service = ctx.services.get(target)
      if (!service) {
        return yield* fail(CoreErrors.NotFound, `service "${target}" not found`)
      }
      return service
    }

    const id = findServiceId(ctx.services, target)
    if (!id) {
      return yield* fail(CoreErrors.NotFound, `service "${target.name}" not registered`)
    }
    return id
  }) as BrokerDef.Actions['getService'],

  getServices: operation(function* () {
    return (yield* useContext(DefaultBrokerImpl)).services
  }),

  listActions: operation(function* () {
    const ctx = yield* useContext(DefaultBrokerImpl)
    const result: { service: Service; action: Action }[] = []

    for (const service of ctx.services.values()) {
      for (const key of service.getKeys()) {
        result.push({
          service,
          action: (service.actions as Record<string, Action>)[key]!,
        })
      }
    }

    return result
  }),
})
