// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { attempt, useContext } from 'std:effect'
import { redactQuery, SENSITIVE_KEYS } from 'std:fetch'
import type { Result } from 'std:result'
import { isFailure } from 'std:result'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import pkg from '../../../package.json'
import { EXCEPTION_EVENT_NAME, HEADERS, TRACE_SCOPE } from '../const'
import { DispatchSpan, RequestRef } from '../context'
import { ObserveExporter } from '../definition/protocol'
import { budgetLog } from '../internal/budget'
import { HTTP_METHODS, REQUEST_ID, RESOURCE_CACHE_LIMIT } from '../internal/const'
import { DispatchScope } from '../internal/context'
import { addressOf, enterActive, policyOf, portOf, trusts } from '../internal/edge/inbound'
import { forwardException, markShown, noteFailure } from '../internal/forward'
import { envResource } from '../internal/resource'
import { answering, dispatchFailureOf, dispatchFlow, endsWith } from '../internal/spans'
import { isDeferred } from '../internal/stream'
import { resources, ServerTracerImpl } from '../internal/tracer'
import type { Helpers } from '../types/helpers'
import type { ObserveDef } from '../types/observe'
import type { ServerDef } from '../types/server'
import type { ServiceDef } from '../types/service'
import type { WireDef } from '../types/wire'

import { statusOf, tagOf } from './failure'
import { isBranded } from './stream'

// --- settings & resource ---------------------------------------------------------------------

/** The instrumentation scope of the kernel (`@ozaco/server`) or of one of its plugins
 * (`@ozaco/server/<plugin>`), versioned with the package. */
export const scopeOf = (plugin?: string): TraceDef.InstrumentationScope => ({
  name: plugin ? `${TRACE_SCOPE}/${plugin}` : TRACE_SCOPE,
  version: pkg.version,
})

/**
 * Resolve `createServer`'s `trace` / `observe` / `errors` options into the kernel's settings
 * (defaults applied): inbound `'link'`, `traceresponse` on, `serviceName: 'service'`, namespace =
 * the app name, capture all off. `env` reads `OTEL_SERVICE_NAME` (the node-level name unless the
 * option fixes one) and `OTEL_RESOURCE_ATTRIBUTES` (laid UNDER the node's own resource — every
 * sink, store and exporters alike, carries them). The node-level resource still lacks
 * `ozaco.carrier.name` — createServer adds it once the carrier is installed, BEFORE tracing is
 * enabled (`resourceOf` caches).
 */
export const settingsOf = (
  options: ServerDef.Options,
  node: Pick<ServerDef.Context, 'name' | 'version'>,
  env: (name: string) => string | undefined = () => undefined,
): Pick<ServerDef.Context, 'telemetry' | 'errors'> => {
  const observe = options.observe ?? {}
  const mode = observe.serviceName ?? 'service'
  const fixed = mode === 'service' || mode === 'node' ? undefined : mode
  const namespace = observe.namespace ?? node.name
  const environment = observe.environment ?? null

  const resource: Record<string, TraceDef.AttrValue> = {
    ...envResource(env('OTEL_RESOURCE_ATTRIBUTES')),
    'service.namespace': namespace,
    'service.version': node.version,
    'telemetry.sdk.name': TRACE_SCOPE,
    'telemetry.sdk.version': pkg.version,
    'telemetry.sdk.language': 'nodejs',
  }

  if (environment) {
    resource['deployment.environment.name'] = environment
  }

  return {
    telemetry: {
      trace: {
        inbound: options.trace?.inbound ?? 'link',
        trust: options.trace?.trust ?? null,
        response: options.trace?.response !== false,
      },
      observe: {
        perService: mode === 'service',
        serviceName: fixed || env('OTEL_SERVICE_NAME') || node.name,
        namespace,
        environment,
        capture: {
          headers: observe.capture?.headers === true,
          bodies: observe.capture?.bodies === true,
          frames: observe.capture?.frames === true,
          enduser: observe.capture?.enduser === true,
          // a copy: the caller's array changing later never reaches (nor goes stale in) the lookup
          sensitiveKeys: Object.freeze([...(observe.capture?.sensitiveKeys ?? SENSITIVE_KEYS)]),
        },
      },
      resource,
    },
    errors: { expose: options.errors?.expose ?? null },
  }
}

/**
 * The resource of one record: `service.name` = the record's `service` (per-service mode) else
 * the node-level name, `service.instance.id` = the node, over the kernel's node-level resource.
 * One frozen object per name (the kernel's `telemetry.resource` must be complete before the
 * first record — createServer enables tracing after it is).
 */
export const resourceOf = (
  kernel: ServerDef.Context,
  service: string | null,
): ObserveDef.Resource => {
  const { observe, resource } = kernel.telemetry
  const name = (observe.perService ? service : null) || observe.serviceName

  let byName = resources.get(kernel)

  if (!byName) {
    byName = new Map()
    resources.set(kernel, byName)
  }

  const cached = byName.get(name)

  if (cached) {
    return cached
  }

  const built: ObserveDef.Resource = Object.freeze({
    ...resource,
    'service.name': name,
    'service.instance.id': kernel.instance,
  })

  if (byName.size < RESOURCE_CACHE_LIMIT) {
    byName.set(name, built)
  }

  return built
}

// --- the sink fan-out ------------------------------------------------------------------------

/**
 * Hand one observe event to every sink: the kernel's `observe` event stream, every `observe`
 * hook (the store) and — when one is installed — every `ObserveExporter` (the protocol fans
 * out). Runs SUPPRESSED (telemetry never traces itself) and never fails.
 */
export function* report(kernel: ServerDef.Context, event: ObserveDef.Event): Operation<void> {
  kernel.events.emit('observe', event)

  yield* Trace.actions.suppressed(function* () {
    for (const hooks of kernel.hooks) {
      if (hooks.observe) {
        yield* attempt(() => hooks.observe!(event))
      }
    }

    if (kernel.exporting) {
      yield* attempt(() => ObserveExporter.actions.export(event))
    }
  })
}

/**
 * The caller shows `failure` in the std Logger ITSELF, at WARN or above — a plugin that records a
 * failure it swallowed, then logs it with its own message: its exception record is not forwarded
 * to the Logger by the server tracer (`forwardException`), whether it is emitted now or with a
 * buffered (`record: 'errors'`) trace later. Every Logger line at WARN+ in an observing node and
 * every `ctx.log` line are marked so on their own.
 */
export const markLogged = (failure: Result.Failure<unknown>): void => {
  markShown(failure)
}

/**
 * The kernel's `Trace` impl (`server-tracer`, `yield* ServerTracer.use(kernel)`): every
 * finished span / log record std:trace hands it becomes ONE observe event (`report`) with its
 * resource. A log record's attributes are cut to the log budget HERE, once, before the fan-out
 * (≤ 96 attributes / 48 KiB, counted into `droppedAttributes`) — the store, stdout and every
 * exporter receive the identical record; no sink re-cuts. A settled exception record at WARN or
 * above is ALSO forwarded to the std Logger (`forwardException`), so failures reach the console.
 * Its context (`ServerTracer.context`) holds the node's `TracingState`.
 */
export const ServerTracer = ServerTracerImpl.build({
  *export(data: TraceDef.SpanData) {
    const { kernel } = yield* useContext(ServerTracerImpl.context)

    yield* report(kernel, { t: 'span', span: data, resource: resourceOf(kernel, data.service) })
  },

  *emit(log: TraceDef.LogData) {
    const { kernel } = yield* useContext(ServerTracerImpl.context)

    yield* report(kernel, {
      t: 'log',
      log: budgetLog(log),
      resource: resourceOf(kernel, log.service),
    })

    yield* attempt(() => forwardException(kernel, log))
  },
})

// --- kernel spans ----------------------------------------------------------------------------

/**
 * The failure options of a span wrapping (part of) the dispatch `call` — the dispatch span's own
 * rules (`statusOf(f, meta)`, `tagOf`, `ozaco.action.exception` in-process /
 * `rpc.server.call.exception` when the call came over a carrier), so a plugin span (a cache span,
 * a resilience attempt) classifies a failure exactly like the dispatch it wraps.
 */
export const dispatchFailure = (
  call: Pick<ServerDef.Call, 'transport'>,
  meta?: Pick<ServiceDef.Meta, 'errors'> | null,
): TraceDef.FailureOptions =>
  dispatchFailureOf(call.transport !== 'edge' && call.transport !== 'local', meta)

/**
 * Run one dispatch in its span `{service}.{action}` (§6.2): INTERNAL in-process
 * (`code.function.name`, exception `ozaco.action.exception`), SERVER when received over a carrier
 * (`rpc.system.name = 'ozaco'`, `rpc.method`, exception `rpc.server.call.exception`). Parent:
 * `call.parent` (a remote context / `null`), else the active span. Sets `service` (per-service
 * resource mode), classifies an escaping failure with `statusOf(f, meta)` / `tagOf`, and records
 * plugin-owned services as `'errors'` (a local root is exported only when it failed). The span's
 * handle is the `DispatchSpan` for the body's whole extent (`dispatchSpan()`), its ozaco service
 * the scope of the user spans opened in it (`userSpan`).
 *
 * A STREAM output keeps the span open until the stream closes — drained, failed (the failure
 * fails the span) or let go of by its consumer (cancelled) — like `carrierSpan` on the caller: a
 * Flow (`DeferredStream`) is PRODUCED under the dispatch's contexts wherever it is materialized
 * (its span active, its request, its dispatch span and scope), a platform stream is passed
 * through and ends it when it is read out.
 */
export function* withDispatchSpan<T>(
  input: Helpers.DispatchSpanInput,
  body: Helpers.SpanBody<T>,
): Operation<T> {
  const { kernel, call, meta } = input
  const method = `${call.service}.${call.action}`
  const kind = input.kind ?? (call.parent?.remote === true ? 'server' : 'internal')
  const rpc = kind === 'server'

  const attributes: TraceDef.AttributesInput = rpc
    ? {
        'rpc.system.name': 'ozaco',
        'rpc.method': meta ? method : '_OTHER',
        'rpc.method_original': meta ? undefined : method,
      }
    : { 'code.function.name': method }

  const live = yield* Trace.actions.startSpan(rpc && !meta ? 'ozaco' : method, {
    kind,
    scope: scopeOf(),
    service: kernel.telemetry.observe.perService ? call.service : undefined,
    parent: call.parent,
    attributes,
    record:
      kernel.pluginServices.has(call.service) && !kernel.selfTraced.has(call.service)
        ? 'errors'
        : 'always',
    failure: dispatchFailureOf(rpc, meta),
  })

  const scope: TraceDef.InstrumentationScope = {
    name: call.service,
    version: kernel.registry.services.get(call.service)?.version ?? kernel.version,
  }
  const request = yield* RequestRef.get()

  // the dispatch's contexts, entered again wherever its streamed output is produced
  const enter = <R>(active: TraceDef.SpanContext | null, op: () => Operation<R>) => {
    const inner = (handle: TraceDef.SpanHandle) =>
      DispatchSpan.with(handle, () => DispatchScope.with(scope, op))
    const traced = () =>
      live.recording
        ? live.run(inner)
        : active
          ? Trace.actions.passThrough(active, () => inner(live))
          : Trace.actions.detached(() => inner(live))

    return request ? RequestRef.with(request, traced) : traced()
  }

  let active = null as TraceDef.SpanContext | null
  let ended = false

  try {
    const outcome = yield* attempt(() =>
      live.run(function* (handle) {
        active = yield* Trace.actions.activeContext()

        return yield* DispatchSpan.with(handle, () => DispatchScope.with(scope, () => body(handle)))
      }),
    )

    ended = true

    if (isFailure(outcome)) {
      noteFailure(outcome)
      yield* live.end({ failure: outcome })

      return yield* outcome
    }

    const value: unknown = outcome.value

    if (isFailure(value)) {
      noteFailure(value)
      yield* live.end({ failure: value })

      return value as T
    }

    if (isDeferred(value)) {
      const held = active

      return {
        ...value,
        flow: dispatchFlow(value.flow, live, op => enter(held, op)),
      } as T
    }

    if (isBranded(value) && live.recording) {
      const node = (yield* ServerTracerImpl.context.get())?.scope

      if (node) {
        return endsWith(value, live, node) as T
      }
    }

    yield* live.end()

    return value as T
  } finally {
    if (!ended) {
      yield* live.end({ cancelled: true })
    }
  }
}

/**
 * The handle of the dispatch span running here — what a server plugin writes DISPATCH-level
 * attributes, links and events on (`ozaco.resilience.*`, `ozaco.crud.*`, `ozaco.auth.*`): unlike
 * std:trace `current()` it stays the dispatch span while a span of the plugin's own (a cache span
 * wrapping the dispatch, a resilience attempt) is the active one. The no-op handle outside a
 * dispatch and where telemetry is suppressed.
 */
export function* dispatchSpan(): Operation<TraceDef.SpanHandle> {
  const handle = yield* DispatchSpan.get()

  if (handle !== undefined && !(yield* Trace.actions.isSuppressed())) {
    return handle
  }

  // std:trace hands the no-op handle out under suppression
  return yield* Trace.actions.suppressed(() => Trace.actions.current())
}

/**
 * Start the caller-side CLIENT span `{service}.{action}` of a carrier call (§6.2) as a LiveSpan
 * — it covers a streamed reply until the lane closes, so the caller ends it. `rpc.system.name`,
 * `rpc.method`; exception `rpc.client.call.exception`. The caller injects the wire trace inside
 * it (`live.run(() => wireTrace(requestId))`) and sets `rpc.response.status_code` at the end.
 * Idle when tracing is off.
 */
export function* carrierSpan(input: Helpers.CarrierSpanInput): Operation<TraceDef.LiveSpan> {
  const method = `${input.service}.${input.action}`
  const meta = input.meta

  return yield* Trace.actions.startSpan(method, {
    kind: 'client',
    scope: scopeOf(),
    attributes: { 'rpc.system.name': 'ozaco', 'rpc.method': method },
    failure: {
      status: failure => statusOf(failure, meta),
      type: tagOf,
      eventName: EXCEPTION_EVENT_NAME.rpcClient,
    },
  })
}

/**
 * The span id of the recording SERVER dispatch span that answered `failure` over a carrier, if
 * any — what a carrier names in the failure's wire origin, so the caller's decoder appends
 * `remote: <operation> @ <service> span <id8>` to it.
 */
export const answeredBy = (failure: Result.Failure<unknown>): string | undefined =>
  answering.get(failure)

// --- ids & propagation -----------------------------------------------------------------------

/** Whether `value` is a request id worth keeping (1–128 printable ASCII). */
export const isRequestId = (value: unknown): value is string =>
  typeof value === 'string' && REQUEST_ID.test(value)

/**
 * The request id of a request entering here (§6.1): a valid inbound `x-request-id`, else the
 * trace id when this node MINTED the trace (`minted`, the new root's trace id), else a fresh
 * `newTraceId()` (honours `TraceIds`; works with tracing off).
 */
export function* requestIdFor(
  inbound: string | null | undefined,
  minted?: string | null,
): Operation<string> {
  if (isRequestId(inbound)) {
    return inbound
  }

  return minted || (yield* Trace.actions.newTraceId())
}

/** `ctx.trace` from a span handle: `''` ids when it carries no valid context. */
export const traceOf = (handle: TraceDef.SpanHandle, requestId: string): ServerDef.Trace =>
  handle.valid
    ? { traceId: handle.context.traceId, spanId: handle.context.spanId, requestId }
    : { traceId: '', spanId: '', requestId }

/**
 * The trace a dispatch / event envelope carries, from the ACTIVE span (recording or
 * pass-through — `inject()`): `traceparent` / `tracestate` + the request id, and the compat
 * `span_id` + empty `lane`. Call it INSIDE the carrier CLIENT / emit PRODUCER span.
 */
export function* wireTrace(requestId: string): Operation<WireDef.Trace> {
  const carrier = yield* Trace.actions.inject()
  const active = yield* Trace.actions.activeContext()

  return { ...carrier, request_id: requestId, span_id: active?.spanId ?? '', lane: [] }
}

/** The remote parent an envelope's trace names (`remote: true`), or `null` (none / invalid / an
 * old wire without `traceparent`). Never throws. */
export function* wireParent(
  wire: WireDef.Trace | undefined,
): Operation<TraceDef.SpanContext | null> {
  if (!wire?.traceparent) {
    return null
  }

  const { traceparent, tracestate } = wire

  return yield* Trace.actions.extract({ traceparent, ...(tracestate ? { tracestate } : {}) })
}

// --- edge ------------------------------------------------------------------------------------

/**
 * How an inbound context shapes an edge span (§6.1; decisions log "Trust"):
 * - a caller the node TRUSTS (`trace.trust(request) === true`) is continued — its context is the
 *   parent as received, the sampled flag honoured;
 * - a caller whose `tracestate` carries `ozaco=1` (an observing ozaco client / fetch) is
 *   continued too, so traces between ozaco nodes stay one trace — but the marker is
 *   SELF-ASSERTED: its sampled flag is never honoured (the parent is its context with the
 *   sampled bit set: a `-00` is still recorded here, and never blinds the nodes behind this one);
 * - anyone else by the configured mode — `link`: a new root linking it (`ozaco.link.reason =
 *   'remote.parent'`), `ignore`: a new root, `continue`: the parent as received (the operator's
 *   own choice, flag honoured).
 */
export const inboundOf = (
  kernel: ServerDef.Context,
  request: Request,
  inbound: TraceDef.SpanContext | null,
): Helpers.Inbound => {
  const settings = kernel.telemetry.trace

  return policyOf(settings, inbound, { trusted: trusts(settings, request), marked: false })
}

/**
 * Open the SERVER span of one HTTP request / WS upgrade (§6.2) — ROUTE FIRST, then call this:
 * name `{METHOD} {route}` (`{METHOD}` unrouted, `HTTP` for an unknown method), the HTTP semconv
 * request attributes (`http.request.method` (+`_original`), `http.route`, `url.path`,
 * `url.scheme`, `url.query` (secrets redacted — `redactQuery` over `capture.sensitiveKeys`), `server.address`, `server.port`,
 * `user_agent.original`, `ozaco.request.id` whenever the request id is not the trace id — an inbound `x-request-id`, or
 * the fresh id of a continued request), the inbound policy (`inboundOf`) and the request id
 * (`requestIdFor`); the request counts into `kernel.active` until `span` ends. The caller runs
 * the request in `run`, stamps the reply with `edgeReply`, settles a failed reply with
 * `replyFailure`, and ends `span` when the response BODY is done. Captured headers/bodies are the
 * caller's.
 */
export function* edgeSpan(input: Helpers.EdgeSpanInput): Operation<Helpers.EdgeSpan> {
  const { kernel, request, url, route } = input
  const observe = input.observe ?? 'on'
  const inbound = yield* Trace.actions.extract(name => request.headers.get(name))
  const { parent, links, trusted, marked, mode } = inboundOf(kernel, request, inbound)
  const upper = request.method.toUpperCase()
  const known = HTTP_METHODS.has(upper)
  const method = known ? upper : '_OTHER'
  const name = known ? (route ? `${method} ${route}` : method) : 'HTTP'
  const scheme = url.protocol.replace(/:$/u, '')
  const tracing = observe !== 'off' && (yield* Trace.actions.isTracing())

  const live: TraceDef.LiveSpan =
    observe === 'off'
      ? yield* Trace.actions.suppressed(() => Trace.actions.startSpan(name))
      : yield* Trace.actions.startSpan(name, {
          kind: 'server',
          scope: scopeOf(),
          parent,
          links,
          record: observe === 'errors' ? 'errors' : 'always',
          failure: { eventName: EXCEPTION_EVENT_NAME.edge },

          attributes: {
            'http.request.method': method,
            'http.request.method_original': known ? undefined : request.method,
            'http.route': route ?? undefined,
            'url.path': url.pathname,
            'url.scheme': scheme,
            'url.query':
              url.search.length > 1
                ? redactQuery(url.search.slice(1), kernel.telemetry.observe.capture.sensitiveKeys)
                : undefined,
            'server.address': addressOf(url),
            'server.port': portOf(url),
            'user_agent.original': request.headers.get('user-agent') ?? undefined,
          },
        })

  const minted = tracing && parent === null && live.valid
  const asked = request.headers.get(HEADERS.requestId)
  const requestId = yield* requestIdFor(asked, minted ? live.context.traceId : null)

  // the request id is findable (`Observe.actions.request`) whenever it is not the trace id: an
  // inbound `x-request-id`, or the fresh one a CONTINUED request gets (the shared trace id is
  // never a request's)
  if (live.valid && requestId !== live.context.traceId) {
    live.setAttribute('ozaco.request.id', requestId)
  }

  // tracing off: a context this node would CONTINUE rides on as a pass-through so `inject()`
  // still forwards it — as it would be continued (a self-asserted `ozaco=1` caller's with the
  // sampled bit set). One it would only LINK (an untrusted caller's) never does: carriers honour
  // what they receive, so passing it on would hand a stranger's sampling decision (a `-00`
  // blinds every node behind this one) and its span as a parent to the whole cluster
  const passing = observe !== 'off' && !tracing && mode === 'continue' ? parent : null

  // the request is ACTIVE (`http.server.active_requests`) until its span ends — the response
  // body done; nothing between here and the caller's `end` can leave it counted
  const leave = enterActive(kernel, method, scheme)
  const edge: TraceDef.LiveSpan = {
    ...live,
    *end(options) {
      leave()
      yield* live.end(options)
    },
  }

  return {
    span: edge,
    requestId,
    inbound,
    trusted,
    marked,
    passing,

    run: body => {
      if (observe === 'off') {
        return Trace.actions.suppressed(() => live.run(body))
      }

      return passing ? Trace.actions.passThrough(passing, () => live.run(body)) : live.run(body)
    },
  }
}

/**
 * Stamp the FINAL response on the edge span (§6.2): `http.response.status_code`; `error.type`
 * whenever the reply is a failure (its tag — else the `oz-error` header, else the status for a
 * bare 5xx); status `error` for 5xx only (message: the failure's, else the status text),
 * 1xx–4xx stay unset.
 */
export const edgeReply = (
  handle: TraceDef.SpanHandle,
  response: Response,
  failure?: Result.Failure<unknown> | null,
): void => {
  const status = response.status

  const type = failure
    ? tagOf(failure)
    : (response.headers.get(HEADERS.error) ?? (status >= 500 ? String(status) : null))

  handle.setAttributes({ 'http.response.status_code': status, 'error.type': type ?? undefined })

  if (status >= 500) {
    handle.setStatus({
      code: 'error',
      message: failure?.message || response.statusText || String(status),
    })
  }
}

/**
 * The settle hook of a reply encoder (the edge; a carrier when it answers a failure itself):
 * `failure` was ANSWERED with `reply.status` — call it with the answering span ACTIVE, before
 * that span ends. A failure pending in the trace (it escaped a dispatch span) settles now with
 * its final status (held spans take it, ONE exception at its origin); one that never escaped a
 * span here (edge-originated: unrouted 404/405, decode 400, paused 503, raw-route guard, CORS /
 * upgrade reject) is recorded on `handle` with `reply.eventName` — severity 17 for 5xx, 5
 * (DEBUG) otherwise.
 */
export function* replyFailure(
  handle: TraceDef.SpanHandle,
  failure: Result.Failure<unknown>,
  reply: Helpers.ReplyOptions,
): Operation<void> {
  yield* Trace.actions.settle(failure, { status: reply.status })

  if (!(yield* Trace.actions.isRecorded(failure, handle.context.traceId))) {
    yield* handle.recordFailure(failure, {
      eventName: reply.eventName ?? EXCEPTION_EVENT_NAME.edge,
      severity: reply.status >= 500 ? 17 : 5,
    })
  }
}
