// oxlint-disable import/exports-last
import type { Operation, Scope } from 'std:effect'
import { attempt, createContext, race, sleep, useScope, withResolvers } from 'std:effect'
import { IO } from 'std:io'
import type { Result } from 'std:result'
import { asFailure, fail, isFailure } from 'std:result'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import type { MatchedRoute, RouterContext } from 'rou3'
import { addRoute, createRouter, findRoute } from 'rou3'

import { HEADERS } from '../../const'
import { ActiveRequest, RequestRef } from '../../context'
import { ServerErrors } from '../../errors'
import type { EdgeDef } from '../../types/edge'
import type { Helpers } from '../../types/helpers'
import type { OptionsDef } from '../../types/options'
import type { ServerDef } from '../../types/server'
import type { ServiceDef } from '../../types/service'
import { rewrapResponse } from '../../utils/response'
import {
  brandOf,
  brandStream,
  isBranded,
  isPartsDecl,
  isStreamDecl,
  stream,
} from '../../utils/stream'
import { edgeReply, edgeSpan, replyFailure } from '../../utils/trace'
import { bodyAttributes, countingStream, headerAttributes } from '../capture'
import { materialize } from '../dispatch'
import { isThrown } from '../thrown'

import { valueBody } from './body'
import { edgeLog } from './log'
import { parseParts } from './multipart'
import { failureResponse, jsonScope, responseOf } from './respond'
import { driveSocket } from './sockets'

export const EdgeStateRef = createContext<Helpers.EdgeState>('server:edge/state')

/** The W3C `sampled` trace flag. */
const SAMPLED = 0x01

/** Each edge's failure-envelope writer (`jsonScope`), `null` when its codec could not install. */
const JSON_SCOPES = new WeakMap<Helpers.EdgeState, Scope | null>()

export function* createEdgeState(
  kernel: ServerDef.Context,
  actions: Helpers.EdgeState['actions'],
): Operation<Helpers.EdgeState> {
  const state: Helpers.EdgeState = {
    kernel,
    actions,
    router: createRouter<Helpers.Entry>(),
    sockets: createRouter<EdgeDef.SocketRoute>(),
    raws: [],
    socketRoutes: [],
    decorators: [],
    scope: yield* useScope(),
    preflight: null,
    paused: false,
    mounted: false,
    info: null,
  }

  yield* EdgeStateRef.set(state)
  JSON_SCOPES.set(state, yield* jsonScope())

  return state
}

/** Request headers as a plain record. Tokens NEVER travel in the URL: a browser socket
 * authorizes with its first `{ t: 'auth' }` frame instead (see `driveSocket`). */
const headersOf = (request: Request): Record<string, string> => {
  const headers: Record<string, string> = {}

  // oxlint-disable-next-line unicorn/no-array-for-each
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  return headers
}

/** Route params, percent-decoded (a malformed escape stays as-is). */
const decodeParams = (params: Record<string, string> | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(params ?? {}).map(([key, value]) => {
      try {
        return [key, decodeURIComponent(value)]
      } catch {
        return [key, value]
      }
    }),
  )

/** Add the registry's action routes and declared sockets (`action.socket`) to the given
 * tables. The declared sockets are already in `kernel.sockets` (the manifest); here they are
 * routed. */
const addRegistry = (
  state: Helpers.EdgeState,
  router: RouterContext<Helpers.Entry>,
  sockets: RouterContext<EdgeDef.SocketRoute>,
): number => {
  let count = 0

  for (const [key, def] of state.kernel.registry.actions) {
    const [service, action] = key.split('.') as [string, string]

    addRoute(router, def.meta.route.method, def.meta.route.path, {
      kind: 'action',
      service,
      action,
      meta: def.meta,
    })
    count += 1
  }

  for (const socket of state.kernel.registry.sockets) {
    addRoute(sockets, 'WS', socket.path, {
      path: socket.path,
      handler: socket.handler,
      authorize: socket.authorize ?? undefined,
      authorizeMode: socket.authorizeMode,
      service: socket.service,
      protocol: socket.protocol ?? undefined,
      description: socket.description ?? undefined,
      defaults: socket.defaults ?? undefined,
      receives: socket.receives ?? undefined,
    })
    count += 1
  }

  return count
}

/** Mount every action of the kernel's registry (idempotent). */
export const mountActions = (state: Helpers.EdgeState): number => {
  if (state.mounted) {
    return 0
  }

  state.mounted = true

  return addRegistry(state, state.router, state.sockets)
}

/** Rebuild both tables from the CURRENT registry plus everything registered through
 * `raw()` / `socket()`, then swap them in — one assignment each, so a request in flight keeps
 * the tables it resolved against and the next one sees the new declarations. */
export const remountActions = (state: Helpers.EdgeState): number => {
  const router = createRouter<Helpers.Entry>()
  const sockets = createRouter<EdgeDef.SocketRoute>()

  for (const route of state.raws) {
    addRoute(router, route.method, route.path, { kind: 'raw', route })
  }

  for (const route of state.socketRoutes) {
    addRoute(sockets, 'WS', route.path, route)
  }

  const count = addRegistry(state, router, sockets)

  state.router = router
  state.sockets = sockets
  state.mounted = true

  return count
}

/** The input of an action request, by its declared input plane. */
function* inputOf(
  request: Request,
  meta: ServiceDef.Meta,
  params: Readonly<Record<string, string>>,
): Operation<unknown> {
  if (meta.inputPlane === 'stream' && meta.input && isStreamDecl(meta.input)) {
    if (!request.body) {
      return yield* fail(ServerErrors.BadRequest, 'a stream body is required')
    }

    return stream.from(request.body, meta.input.brand)
  }

  if (meta.inputPlane === 'parts' && meta.input && isPartsDecl(meta.input)) {
    return yield* parseParts(request, meta.input)
  }

  if (meta.inputPlane === 'none') {
    return undefined
  }

  return yield* valueBody(request, params, meta.input)
}

/** How long an accepted upgrade's span waits for the driver's report (`attach` / `failed`)
 * before it ends cancelled — a handshake the runtime silently dropped (the client left). */
const UPGRADE_SETTLE_MS = 10_000

/** The trace id a failure envelope reports: the edge span's, `''` when nothing is traced. */
const traceIdOf = (handle: TraceDef.SpanHandle): string =>
  handle.valid ? handle.context.traceId : ''

/** An IPv4 address as a dual-stack socket reports it (`::ffff:<ipv4>`). */
const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu

/**
 * `client.address` (HTTP semconv): the client behind the proxies when one says so
 * (`x-forwarded-for`'s first hop, else `x-real-ip`), else the PEER the driver saw (Bun's
 * `requestIP`, node's `socket.remoteAddress`, Deno's `remoteAddr`). `undefined` when none is
 * known (an in-process `Edge.actions.handle`).
 */
const clientOf = (request: Request, peer: string | undefined): string | undefined => {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  // an IPv4 peer of a dual-stack socket (node: `::ffff:127.0.0.1`) is that IPv4 address
  const direct = peer ? (MAPPED_V4.exec(peer)?.[1] ?? peer) : undefined

  return forwarded || request.headers.get('x-real-ip')?.trim() || direct || undefined
}

/** Methods whose value-plane input is read from the QUERY (+ path params), never a body. */
const QUERY_METHODS = new Set(['GET', 'HEAD', 'DELETE'])

/**
 * Whether the request carried a body the input was read from (capture `bodies`): a query-only
 * method or an empty body reads the input from the URL — capturing it as a "body" would report
 * one that never existed and leak the query values `url.query` redacts (`?token=…`).
 */
const sentBody = (request: Request): boolean =>
  !QUERY_METHODS.has(request.method.toUpperCase()) &&
  request.body !== null &&
  request.headers.get('content-length') !== '0'

/** The bytes the request body had on the wire (`content-length`), when the client said so. */
const declaredSize = (request: Request): number | undefined => {
  const size = Number(request.headers.get('content-length') ?? Number.NaN)

  return Number.isSafeInteger(size) && size >= 0 ? size : undefined
}

/** The route TEMPLATE a match names the span by (`/todos/:id`, a raw route's path). */
const templateOf = (entry: Helpers.Entry | null): string | null =>
  entry === null ? null : entry.kind === 'raw' ? entry.route.path : entry.meta.route.path

/**
 * How much a request records (design §6.2): a raw route says so itself (`observe`, default
 * `'on'`); an action of a PLUGIN-owned service (the observe console API, …) records only when it
 * fails, unless the plugin asked for its own traces (`kernel.selfTraced`); everything else is
 * recorded.
 */
const observeOf = (kernel: ServerDef.Context, entry: Helpers.Entry | null): EdgeDef.Observe => {
  if (entry === null) {
    return 'on'
  }

  if (entry.kind === 'raw') {
    return entry.route.observe ?? 'on'
  }

  return kernel.pluginServices.has(entry.service) && !kernel.selfTraced.has(entry.service)
    ? 'errors'
    : 'on'
}

/** `response` with `headers` added — on a re-wrapped copy: the response a handler returned may
 * be immutable (a fetched one handed through) and is never mutated underneath it. */
const withHeaders = (response: Response, headers: readonly [string, string][]): Response => {
  if (headers.length === 0) {
    return response
  }

  const out = rewrapResponse(response)

  for (const [name, value] of headers) {
    out.headers.set(name, value)
  }

  return out
}

/**
 * The context `traceresponse` names: the edge span's own — its sampled flag cleared when the
 * trace is NOT exported (a `record: 'errors'` span answered without a failure: nothing of it
 * reaches a backend); none for an `observe: 'off'` route or a pass-through edge (tracing off: no
 * span of its own — `answeredElsewhere` then names the owner's).
 */
const echoedOf = (by: {
  readonly handle: TraceDef.SpanHandle
  readonly observe: EdgeDef.Observe
  readonly failure?: Result.Failure<unknown> | null | undefined
}): TraceDef.SpanContext | null => {
  const own = by.handle.context

  if (by.observe === 'off' || !by.handle.valid) {
    return null
  }

  return by.observe === 'errors' && !by.failure ? { ...own, flags: own.flags & ~SAMPLED } : own
}

/**
 * The span an edge WITHOUT a span of its own (a non-observing gateway) advertises instead: the
 * owner's answering span — the reply's `traceparent` for a success, the span a failure's wire
 * origin named as its recorder (`Trace.actions.recordedBy`) for a failure. `null` for an
 * `observe: 'off'` route or when nothing answered elsewhere.
 */
function* answeredElsewhere(by: {
  readonly handle: TraceDef.SpanHandle
  readonly observe: EdgeDef.Observe
  readonly failure?: Result.Failure<unknown> | null | undefined
  readonly answered?: TraceDef.SpanContext | null | undefined
}): Operation<TraceDef.SpanContext | null> {
  if (by.observe === 'off' || by.handle.valid) {
    return null
  }

  if (by.answered) {
    return by.answered
  }

  return by.failure ? yield* Trace.actions.recordedBy(by.failure) : null
}

/**
 * Stamp what every response carries back (`createServer({ trace: { response } })`, default on):
 * `x-request-id` and the W3C draft `traceresponse` (`00-<trace>-<span>-<flags>`): the edge span's
 * own context, sampled only for a trace that is exported (`echoedOf`) — or, when this edge has no
 * span (a non-observing gateway), the span that answered the call elsewhere
 * (`answeredElsewhere`). A header the response already has is kept.
 */
function* stamp(
  response: Response,
  by: {
    readonly kernel: ServerDef.Context
    readonly requestId: string
    readonly handle: TraceDef.SpanHandle
    readonly observe: EdgeDef.Observe
    readonly failure?: Result.Failure<unknown> | null | undefined
    readonly answered?: TraceDef.SpanContext | null | undefined
  },
): Operation<Response> {
  if (!by.kernel.telemetry.trace.response) {
    return response
  }

  const headers: [string, string][] = []

  if (!response.headers.has(HEADERS.requestId)) {
    headers.push([HEADERS.requestId, by.requestId])
  }

  const echoed = echoedOf(by) ?? (yield* answeredElsewhere(by))

  if (echoed && !response.headers.has(HEADERS.traceresponse)) {
    const { traceparent } = yield* Trace.actions.inject({ context: echoed })

    if (traceparent) {
      headers.push([HEADERS.traceresponse, traceparent])
    }
  }

  return withHeaders(response, headers)
}

/** A failure as the request's answer: the envelope under its status — the nested cause chain only
 * for `errors.expose: 'chain'` or a caller the node TRUSTS (`trace.trust(request) === true`); a
 * self-asserted `ozaco=1` never gets it. */
function* failed(
  answering: Helpers.Answering,
  failure: Result.Failure<unknown>,
  meta?: Pick<ServiceDef.Meta, 'errors'>,
): Operation<Helpers.EdgeAnswer> {
  const response = yield* failureResponse(failure, {
    requestId: answering.edge.requestId,
    traceId: traceIdOf(answering.handle),
    meta,
    chain: answering.state.kernel.errors.expose === 'chain' || answering.edge.trusted,
    json: JSON_SCOPES.get(answering.state) ?? null,
  })

  return { response, failure, streamed: false }
}

/** Run one action route: build the call, dispatch through the kernel, render the response. */
function* runAction(
  answering: Helpers.Answering,
  entry: Helpers.ActionRoute,
  params: Readonly<Record<string, string>>,
): Operation<Helpers.EdgeAnswer> {
  const { state, request, edge, handle } = answering
  const capture = state.kernel.telemetry.observe.capture
  const input = yield* attempt(() => inputOf(request, entry.meta, params))

  // an undecodable input never reaches a dispatch: an EDGE-originated failure
  if (isFailure(input)) {
    return yield* failed(answering, input, entry.meta)
  }

  let callInput = input.value

  if (capture.bodies && (entry.meta.inputPlane !== 'value' || sentBody(request))) {
    handle.setAttributes(bodyAttributes('request', input.value, capture.sensitiveKeys))
    handle.setAttribute('http.request.body.size', declaredSize(request))

    // a stream body is observed as its SIZE — counted as it flows, never buffered
    if (isBranded(input.value)) {
      callInput = brandStream(
        countingStream(input.value as ReadableStream<Uint8Array>, bytes => {
          handle.setAttribute('http.request.body.size', bytes)
        }),
        brandOf(input.value),
      )
    }
  }

  const controller = new AbortController()

  request.signal?.addEventListener('abort', () => controller.abort(ServerErrors.Cancelled))

  // what the handler says about its own reply (`ctx.reply`), merged over the action's statics
  let replied: ServerDef.Reply = {}
  // the span that answered elsewhere (a gateway's owner): this edge's `traceresponse` when it
  // has no span of its own
  let answered: TraceDef.SpanContext | null = null

  // the dispatch span opens under the ACTIVE edge span (`parent` omitted); `cid` is carrier
  // correlation only — never a span id
  const call: ServerDef.Call = {
    cid: yield* Trace.actions.newSpanId(),
    service: entry.service,
    action: entry.action,
    input: callInput,
    requestId: edge.requestId,
    origin: 'external',
    headers: headersOf(request),
    deadline: Date.now() + state.kernel.timeoutMs,
    idempotencyKey: request.headers.get('idempotency-key') ?? undefined,
    transport: 'edge',
    signal: controller.signal,
    abort: reason => controller.abort(reason),
    reply: reply => {
      replied = {
        status: reply.status ?? replied.status,
        headers: { ...replied.headers, ...reply.headers },
      }
    },
    trace: context => {
      answered = context
    },
  }

  // the kernel action unwraps a returned Result (std plugin contract): fold it back here.
  // The dispatch runs INLINE in the request scope — a stream reply's lanes/pumps must live
  // exactly as long as the response body; a disconnecting client aborts `call.signal`, and
  // `invoke` halts the handler (`onDisconnect: 'cancel'`) from there.
  const outcome = yield* attempt(() => state.actions.dispatch(call))

  if (isFailure(outcome)) {
    return yield* failed(answering, outcome, entry.meta)
  }

  if (capture.bodies) {
    handle.setAttributes(bodyAttributes('response', outcome.value, capture.sensitiveKeys))
  }

  const value = yield* materialize(outcome.value)
  // an sse feed that fails ends its body cleanly: its failure is kept for the edge span
  let broke: Result.Failure<unknown> | null = null

  return {
    response: responseOf(value, {
      status: replied.status ?? entry.meta.status,
      headers: { ...entry.meta.headers, ...replied.headers },
      broke: reason => {
        broke ??= asFailure(reason)
      },
    }),
    failure: null,
    streamed: isBranded(value),
    answered,
    broke: () => broke,
  }
}

/** Decorate (inside the edge span — CORS records on it) and stamp the ids on every response
 * (errors included). */
function* finish({
  state,
  request,
  response,
  requestId,
  span,
  failure,
  answered,
  observe,
}: Helpers.Finishing): Operation<Response> {
  let out = response

  for (const decorator of state.decorators) {
    out = yield* decorator(request, out)
  }

  return yield* stamp(out, {
    kernel: state.kernel,
    requestId,
    handle: span,
    observe,
    failure,
    answered,
  })
}

/**
 * Who may reach a raw route: the kernel's `guard` hooks decide (the Auth plugin — the route's
 * `auth`, else its install `default`) and resolve the principal the handler receives. With no
 * guard installed a route that asks for auth is refused — fail-closed, never silently open.
 */
function* guardRaw(
  state: Helpers.EdgeState,
  route: EdgeDef.RawRoute,
  request: Request,
): Operation<OptionsDef.Principal | null> {
  const guards = state.kernel.hooks.filter(hooks => hooks.guard)

  if (guards.length === 0) {
    if (route.auth !== undefined && route.auth !== false) {
      return yield* fail(
        ServerErrors.Unauthorized,
        `${route.method} ${route.path} requires auth, but no Auth plugin is installed`,
      )
    }

    return null
  }

  let principal: OptionsDef.Principal | null = null

  for (const hooks of guards) {
    principal = (yield* hooks.guard!(route, request)) ?? principal
  }

  return principal
}

/** Run one raw route: the gate, then its handler (with the edge span as `span`). */
function* runRaw(
  answering: Helpers.Answering,
  route: EdgeDef.RawRoute,
  params: Readonly<Record<string, string>>,
): Operation<Helpers.EdgeAnswer> {
  const { state, request, handle } = answering

  const raw = yield* attempt(function* () {
    const principal = yield* guardRaw(state, route, request)

    return yield* route.handler(request, params, { principal, span: handle })
  })

  if (isFailure(raw)) {
    return yield* failed(answering, raw)
  }

  // a raw body may be anything (a file, a relay): it is followed to its end. (`.body` is not
  // touched here: read before the headers, it loses a `Bun.file`'s content-type)
  return { response: raw.value, failure: null, streamed: true }
}

/** Route one request: 503 while paused, raw routes, action routes, preflight for unrouted
 * OPTIONS, 404 otherwise. */
function* routeOf(
  answering: Helpers.Answering,
  match: MatchedRoute<Helpers.Entry> | undefined,
): Operation<Helpers.EdgeAnswer> {
  const { state, request, url, handle } = answering

  if (state.paused) {
    return yield* failed(answering, fail(ServerErrors.Paused, 'the edge is draining'))
  }

  if (match) {
    const params = decodeParams(match.params)
    const entry = match.data

    return entry.kind === 'raw'
      ? yield* runRaw(answering, entry.route, params)
      : yield* runAction(answering, entry, params)
  }

  if (request.method === 'OPTIONS' && state.preflight) {
    const answered = yield* attempt(() => state.preflight!(request))

    if (!isFailure(answered) && answered.value) {
      return { response: answered.value, failure: null, streamed: false }
    }

    // a failing preflight handler falls through to the 404 — but it is not swallowed
    if (isFailure(answered)) {
      yield* handle.recordFailure(answered, { handled: true })
    }
  }

  return yield* failed(
    answering,
    fail(ServerErrors.NotFound, `no route for ${request.method} ${url.pathname}`),
  )
}

/**
 * Answer one request INSIDE its edge span: capture the request headers, route it, settle a
 * failed answer (`replyFailure`: a failure pending from a dispatch settles with the status it was
 * answered with; an edge-originated one is recorded here — DEBUG for 4xx, ERROR for 5xx), run the
 * decorators, stamp the ids and derive the span's status from the FINAL response (`edgeReply`).
 */
function* respond(
  answering: Helpers.Answering,
  match: MatchedRoute<Helpers.Entry> | undefined,
): Operation<Helpers.EdgeAnswer> {
  const { state, request, edge, handle } = answering
  const capture = state.kernel.telemetry.observe.capture

  if (capture.headers) {
    handle.setAttributes(headerAttributes('request', request.headers, capture.sensitiveKeys))
  }

  const answer = yield* routeOf(answering, match)

  if (answer.failure) {
    yield* replyFailure(handle, answer.failure, { status: answer.response.status })
  }

  const response = yield* finish({
    state,
    request,
    response: answer.response,
    requestId: edge.requestId,
    span: handle,
    failure: answer.failure,
    answered: answer.answered,
    observe: answering.observe,
  })

  if (capture.headers) {
    handle.setAttributes(headerAttributes('response', response.headers, capture.sensitiveKeys))
  }

  edgeReply(handle, response, answer.failure)

  return { ...answer, response }
}

/** A crash while answering (a throwing decorator, a broken hook) as a 500: `server.internal`
 * wrapping what crashed (a throw's fold, one level under it); the span ENDS with it (one ERROR
 * exception). */
function* crashed(
  answering: Helpers.Answering,
  crash: Result.Failure<unknown>,
): Operation<Helpers.EdgeAnswer> {
  const fault = fail(ServerErrors.Internal, 'the edge failed to answer', crash)
  const answer = yield* failed(answering, fault)
  const response = yield* stamp(answer.response, {
    kernel: answering.state.kernel,
    requestId: answering.edge.requestId,
    handle: answering.handle,
    observe: answering.observe,
    failure: fault,
  })

  edgeReply(answering.handle, response, fault)

  return { ...answer, response, fault }
}

/**
 * The failure a response BODY broke with, as the edge span ends with it: a tagged one as it is
 * (it may be pending in the trace — one exception, at its origin); a thrown error (a raw stream
 * that errored — `asFailure`'s fold) wrapped as `server.internal` like any crash, so `error.type`
 * is the ozaco classification and the error stays in the chain, ONE level under it.
 */
const bodyFailure = (failure: Result.Failure<unknown>): Result.Failure<unknown> =>
  isThrown(failure) ? fail(ServerErrors.Internal, 'the response body failed', failure) : failure

/**
 * End the edge span with the response (design §6.2): right away for a body that does not
 * stream; otherwise when the BODY is done — a pass-through ends it on the last chunk, on a failed
 * read (with that failure) or when the consumer cancels (`ozaco.cancelled`). The body's size is
 * recorded with capture `bodies`.
 */
function* ending(
  state: Helpers.EdgeState,
  live: TraceDef.LiveSpan,
  answer: Helpers.EdgeAnswer,
): Operation<Helpers.ServedRequest> {
  if (!answer.streamed) {
    yield* live.end(answer.fault ? { failure: answer.fault } : {})

    return { response: answer.response, done: Promise.resolve() }
  }

  const sized = state.kernel.telemetry.observe.capture.bodies
  let settle: () => void = () => {}
  let followed = false

  const done = new Promise<void>(resolve => {
    settle = resolve
  })

  const end = (bytes: number, options: TraceDef.EndOptions): void => {
    if (sized) {
      live.setAttribute('http.response.body.size', bytes)
    }

    // a body that ended cleanly over a BROKEN source (an sse feed) ends the span with its failure
    const broke = options.failure ?? (options.cancelled ? null : (answer.broke?.() ?? null))
    const final = broke ? { failure: bodyFailure(broke) } : options

    // the span ends from the edge's scope: the request's own may be gone by then
    try {
      void state.scope.run(() => live.end(final), { detached: true }).then(settle, settle)
    } catch {
      // the edge is gone (stopped mid-body): nothing left to end the span in
      settle()
    }
  }

  // headers first, body after (`rewrapResponse`) — a `Bun.file`'s content-type survives
  const response = rewrapResponse(answer.response, body => {
    if (!body) {
      return body
    }

    followed = true

    return countingStream(body, end)
  })

  if (!followed) {
    yield* live.end()

    return { response, done: Promise.resolve() }
  }

  return { response, done }
}

/**
 * Handle one HTTP request end to end (design §6.1/§6.2): ROUTE FIRST, then open the edge span
 * `{METHOD} {route}` (inbound context linked / continued / ignored, request id decided); inside
 * it answer — raw routes, action routes (input by plane → kernel dispatch → response by brand),
 * preflight for unrouted OPTIONS, 404 otherwise, 503 while paused — decorate, stamp
 * `x-request-id` / `traceresponse`, and end the span with the response body.
 */
export function* serveRequest(
  state: Helpers.EdgeState,
  request: Request,
  peer?: string,
): Operation<Helpers.ServedRequest> {
  const { kernel } = state
  const url = new URL(request.url)
  const match = findRoute(state.router, request.method, url.pathname, { params: true })
  const entry = match?.data ?? null
  const observe = observeOf(kernel, entry)

  const edge = yield* edgeSpan({ kernel, request, url, route: templateOf(entry), observe })

  edge.span.setAttribute('client.address', clientOf(request, peer))

  // the span is ended exactly once, whatever happens below: handed to `ending` (the body ends
  // it), ended with a crash, or — the request halted mid-way — ended cancelled here
  let handed = false

  try {
    const answered = yield* attempt(() =>
      RequestRef.with(new ActiveRequest(edge.requestId, 'external'), () =>
        edge.run(handle => respond({ state, request, url, edge, handle, observe }, match)),
      ),
    )

    const answer = isFailure(answered)
      ? yield* edge.run(handle => crashed({ state, request, url, edge, handle, observe }, answered))
      : answered.value

    const served = yield* attempt(() => ending(state, edge.span, answer))

    if (!isFailure(served)) {
      handed = true

      return served.value
    }

    // the answer could not even be followed (a response the runtime refuses to re-wrap): a 500
    // from the SAME span — one request, one edge span
    const fallback = yield* edge.run(handle =>
      crashed({ state, request, url, edge, handle, observe }, served),
    )

    handed = true
    yield* edge.span.end({ failure: fallback.fault })

    return { response: fallback.response, done: Promise.resolve() }
  } finally {
    if (!handed) {
      yield* edge.span.end({ cancelled: true })
    }
  }
}

/** `serveRequest`'s response alone — `Edge.actions.handle` (in-process, tests); a crash of the
 * engine itself is answered like a driver's (`crashResponse`). */
export function* handleRequest(
  state: Helpers.EdgeState,
  request: Request,
  peer?: string,
): Operation<Response> {
  const served = yield* attempt(() => serveRequest(state, request, peer))

  return isFailure(served) ? yield* crashResponse(state, request, served) : served.value.response
}

/**
 * A crash OUTSIDE any edge span (the engine itself failed before it could open one): answered
 * as a 500 in a root edge span named `HTTP` (one ERROR exception) carrying the request id. Never
 * fails — at worst a plain 500.
 */
export function* crashResponse(
  state: Helpers.EdgeState,
  request: Request,
  crash: Result.Failure<unknown>,
): Operation<Response> {
  const answered = yield* attempt(function* () {
    const url = new URL(request.url)
    const edge = yield* edgeSpan({ kernel: state.kernel, request, url, route: null })

    edge.span.updateName('HTTP')
    edge.span.setAttribute('client.address', clientOf(request, undefined))

    try {
      const answer = yield* edge.run(handle =>
        crashed({ state, request, url, edge, handle, observe: 'on' }, crash),
      )

      yield* edge.span.end({ failure: answer.fault })

      return answer.response
    } finally {
      // whatever broke while answering the crash: the span still ends (with the crash)
      yield* edge.span.end({ failure: crash })
    }
  })

  return isFailure(answered) ? new Response('internal error', { status: 500 }) : answered.value
}

/** Refuse an upgrade: the failure envelope under its status, settled / recorded on the upgrade
 * span (an edge-originated 4xx is DEBUG). */
function* refuse(
  answering: Helpers.Answering,
  failure: Result.Failure<unknown>,
): Operation<Helpers.UpgradeDecision> {
  const { state, edge, handle } = answering
  const answer = yield* failed(answering, failure)

  yield* replyFailure(handle, failure, { status: answer.response.status })

  const response = yield* stamp(answer.response, {
    kernel: state.kernel,
    requestId: edge.requestId,
    handle,
    observe: answering.observe,
    failure,
  })

  if (state.kernel.telemetry.observe.capture.headers) {
    handle.setAttributes(
      headerAttributes(
        'response',
        response.headers,
        state.kernel.telemetry.observe.capture.sensitiveKeys,
      ),
    )
  }

  edgeReply(handle, response, failure)

  return { kind: 'reject', response }
}

/** Decide an upgrade INSIDE its span: a socket route, its `authorize`, then the session. */
function* upgradeOf(
  answering: Helpers.Answering,
  match: MatchedRoute<EdgeDef.SocketRoute> | undefined,
): Operation<Helpers.UpgradeDecision> {
  const { state, request, url, edge, handle } = answering
  const { kernel } = state

  if (kernel.telemetry.observe.capture.headers) {
    handle.setAttributes(
      headerAttributes('request', request.headers, kernel.telemetry.observe.capture.sensitiveKeys),
    )
  }

  if (!match) {
    return yield* refuse(
      answering,
      fail(ServerErrors.NotFound, `no socket route for ${url.pathname}`),
    )
  }

  const route = match.data

  // the handshake's verdict IS the socket's principal: what `authorize` resolves rides into
  // the socket ctx as `auth` — handlers never verify the token a second time. Without an
  // authorization header the verdict is DEFERRED to the first `{ t: 'auth' }` frame (browsers
  // cannot set WS headers; tokens never travel in the URL).
  let auth: Helpers.SocketInput['auth'] = { kind: 'settled', principal: undefined }

  if (route.authorize) {
    if (route.authorizeMode === 'first-frame' && request.headers.get('authorization') === null) {
      auth = { kind: 'deferred' }
    } else {
      const allowed = yield* attempt(() => route.authorize!(request))

      if (isFailure(allowed)) {
        return yield* refuse(answering, allowed)
      }

      auth = { kind: 'settled', principal: allowed.value ?? undefined }
    }
  }

  const params = decodeParams(match.params)
  const headers = headersOf(request)
  // every frame span links the upgrade span (`ws.session`); the close log is correlated to it
  const upgrade = handle.valid ? handle.context : null
  // the session's id, decided HERE so the upgrade span carries it: search one id, get the
  // upgrade and every frame of the session
  const sessionId = (yield* IO.actions.uuid()).slice(0, 8)

  handle.setAttribute('ozaco.ws.session.id', sessionId)

  return {
    kind: 'accept',

    attach: raw => {
      void state.scope.run(
        function* () {
          const controller = new AbortController()

          yield* attempt(() =>
            RequestRef.with(new ActiveRequest(edge.requestId, 'external'), () =>
              driveSocket(
                {
                  kernel,
                  route,
                  raw,
                  params,
                  headers,
                  url,
                  requestId: edge.requestId,
                  upgrade,
                  trusted: edge.trusted,
                  marked: edge.marked,
                  signal: controller.signal,
                  actions: state.actions,
                  request,
                  auth,
                },
                sessionId,
              ),
            ),
          )
          controller.abort('closed')
        },
        { detached: true },
      )
    },
  }
}

/** The failure an upgrade the runtime could not complete ends its span with: what the runtime
 * raised (kept as the cause), classified by the status the driver answered. */
const upgradeFailure = (reason: unknown, status: number): Result.Failure<unknown> => {
  const tag = status >= 500 ? ServerErrors.Internal : ServerErrors.BadRequest
  const message = 'the runtime could not complete the websocket upgrade'

  // a Failure is nested as is, anything else the runtime raised folded into one
  return fail(tag, message, reason === undefined || reason === null ? null : asFailure(reason))
}

/**
 * End an ACCEPTED upgrade's span once the runtime reported (design §6.2 — it ends at the 101):
 * `attach` ⇒ 101; `failed` ⇒ the status the driver answered, the failure recorded on the span
 * like any edge-originated one (ERROR + status error for a 5xx) — or, tracing off, one WARN
 * Logger line; never heard back ⇒ cancelled.
 */
function* endUpgrade(
  request: Request,
  edge: Helpers.EdgeSpan,
  upgraded: Helpers.UpgradeOutcome,
): Operation<void> {
  if (upgraded.t === 'unknown') {
    yield* edge.span.end({ cancelled: true })

    return
  }

  if (upgraded.t === 'upgraded') {
    edge.span.setAttribute('http.response.status_code', 101)
    yield* edge.span.end()

    return
  }

  const status = upgraded.status >= 400 && upgraded.status <= 599 ? upgraded.status : 500
  const failure = upgradeFailure(upgraded.reason, status)

  yield* attempt(() =>
    edge.run(function* (handle) {
      yield* replyFailure(handle, failure, { status })
      edgeReply(handle, new Response(null, { status }), failure)

      if (!(yield* Trace.actions.isTracing())) {
        yield* edgeLog('warn', 'edge upgrade failed', {
          'url.path': new URL(request.url).pathname,
          'http.response.status_code': status,
          error: failure,
        })
      }
    }),
  )

  yield* edge.span.end()
}

/**
 * The accept verdict the driver gets: its `attach` / `failed` settle the upgrade span, which a
 * task of the edge's scope ends — when the driver reports, after {@link UPGRADE_SETTLE_MS}
 * without a word (cancelled), or when the edge stops first (cancelled). `attach` always drives
 * the socket (unless `failed` came first); only the first report shapes the span.
 */
const pendingUpgrade = (
  upgrading: Pick<Helpers.Answering, 'state' | 'request' | 'edge'>,
  decision: Extract<Helpers.UpgradeDecision, { kind: 'accept' }>,
): EdgeDef.Accepted => {
  const { state, request, edge } = upgrading
  const reported = withResolvers<Helpers.UpgradeOutcome>('upgrade reported')
  let settled = false
  let refused = false

  const report = (upgraded: Helpers.UpgradeOutcome): void => {
    if (!settled) {
      settled = true
      reported.resolve(upgraded)
    }
  }

  try {
    void state.scope.run(
      function* () {
        let upgraded: Helpers.UpgradeOutcome = { t: 'unknown' }

        try {
          upgraded = yield* race([
            reported.operation,
            (function* (): Operation<Helpers.UpgradeOutcome> {
              yield* sleep(UPGRADE_SETTLE_MS)

              return { t: 'unknown' }
            })(),
          ])
        } finally {
          yield* endUpgrade(request, edge, upgraded)
        }
      },
      { detached: true },
    )
  } catch {
    // the edge's scope is gone: the socket will not be driven either
  }

  return {
    kind: 'accept',
    attach: raw => {
      if (refused) {
        return
      }

      report({ t: 'upgraded' })
      decision.attach(raw)
    },
    failed: (reason, status) => {
      if (settled) {
        return
      }

      refused = true
      report({ t: 'failed', reason, status: status ?? 500 })
    },
  }
}

/**
 * Decide an upgrade (design §6.2): route first, then the upgrade span `GET {route}` — it ends
 * at the verdict for a rejection (its failure settled / recorded on it); an ACCEPTED one stays
 * open until the driver reports the runtime upgrade: 101 (`attach` — the session's frames are
 * traces of their own, linked to it) or the status it answered (`failed`).
 */
export function* decideUpgrade(
  state: Helpers.EdgeState,
  request: Request,
  peer?: string,
): Operation<EdgeDef.Upgrade> {
  const { kernel } = state
  const url = new URL(request.url)
  const match = findRoute(state.sockets, 'WS', url.pathname, { params: true })
  const edge = yield* edgeSpan({ kernel, request, url, route: match?.data.path ?? null })

  edge.span.setAttribute('client.address', clientOf(request, peer))

  // an accepted upgrade's span is ended by the driver's report, not here
  let pending = false

  try {
    const decided = yield* attempt(() =>
      RequestRef.with(new ActiveRequest(edge.requestId, 'external'), () =>
        edge.run(handle => upgradeOf({ state, request, url, edge, handle, observe: 'on' }, match)),
      ),
    )

    if (!isFailure(decided)) {
      if (decided.value.kind === 'accept') {
        pending = true

        return pendingUpgrade({ state, request, edge }, decided.value)
      }

      yield* edge.span.end()

      return decided.value
    }

    const answer = yield* edge.run(handle =>
      crashed({ state, request, url, edge, handle, observe: 'on' }, decided),
    )

    yield* edge.span.end({ failure: answer.fault })

    return { kind: 'reject', response: answer.response }
  } finally {
    // halted before its verdict (the edge stopping): the upgrade span still ends
    if (!pending) {
      yield* edge.span.end({ cancelled: true })
    }
  }
}

export const isSocketRequest = (state: Helpers.EdgeState, request: Request): boolean =>
  request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
  findRoute(state.sockets, 'WS', new URL(request.url).pathname) !== undefined
