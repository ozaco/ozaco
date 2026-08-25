import { createEvent } from 'std:event'
import { IO } from 'std:io'
import type { AnyType } from 'std:shared'

import pkg from '../../../package.json'
import { DEFAULT_TIMEOUT_MS, serviceIdOf } from '../const'
import { TraceRef } from '../context'
import { callLocal, runDispatch } from '../internal/dispatch'
import { actionsOf, asRequest, callRemote, carrierOf, traceFor } from '../internal/kernel'
import { buildRegistry, manifestOf } from '../internal/registry'
import type { ServerDef } from '../types/server'
import { childTrace, report, rootTrace, toWire, withSpan } from '../utils/trace'

import { Server } from './protocol'

/** The kernel: one per scope, installed FIRST by {@link createServer}. */
const ServerImpl = Server.implement<ServerDef.Context, [options: ServerDef.Options]>({
  name: 'server-kernel',
  version: pkg.version,
  description: 'The service/action kernel',

  *setup(options) {
    const name = options.name ?? 'app'
    const version = options.version ?? '0.0.0'
    const instance = options.instance ?? (yield* IO.actions.uuid()).slice(0, 8)
    const registry = yield* buildRegistry(options.services)
    return {
      name,
      version,
      instance,
      serviceId: serviceIdOf(name, version, instance),
      registry,
      hooks: [],
      options: new Map(),
      events: createEvent<ServerDef.Events>(),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      carrier: null,
      edge: null,
      outcomes: null,
      hosted: new Set(options.hosted ?? registry.services.keys()),
      kv: false,
      inflight: 0,

      sockets: registry.sockets.map(socket => ({
        path: socket.path,
        service: socket.service,
        protocol: socket.protocol,
        description: socket.description,
        defaults: null,
      })),
    }
  },
})

export const ServerClient: ServerDef.Client = ServerImpl.build({
  *describe() {
    return yield* Server.context.expect()
  },

  *dispatch(call) {
    const kernel = yield* Server.context.expect()
    if (!kernel.hosted.has(call.service) && kernel.registry.services.has(call.service)) {
      // a gateway: the edge's call goes over the carrier to whoever hosts the service
      return yield* TraceRef.with(call.trace, () =>
        callRemote(kernel, {
          trace: call.trace,
          service: call.service,
          action: call.action,
          input: call.input,
          deadline: call.deadline,
          idempotencyKey: call.idempotencyKey,
          meta: call.headers,
        }),
      )
    }
    return yield* runDispatch(kernel, call, actionsOf(kernel))
  },

  *call(target, input, options) {
    const kernel = yield* Server.context.expect()
    const isRoot = (yield* TraceRef.get()) === undefined
    const trace = yield* traceFor(kernel, target.service, target.action)
    const timeoutMs = options?.timeoutMs ?? kernel.timeoutMs
    if (isRoot) {
      // a call from outside any dispatch is a request of its own (origin: internal)
      return yield* asRequest({
        kernel,
        trace,
        target,
        body: () => ServerClient.actions.call(target, input, options),
      })
    }
    if (kernel.hosted.has(target.service)) {
      return (yield* callLocal({
        kernel,
        trace,
        service: target.service,
        action: target.action,
        input,
        headers: options?.meta ?? {},
        timeoutMs,
        idempotencyKey: options?.idempotencyKey,
        transport: 'local',
        actions: actionsOf(kernel),
      })) as AnyType
    }
    // remote: the carrier finds whoever serves it
    return (yield* callRemote(kernel, {
      trace,
      service: target.service,
      action: target.action,
      input,
      deadline: Date.now() + timeoutMs,
      idempotencyKey: options?.idempotencyKey,
      meta: options?.meta,
    })) as AnyType
  },

  *emit(name, payload) {
    const kernel = yield* Server.context.expect()
    const carrier = yield* carrierOf(kernel)
    const trace = yield* TraceRef.get()
    yield* carrier.actions.emit({
      k: 'event',
      name,
      payload,
      origin: kernel.serviceId,
      trace: trace ? toWire(trace) : undefined,
    })
    yield* report(kernel, {
      t: 'event',
      row: {
        request_id: trace?.request_id ?? null,
        kind: 'emit',
        name,
        size: null,
        ts: Date.now(),
      },
    })
  },

  events: (name?: string) => ({
    *[Symbol.iterator]() {
      const kernel = yield* Server.context.expect()
      const carrier = yield* carrierOf(kernel)
      const subscription = yield* carrier.actions.events()
      return {
        *next() {
          for (;;) {
            const step = yield* subscription.next()
            if (step.done) {
              continue
            }
            if (name === undefined || step.value.name === name) {
              return { done: false as const, value: step.value }
            }
          }
        },
      }
    },
  }),

  *manifest() {
    return manifestOf(yield* Server.context.expect())
  },

  *span(name, body, options) {
    const kernel = yield* Server.context.expect()
    const parent = options?.parent ?? (yield* TraceRef.get())
    const trace = parent
      ? yield* childTrace(parent)
      : yield* rootTrace(kernel.serviceId, options?.origin ?? 'internal', options?.requestId)
    return yield* withSpan(
      { kernel, trace, kind: options?.kind ?? 'custom', name, attrs: options?.attrs },
      () => body(trace),
    )
  },
})
