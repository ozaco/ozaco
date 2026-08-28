// oxlint-disable import/exports-last
import type { Operation, Scope } from 'std:effect'
import { attempt, createContext, until, useScope } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { addRoute, createRouter, findRoute } from 'rou3'
import type { RouterContext } from 'rou3'

import { HEADERS, laneOf } from '../../const'
import { ServerErrors } from '../../errors'
import type { EdgeDef } from '../../types/edge'
import type { ServerDef } from '../../types/server'
import type { ServiceDef } from '../../types/service'
import type { TraceDef } from '../../types/trace'
import { statusOf, tagOf } from '../../utils/failure'
import {
  brandOf,
  brandStream,
  isBranded,
  isPartsDecl,
  isStreamDecl,
  stream,
} from '../../utils/stream'
import { childTrace, report, rootTrace, withSpan } from '../../utils/trace'
import type { Captured } from '../capture'
import { capturedHeaders, capturedValue, countingStream, emptyCapture, observing } from '../capture'
import { contextFor, materialize } from '../dispatch'

import { valueBody } from './body'
import { parseParts } from './multipart'
import { failureResponse, responseOf } from './respond'
import { driveSocket } from './sockets'

/** One mounted action route. */
interface ActionRoute {
  readonly kind: 'action'
  readonly service: string
  readonly action: string
  readonly meta: ServiceDef.Meta
}

interface RawRouteEntry {
  readonly kind: 'raw'
  readonly route: EdgeDef.RawRoute
}

type Entry = ActionRoute | RawRouteEntry

/** Per-install engine state (the Edge impl's context holds it). */
export interface EdgeState {
  readonly kernel: ServerDef.Context
  readonly actions: Pick<ServerDef.Actions, 'call' | 'emit' | 'dispatch'>
  readonly router: RouterContext<Entry>
  readonly sockets: RouterContext<EdgeDef.SocketRoute>
  readonly decorators: EdgeDef.Decorator[]
  readonly scope: Scope
  preflight: EdgeDef.Preflight | null
  paused: boolean
  mounted: boolean
  info: EdgeDef.ListenInfo | null
}

export const EdgeStateRef = createContext<EdgeState>('server:edge/state')

export function* createEdgeState(
  kernel: ServerDef.Context,
  actions: EdgeState['actions'],
): Operation<EdgeState> {
  const state: EdgeState = {
    kernel,
    actions,
    router: createRouter<Entry>(),
    sockets: createRouter<EdgeDef.SocketRoute>(),
    decorators: [],
    scope: yield* useScope(),
    preflight: null,
    paused: false,
    mounted: false,
    info: null,
  }
  yield* EdgeStateRef.set(state)

  return state
}

/**
 * Request headers as a plain record. On a SOCKET UPGRADE only, a `?token=` query param is
 * promoted to a bearer header — browsers cannot set handshake headers on a WebSocket, so that
 * is the one place it is needed. HTTP requests do NOT get the promotion: a token in the query
 * string of an ordinary request lands in access logs, referrers and browser history.
 */
const headersOf = (request: Request, promoteToken = false): Record<string, string> => {
  const headers = Object.fromEntries(request.headers.entries())

  if (promoteToken && !headers.authorization) {
    const token = new URL(request.url).searchParams.get('token')

    if (token) {
      headers.authorization = `Bearer ${token}`
    }
  }

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

/** Mount every action of the kernel's registry (idempotent). */
export const mountActions = (state: EdgeState): number => {
  if (state.mounted) {
    return 0
  }

  state.mounted = true
  let count = 0

  for (const [key, def] of state.kernel.registry.actions) {
    const [service, action] = key.split('.') as [string, string]

    addRoute(state.router, def.meta.route.method, def.meta.route.path, {
      kind: 'action',
      service,
      action,
      meta: def.meta,
    })
    count += 1
  }

  // sockets declared inside services (`action.socket`): already in kernel.sockets (the
  // manifest), routed here
  for (const socket of state.kernel.registry.sockets) {
    addRoute(state.sockets, 'WS', socket.path, {
      path: socket.path,
      handler: socket.handler,
      authorize: socket.authorize ?? undefined,
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

interface ActionCall {
  readonly state: EdgeState
  readonly request: Request
  readonly entry: ActionRoute
  readonly params: Readonly<Record<string, string>>
  readonly trace: TraceDef.Trace

  /** filled while the action runs (only when an observer is installed). */
  readonly captured: Captured
}

/** Run one action route: build the call, dispatch through the kernel, render the response. */
function* runAction({
  state,
  request,
  entry,
  params,
  trace,
  captured,
}: ActionCall): Operation<Response> {
  const watched = observing(state.kernel)

  if (watched) {
    captured.headers = capturedHeaders(headersOf(request))
  }

  const input = yield* attempt(() => inputOf(request, entry.meta, params))

  if (isFailure(input)) {
    return yield* reportedFailure(state, {
      requestId: trace.request_id,
      spanId: trace.span_id,
      failure: input,
      where: `edge:input ${entry.service}.${entry.action}`,
      meta: entry.meta,
    })
  }

  if (watched) {
    captured.input = capturedValue(input.value)
  }

  // a big stream body is observed as its SIZE — counted as it flows, never buffered
  let callInput = input.value

  if (watched && isBranded(input.value)) {
    const snapshot = captured.input
    const brand = brandOf(input.value)
    let settle: () => void = () => {}

    captured.pending.push(
      new Promise<void>(resolve => {
        settle = resolve
      }),
    )
    callInput = brandStream(
      countingStream(input.value as ReadableStream<Uint8Array>, bytes => {
        captured.input = { ...snapshot, size: bytes }
        settle()
      }),
      brand,
    )
  }

  const controller = new AbortController()
  request.signal?.addEventListener('abort', () => controller.abort(ServerErrors.Cancelled))
  const dispatchTrace = yield* childTrace(trace)

  const hop: TraceDef.Hop = {
    service: entry.service,
    action: entry.action,
    span_id: dispatchTrace.span_id,
    transport: 'edge',
    ts: Date.now(),
  }

  const call: ServerDef.Call = {
    cid: dispatchTrace.span_id,
    service: entry.service,
    action: entry.action,
    input: callInput,
    trace: { ...dispatchTrace, lane: [hop] },
    headers: headersOf(request),
    deadline: Date.now() + state.kernel.timeoutMs,
    idempotencyKey: request.headers.get('idempotency-key') ?? undefined,
    transport: 'edge',
    signal: controller.signal,
    abort: reason => controller.abort(reason),
  }

  // the kernel action unwraps a returned Result (std plugin contract): fold it back here.
  // The dispatch runs INLINE in the request scope — a stream reply's lanes/pumps must live
  // exactly as long as the response body; a disconnecting client aborts `call.signal`, and
  // `invoke` halts the handler (`onDisconnect: 'cancel'`) from there.
  const outcome = yield* attempt(() => state.actions.dispatch(call))

  if (isFailure(outcome)) {
    return failureResponse(outcome, trace.request_id, entry.meta)
  }

  if (watched) {
    captured.output = capturedValue(outcome.value)
  }

  const response = responseOf(yield* materialize(outcome.value), trace.request_id)
  const kind = captured.output?.['kind']

  if (watched && captured.output && (kind === 'stream' || kind === 'flow') && response.body) {
    const snapshot = captured.output
    let settle: () => void = () => {}

    captured.pending.push(
      new Promise<void>(resolve => {
        settle = resolve
      }),
    )

    return new Response(
      countingStream(response.body, bytes => {
        captured.output = { ...snapshot, size: bytes }
        settle()
      }),
      { status: response.status, headers: response.headers },
    )
  }

  return response
}

interface Finish {
  readonly state: EdgeState
  readonly request: Request
  readonly response: Response
  readonly requestId: string
}

/** Decorate and stamp the request id on every response (errors included). */
function* finish({ state, request, response, requestId }: Finish): Operation<Response> {
  let out = response

  for (const decorator of state.decorators) {
    out = yield* decorator(request, out)
  }

  if (!out.headers.get(HEADERS.requestId)) {
    out = new Response(out.body, out)
    out.headers.set(HEADERS.requestId, requestId)
  }

  return out
}

/** A failure RETURNED as a response never raises through a span — report its row here, so
 * unrouted 404s, rejected upgrades and validation errors land in the observe store and every
 * exporter (the dispatch path is NOT routed through this: `withSpan` already reports it). */
function* reportedFailure(
  state: EdgeState,
  input: {
    readonly requestId: string
    readonly spanId?: string | undefined
    readonly failure: AnyType
    readonly where: string
    readonly meta?: Pick<ServiceDef.Meta, 'errors'> | undefined
  },
): Operation<Response> {
  yield* report(state.kernel, {
    t: 'failure',
    row: {
      request_id: input.requestId,
      span_id: input.spanId ?? null,
      tag: tagOf(input.failure),
      message: String(input.failure.message ?? ''),
      causes: [...(input.failure.causes ?? [])].map(String),
      status: statusOf(input.failure, input.meta),
      where: input.where,
      ts: Date.now(),
    },
  })

  return failureResponse(input.failure, input.requestId, input.meta)
}

/**
 * Handle one HTTP request end to end: request id (accepted or minted, always echoed), an
 * `edge` span + a request row, raw routes, action routes (input by plane → kernel dispatch →
 * response by brand), preflight for unrouted OPTIONS, 404 otherwise, 503 while paused.
 */
export function* handleRequest(state: EdgeState, request: Request): Operation<Response> {
  const { kernel } = state
  const url = new URL(request.url)
  const requestId = request.headers.get(HEADERS.requestId) ?? (yield* IO.actions.uuid())
  const trace = yield* rootTrace(kernel.serviceId, 'external', requestId)
  const startedAt = Date.now()
  let routed: ActionRoute | null = null
  const captured = emptyCapture()

  const response: Response = yield* withSpan(
    { kernel, trace, kind: 'edge', name: `${request.method} ${url.pathname}` },
    function* (): Operation<Response> {
      if (state.paused) {
        return yield* reportedFailure(state, {
          requestId,
          spanId: trace.span_id,
          failure: fail(ServerErrors.Paused, 'the edge is draining') as AnyType,
          where: 'edge:paused',
        })
      }
      const match = findRoute(state.router, request.method, url.pathname, { params: true })
      if (match) {
        const params = decodeParams(match.params)
        const entry = match.data
        if (entry.kind === 'raw') {
          const raw = yield* attempt(() => entry.route.handler(request, params))

          if (isFailure(raw)) {
            return yield* reportedFailure(state, {
              requestId,
              spanId: trace.span_id,
              failure: raw,
              where: `edge:raw ${url.pathname}`,
            })
          }

          return raw.value
        }
        routed = entry
        return yield* runAction({ state, request, entry, params, trace, captured })
      }
      if (request.method === 'OPTIONS' && state.preflight) {
        const answered = yield* attempt(() => state.preflight!(request))
        if (!isFailure(answered) && answered.value) {
          return answered.value
        }
      }
      return yield* reportedFailure(state, {
        requestId,
        spanId: trace.span_id,
        failure: fail(
          ServerErrors.NotFound,
          `no route for ${request.method} ${url.pathname}`,
        ) as AnyType,
        where: 'edge:route',
      })
    },
  )
  const decorated = yield* finish({ state, request, response, requestId })
  const endedAt = Date.now()
  const entry = routed as ActionRoute | null

  yield* report(kernel, {
    t: 'request',
    row: {
      request_id: requestId,
      origin: 'external',
      service: entry?.service ?? null,
      action: entry?.action ?? null,
      edge: 'http',
      method: request.method,
      path: url.pathname,
      socket: null,
      status: decorated.status,
      service_id: kernel.serviceId,
      instance: kernel.instance,
      lane: entry ? laneOf([{ service: entry.service }]) : '',
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: endedAt - startedAt,
      error:
        decorated.status >= 400
          ? (decorated.headers.get(HEADERS.error) ?? String(decorated.status))
          : null,
      attrs: null,
      headers: captured.headers,
      input: captured.input,
      output: captured.output,
    },
  })

  // a streamed body outlives the row above: patch in the final size + true duration once done
  if (captured.pending.length > 0) {
    const pending = [...captured.pending]

    state.scope.run(
      function* () {
        yield* until(Promise.all(pending))
        const finishedAt = Date.now()

        yield* report(kernel, {
          t: 'request-update',
          update: {
            request_id: requestId,
            patch: {
              input: captured.input,
              output: captured.output,
              duration_ms: finishedAt - startedAt,
              ended_at: finishedAt,
            },
          },
        })
      },
      { detached: true },
    )
  }

  return decorated
}

/** Decide an upgrade: a socket route, its `authorize`, then a handler scope per socket. */
export function* decideUpgrade(state: EdgeState, request: Request): Operation<EdgeDef.Upgrade> {
  const { kernel } = state
  const url = new URL(request.url)
  const requestId = request.headers.get(HEADERS.requestId) ?? (yield* IO.actions.uuid())
  const match = findRoute(state.sockets, 'WS', url.pathname, { params: true })

  if (!match) {
    return {
      kind: 'reject',

      response: yield* reportedFailure(state, {
        requestId,
        failure: fail(ServerErrors.NotFound, `no socket route for ${url.pathname}`) as AnyType,
        where: `edge:socket ${url.pathname}`,
      }),
    }
  }

  const route = match.data

  // the handshake's verdict IS the socket's principal: what `authorize` resolves rides into
  // the socket ctx as `auth` — handlers never verify the token a second time
  let principal: unknown

  if (route.authorize) {
    const allowed = yield* attempt(() => route.authorize!(request))

    if (isFailure(allowed)) {
      return {
        kind: 'reject',

        response: yield* reportedFailure(state, {
          requestId,
          failure: allowed,
          where: `edge:socket ${url.pathname}`,
        }),
      }
    }

    principal = allowed.value ?? undefined
  }

  const params = decodeParams(match.params)
  const headers = headersOf(request, true)
  const socketHeaders = observing(kernel) ? capturedHeaders(headers) : null
  const trace = yield* rootTrace(kernel.serviceId, 'external', requestId)

  return {
    kind: 'accept',

    attach: raw => {
      void state.scope.run(function* () {
        const startedAt = Date.now()
        const controller = new AbortController()
        const outcome = yield* attempt(function* () {
          const ctx = yield* contextFor(
            kernel,
            { trace, headers, signal: controller.signal, name: route.path, auth: principal },
            state.actions,
          )
          yield* withSpan({ kernel, trace, kind: 'edge', name: `WS ${route.path}` }, () =>
            driveSocket({ kernel, route, raw, params, headers, url, ctx, trace }),
          )
        })
        controller.abort('closed')
        const endedAt = Date.now()
        yield* report(kernel, {
          t: 'request',
          row: {
            request_id: requestId,
            origin: 'external',
            service: null,
            action: null,
            edge: 'ws',
            method: null,
            path: null,
            socket: route.path,
            status: isFailure(outcome) ? statusOf(outcome) : 101,
            service_id: kernel.serviceId,
            instance: kernel.instance,
            lane: '',
            started_at: startedAt,
            ended_at: endedAt,
            duration_ms: endedAt - startedAt,
            error: isFailure(outcome) ? String(outcome.error) : null,
            attrs: null,
            headers: socketHeaders,
            input: null,
            output: null,
          },
        })
      })
    },
  }
}

export const isSocketRequest = (state: EdgeState, request: Request): boolean =>
  request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
  findRoute(state.sockets, 'WS', new URL(request.url).pathname) !== undefined

/**
 * Wrap a response so the request's scope can wait for its body to finish (streamed bodies keep
 * their pumps alive that long). Resolves immediately for bodies that are not streams.
 */
export const trackBody = (response: Response): { response: Response; done: Promise<void> } => {
  if (!response.body) {
    return { response, done: Promise.resolve() }
  }

  let settle: () => void = () => {}

  const done = new Promise<void>(resolve => {
    settle = resolve
  })
  const source = response.body.getReader()

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const step = await source.read()
        if (step.done) {
          controller.close()
          settle()
          return
        }
        controller.enqueue(step.value)
      } catch (error) {
        controller.error(error)
        settle()
      }
    },
    async cancel(reason) {
      await source.cancel(reason).catch(() => {})
      settle()
    },
  })

  return { response: new Response(body, response), done }
}
