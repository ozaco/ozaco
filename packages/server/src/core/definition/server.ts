import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { createEvent } from 'std:event'
import { IO } from 'std:io'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'
import { Trace } from 'std:trace'

import pkg from '../../../package.json'
import { DEFAULT_TIMEOUT_MS, serviceIdOf } from '../const'
import { ActiveRequest, RequestRef } from '../context'
import { ServerErrors } from '../errors'
import { env, roleOf } from '../internal/app'
import { parseCall } from '../internal/call'
import { callLocal, runDispatch } from '../internal/dispatch'
import { domainRecord } from '../internal/handler'
import { actionsOf, asRequest, callRemote, carrierOf, serverFor } from '../internal/kernel'
import { buildRegistry, manifestOf, reloadRegistry, socketInfoOf } from '../internal/registry'
import {
  eventItemOf,
  isInternalEvent,
  processSpan,
  publishSpan,
  userSpanOf,
} from '../internal/spans'
import type { ServerDef } from '../types/server'
import type { ServiceDef } from '../types/service'
import { settingsOf, wireTrace } from '../utils/trace'

import { Server } from './protocol'

/** One call, `RequestRef` already set: local when hosted here, over the carrier otherwise. The
 * carrier correlation id is minted here — never a span id (it exists with tracing off). */
function* performCall(
  kernel: ServerDef.Context,
  target: { readonly service: string; readonly action: string },
  rest: readonly [unknown?, ServerDef.CallOptions?],
): Operation<unknown> {
  const [input, options] = rest
  const request =
    (yield* RequestRef.get()) ?? new ActiveRequest(yield* Trace.actions.newTraceId(), 'internal')
  const cid = yield* Trace.actions.newSpanId()
  const timeoutMs = options?.timeoutMs ?? kernel.timeoutMs

  if (kernel.hosted.has(target.service)) {
    return yield* callLocal({
      kernel,
      cid,
      requestId: request.requestId,
      origin: request.origin,
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
    cid,
    requestId: request.requestId,
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
      observing: false,
      ...settingsOf(options, { name, version }, env),
      role: roleOf(options),
      hosted: new Set(options.hosted ?? registry.services.keys()),
      pluginServices: new Set(),
      selfTraced: new Set(),
      inflight: 0,
      active: new Map(),

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
      return yield* RequestRef.with(new ActiveRequest(call.requestId, call.origin), () =>
        callRemote(kernel, {
          cid: call.cid,
          requestId: call.requestId,
          service: call.service,
          action: call.action,
          input: call.input,
          deadline: call.deadline,
          idempotencyKey: call.idempotencyKey,
          meta: call.headers,

          // the owner's `ctx.reply` (status, `Location`, …) shapes THIS edge's response
          reply: call.reply,
        }),
      )
    }

    return yield* runDispatch(kernel, call, { actions: actionsOf(kernel) })
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

    if ((yield* RequestRef.get()) === undefined) {
      // a call from outside any dispatch is a request of its own (origin: internal)
      return (yield* asRequest({
        kernel,
        request: new ActiveRequest(yield* Trace.actions.newTraceId(), 'internal'),
        target,
        body: () => performCall(kernel, target, tail),
      })) as AnyType
    }

    return (yield* performCall(kernel, target, tail)) as AnyType
  },

  *emit(name, payload) {
    const kernel = yield* Server.context.expect()
    const carrier = yield* carrierOf(kernel)

    // one id per envelope: the producer's and every consumer's `messaging.message.id`
    const id = yield* Trace.actions.newTraceId()

    // the kernel's own plumbing (`_…`, the observe cluster) is never traced
    if (isInternalEvent(name)) {
      yield* Trace.actions.suppressed(() =>
        carrier.actions.emit({ k: 'event', id, name, payload, origin: kernel.serviceId }),
      )

      return
    }

    const requestId = (yield* RequestRef.get())?.requestId ?? ''

    yield* publishSpan(name, id, function* () {
      yield* carrier.actions.emit({
        k: 'event',
        id,
        name,
        payload,
        origin: kernel.serviceId,
        trace: yield* wireTrace(requestId),
      })
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

            // the carrier's subscription ended (its scope / the transport closed): so does this
            // flow — pulling a finished subscription again would only spin
            if (step.done) {
              return step
            }

            if (isInternalEvent(step.value.name)) {
              continue
            }

            if (name === undefined || step.value.name === name) {
              return { done: false as const, value: yield* eventItemOf(step.value) }
            }
          }
        },
      }
    },
  }),

  process: (item, body) => processSpan(item, body),

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

  *report(record) {
    yield* domainRecord(record)
  },

  *span(name, body, options) {
    const kernel = yield* Server.context.expect()

    return yield* userSpanOf(kernel, true)(name, body, options)
  },
})
