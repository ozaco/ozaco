import { operation, useContext } from 'std:effect'
import { createEvent } from 'std:event'
import { getService, install } from 'std:plugin'
import { asFailure, fail } from 'std:result'

import { CoreErrors, OTEL_RPC_SYSTEM, OtelAttrs, OtelSpanKind, OtelSpanStatusCode } from '../const'
import { Broker, Codec, Tracer, Transport } from '../definitions'
import { BrokerSettingContext } from '../internal/context'
import { findServiceId, resolveGroups } from '../internal/helpers'
import { getNodeId, getServiceId } from '../internal/id'
import type { Action } from '../types/action'
import type { BrokerDef } from '../types/broker'
import type { Service } from '../types/service'

import { JsonCodec } from './codec'
import { DefaultTracer } from './tracer'
import { InternalTransport } from './transport'

const DefaultBrokerImpl = Broker.implement({
  name: 'server/default-broker',
  version: '0.0.0',
  *setup(options?: BrokerDef.Options) {
    const name = options?.name ?? 'default-broker'
    const nodeId = options?.nodeId ?? (yield* getNodeId())

    const services: BrokerDef.Context['services'] = new Map(Object.entries(options?.services ?? {}))
    const bus: BrokerDef.Context['bus'] = createEvent()

    if ((yield* Tracer.context.get()) === undefined) {
      yield* install(DefaultTracer)
    }
    if ((yield* Codec.context.get()) === undefined) {
      yield* install(JsonCodec)
    }
    if ((yield* Transport.context.get()) === undefined) {
      yield* install(InternalTransport)
    }

    return {
      name,
      nodeId,

      services,
      bus,
    }
  },
})

export const DefaultBroker = DefaultBrokerImpl.build({
  start: operation(function* () {
    yield* BrokerSettingContext.set({
      ...(yield* BrokerSettingContext.get())!,

      started: true,
    })

    const ctx = yield* useContext(DefaultBrokerImpl)
    ctx.bus.emit('broker.started')
    return ctx
  }),

  isStarted: operation(function* () {
    return (yield* BrokerSettingContext.get())!.started
  }),

  pause: operation(function* (cause) {
    yield* BrokerSettingContext.set({
      ...(yield* BrokerSettingContext.get())!,

      paused: cause,
    })

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
    yield* BrokerSettingContext.set({
      ...(yield* BrokerSettingContext.get())!,

      paused: false,
    })

    const ctx = yield* useContext(DefaultBrokerImpl)
    ctx.bus.emit('broker.resumed')
  }),

  destroy: operation(function* () {
    yield* BrokerSettingContext.set({
      ...(yield* BrokerSettingContext.get())!,

      started: false,
      destroying: true,
    })

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

  call: operation(function* (target: Action, params: unknown[] = [], rawReq: unknown = undefined) {
    const settings = (yield* BrokerSettingContext.get())!

    if (settings.destroying) {
      return yield* fail(CoreErrors.BrokerInternal, 'broker is being destroyed')
    }
    if (settings.paused) {
      return yield* fail(CoreErrors.BrokerPaused, `broker is paused: ${settings.paused}`)
    }
    if (!settings.started) {
      return yield* fail(CoreErrors.BrokerInternal, 'broker is not started')
    }

    const ctx = yield* useContext(DefaultBrokerImpl)
    const raw = yield* getService(target)

    const span = yield* Tracer.actions.startSpan(`${raw.options.name}.${raw.key}`, {
      kind: OtelSpanKind.CLIENT,
      attributes: {
        [OtelAttrs.RPC_SYSTEM]: OTEL_RPC_SYSTEM,
        [OtelAttrs.RPC_SERVICE]: raw.options.name,
        [OtelAttrs.RPC_METHOD]: raw.key,
        [OtelAttrs.BROKER_NAME]: ctx.name,
        [OtelAttrs.BROKER_NODE_ID]: ctx.nodeId,
      },
    })

    const spanContextValue = yield* span.spanContext()

    try {
      return yield* Transport.actions.dispatchRoot({
        serviceName: raw.options.name,
        actionKey: raw.key,
        params,
        rawReq,
        traceContext: spanContextValue,
      })
    } catch (error) {
      const failure = asFailure(error)

      yield* span.recordException(failure)
      yield* span.setStatus({
        code: OtelSpanStatusCode.ERROR,
        message: failure.message,
        cause: failure.causes,
      })

      yield* failure
    } finally {
      yield* span.end()
    }
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
