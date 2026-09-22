import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { createEvent } from 'std:event'
import { IO } from 'std:io'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import pkg from '../../../package.json'
import { DEFAULT_TIMEOUT_MS, serviceIdOf } from '../const'
import { TraceRef } from '../context'
import { ServerErrors } from '../errors'
import { roleOf } from '../internal/app'
import { parseCall } from '../internal/call'
import { callLocal, runDispatch } from '../internal/dispatch'
import {
  actionsOf,
  asRequest,
  callRemote,
  carrierOf,
  serverFor,
  traceFor,
} from '../internal/kernel'
import { buildRegistry, manifestOf, reloadRegistry, socketInfoOf } from '../internal/registry'
import type { ServerDef } from '../types/server'
import type { ServiceDef } from '../types/service'
import { childTrace, report, rootTrace, toWire, withSpan } from '../utils/trace'

import { Server } from './protocol'

/** One call, TraceRef already decided: local when hosted here, over the carrier otherwise. */
function* performCall(
  kernel: ServerDef.Context,
  target: { readonly service: string; readonly action: string },
  rest: readonly [unknown?, ServerDef.CallOptions?],
): Operation<unknown> {
  const [input, options] = rest
  const trace = yield* traceFor(kernel, target.service, target.action)
  const timeoutMs = options?.timeoutMs ?? kernel.timeoutMs

  if (kernel.hosted.has(target.service)) {
    return yield* callLocal({
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
    })
  }

  // remote: the carrier finds whoever serves it
  return yield* callRemote(kernel, {
    trace,
    service: target.service,
    action: target.action,
    input,
    deadline: Date.now() + timeoutMs,
    idempotencyKey: options?.idempotencyKey,
    meta: options?.meta,
  })
}

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
      exporting: false,
      role: roleOf(options),
      hosted: new Set(options.hosted ?? registry.services.keys()),
      pluginServices: new Set(),
      inflight: 0,

      routes: [],
      sockets: registry.sockets.map(socketInfoOf),
    }
  },
})

export const ServerClient: ServerDef.Client = ServerImpl.build({
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

  *call(service: ServiceDef.Service, action: string, ...rest: [unknown?, ServerDef.CallOptions?]) {
    // two spellings, one parser (`parseCall`): the service DEFINITION plus an action name, or a
    // typed REF (`server.api.todos.list`, `refs<typeof todos>('todos').list`)
    const parsed = parseCall(service, [action, ...rest])

    if (!parsed) {
      return yield* fail(
        ServerErrors.Configuration,
        `call takes a service DEFINITION plus an action name (ctx.call(reports, 'summary', input)) or a ref (ctx.call(api.reports.summary, input))`,
      )
    }

    const target = { service: parsed.service, action: parsed.action }
    const tail = [parsed.input, parsed.options] as [unknown?, ServerDef.CallOptions?]
    const kernel = yield* Server.context.expect()
    const isRoot = (yield* TraceRef.get()) === undefined
    if (isRoot) {
      // a call from outside any dispatch is a request of its own (origin: internal)
      const trace = yield* traceFor(kernel, target.service, target.action)
      return (yield* asRequest({
        kernel,
        trace,
        target,
        body: () => performCall(kernel, target, tail),
      })) as AnyType
    }
    return (yield* performCall(kernel, target, tail)) as AnyType
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
        span_id: trace?.span_id ?? null,
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

  *reload(services) {
    const kernel = yield* Server.context.expect()

    // a node that hosted every application service keeps doing so (a monolith, a `service`
    // node told nothing); one with a narrowed set (gateway, `hosted: [...]`, SERVICE=…) hosts
    // exactly what it was told — an added service is reached over the carrier there
    const hostsAll =
      kernel.role !== 'gateway' &&
      [...kernel.registry.services.keys()].every(name => kernel.hosted.has(name))
    const changed = yield* reloadRegistry(kernel, services)

    for (const name of changed.removed) {
      if (kernel.hosted.delete(name) && kernel.carrier) {
        yield* attempt(() => kernel.carrier!.actions.unserve(name))
      }
    }

    for (const name of changed.added) {
      if (hostsAll) {
        kernel.hosted.add(name)
      }

      if (kernel.hosted.has(name) && kernel.carrier) {
        yield* kernel.carrier.actions.serve(name, serverFor(kernel, name))
      }
    }

    // replaced services keep their carrier subscription: `serverFor` resolves the definition
    // per dispatch. The edge rebuilds its tables from the registry.
    if (kernel.edge) {
      yield* kernel.edge.actions.remount()
    }

    for (const hooks of kernel.hooks) {
      if (hooks.reload) {
        yield* hooks.reload(changed)
      }
    }

    return changed
  },

  *report(event) {
    yield* report(yield* Server.context.expect(), event)
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
