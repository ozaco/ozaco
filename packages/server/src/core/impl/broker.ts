import { mapError, operation, useContext } from 'std:effect'
import { createEvent } from 'std:event'
import { getService, install } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { CoreErrors } from '../const'
import { Broker, Codec, Tracer, Transport } from '../definitions'
import { checkBrokerSettings, withCallSpan } from '../internal/call-helpers'
import { BrokerSettingContext } from '../internal/context'
import { findServiceId, resolveGroups, simplifyFailureCauses } from '../internal/helpers'
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
    const shortenCauses = options?.shortenCauses ?? true

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
        const op = Transport.actions.dispatchRoot({
          serviceName: raw.options.name,
          actionKey: raw.key,
          params,
          ...(options.streams === undefined
            ? {}
            : {
                streams: options.streams as AnyType,
              }),
          rawReq: options.rawReq,
          traceContext,
        })

        return yield* broker.shortenCauses ? mapError(op, simplifyFailureCauses) : op
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
