// oxlint-disable import/exports-last
import { createLease, requestId } from 'server:utils'
import type { Lease } from 'server:utils'
import { attempt, operation, sleep } from 'std:effect'
import { isFailure } from 'std:result'

import { findRoute } from 'rou3'
import { JsonCodec } from 'std:codec/impl/json'

import { DataType, REQUEST_ID_HEADER } from '../../const'
import { Broker } from '../../definition'
import { CoreErrors } from '../../errors'
import type { Meta, Reply } from '../../types/common'
import type { Edge, EdgeRequest, EdgeResponse } from '../../types/gateway'
import type { Trace } from '../../types/trace'
import { statusFor } from '../../utils/status'
import { childTrace, rootTrace } from '../../utils/trace'

import { parseJsonBody, parseUrlencoded, queryOf, readBody } from './body'
import { GatewayRef } from './context'
import type { GatewayCtx } from './context'
import { parseMultipart } from './multipart'
import { replyToResponse, streamToResponse } from './rest'
import { registerSocket, removeSocket } from './sockets'

const ENCODER = new TextEncoder()
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const REQUEST_ID_SHAPE = /^[\w-]{1,64}$/u

const errorResponse = operation(function* (input: {
  readonly status: number
  readonly error: string
  readonly message: string
  readonly requestId: string
  readonly causes?: readonly string[] | undefined
}) {
  const { status, ...body } = input
  const bytes = ENCODER.encode(yield* JsonCodec.actions.stringify(body))

  const response: EdgeResponse = {
    status,
    headers: { 'content-type': 'application/json', [REQUEST_ID_HEADER]: input.requestId },
    body: bytes,
  }

  return response
})

const resolveRequestId = operation(function* (headers: Meta) {
  const inbound = headers[REQUEST_ID_HEADER]

  if (inbound && REQUEST_ID_SHAPE.test(inbound)) {
    return inbound
  }

  return yield* requestId()
})

const promoteToken = (headers: Meta, query: Record<string, string>): Meta => {
  const token = query['token'] ?? query['access_token']

  if (!headers['authorization'] && token) {
    return { ...headers, authorization: `Bearer ${token}` }
  }

  return headers
}

const edgeTrace = operation(function* (input: {
  readonly ctx: GatewayCtx
  readonly rid: string
  readonly label: string
}) {
  const base = yield* rootTrace({
    origin: 'external',
    serviceId: `${input.ctx.name}#${input.ctx.gatewayId}`,
    requestId: input.rid,
  })

  const trace: Trace = yield* childTrace(base, {
    service: input.ctx.name,
    action: input.label,
    transport: 'edge',
  })

  return trace
})

interface ResolvedInput {
  readonly params: unknown
  readonly sources?: ReadonlyMap<string, unknown> | undefined
}

const mergeParams = (
  query: Record<string, string>,
  body: unknown,
  pathParams: Record<string, string> | undefined,
): unknown => {
  const bodyObject =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined
  const merged = { ...query, ...bodyObject, ...pathParams }

  if (bodyObject === undefined && body !== undefined) {
    // non-object body (array/string/number) wins when nothing else was provided
    return Object.keys(merged).length === 0 ? body : { ...merged, body }
  }

  // REST semantics: params are always an object at the edge ({} when nothing was provided)
  return merged
}

const resolveInput = operation(function* (input: {
  readonly ctx: GatewayCtx
  readonly request: EdgeRequest
  readonly acceptsParts: boolean
  readonly query: Record<string, string>
  readonly pathParams: Record<string, string> | undefined
}) {
  const { ctx, request, acceptsParts, query, pathParams } = input
  const contentType = request.headers['content-type'] ?? ''
  const hasBody = BODY_METHODS.has(request.method) && request.body !== undefined

  if (hasBody && acceptsParts && contentType.includes('multipart/form-data')) {
    const parsed = yield* parseMultipart(request.headers, request.body as never)
    const sources = new Map<string, unknown>([[DataType.multistream, parsed.multistream]])

    const resolved: ResolvedInput = {
      params: mergeParams({ ...query, ...parsed.fields }, undefined, pathParams),
      sources,
    }

    return resolved
  }

  if (hasBody && contentType.includes('application/x-www-form-urlencoded')) {
    const bytes = yield* readBody(request.body as never, ctx.maxBodyBytes)

    const resolved: ResolvedInput = {
      params: mergeParams({ ...query, ...parseUrlencoded(bytes) }, undefined, pathParams),
    }

    return resolved
  }

  if (hasBody) {
    const bytes = yield* readBody(request.body as never, ctx.maxBodyBytes)
    const body = yield* parseJsonBody(bytes)

    const resolved: ResolvedInput = { params: mergeParams(query, body, pathParams) }

    return resolved
  }

  const resolved: ResolvedInput = { params: mergeParams(query, undefined, pathParams) }

  return resolved
})

const decorate = (ctx: GatewayCtx, request: EdgeRequest, response: EdgeResponse): EdgeResponse => {
  let decorated = response

  for (const decorator of ctx.decorators) {
    try {
      decorated = decorator(request, decorated)
    } catch {
      // decorators are pure by contract; a broken one must not kill the response
    }
  }

  return decorated
}

/** The single HTTP entry — adapters call this for every non-upgrade request. */
export const handleFetch = operation(function* (request: EdgeRequest) {
  const ctx = yield* GatewayRef.expect()
  const rid = yield* resolveRequestId(request.headers)

  if (ctx.state.paused) {
    return decorate(
      ctx,
      request,
      yield* errorResponse({
        status: 503,
        error: CoreErrors.Paused,
        message: 'gateway is paused',
        requestId: rid,
      }),
    )
  }

  ctx.state.inflight += 1

  const outcome = yield* attempt(function* () {
    const { path, query } = queryOf(request.url)
    const match = findRoute(ctx.router, request.method, path, { params: true })

    if (!match) {
      if (request.method === 'OPTIONS' && ctx.hooks.preflight) {
        const preflight = yield* ctx.hooks.preflight(request)

        if (preflight) {
          return preflight
        }
      }

      return yield* errorResponse({
        status: 404,
        error: CoreErrors.NoRoute,
        message: `no route for ${request.method} ${path}`,
        requestId: rid,
      })
    }

    const target = match.data
    const meta = promoteToken(request.headers, query)
    const resolved = yield* resolveInput({
      ctx,
      request,
      acceptsParts: target.action.meta.wire.input.includes('parts'),
      query,
      pathParams: match.params,
    })
    const trace = yield* edgeTrace({ ctx, rid, label: `${request.method} ${path}` })

    const result = yield* attempt(() =>
      Broker.actions.exchange(target.service, target.actionKey, resolved.params, {
        trace,
        origin: 'external',
        meta,
        sources: resolved.sources,
      }),
    )

    if (isFailure(result)) {
      yield* ctx.log.warn('edge dispatch raised', {
        requestId: rid,
        method: request.method,
        path,
        error: String(result.error),
      })

      return yield* errorResponse({
        status: statusFor(result),
        error: String(result.error),
        message: result.message,
        requestId: rid,
        causes: ctx.debug ? result.causes : undefined,
      })
    }

    const reply = result.value as Reply

    if (reply.kind === 'stream') {
      return yield* streamToResponse({ reply, requestId: rid, route: target.action.meta.route })
    }

    return yield* replyToResponse({ reply, requestId: rid, debug: ctx.debug })
  })

  ctx.state.inflight -= 1

  if (isFailure(outcome)) {
    yield* ctx.log.error('edge handler crashed', {
      requestId: rid,
      error: String(outcome.error),
      causes: [...outcome.causes],
    })

    return decorate(
      ctx,
      request,
      yield* errorResponse({
        status: 500,
        error: CoreErrors.Internal,
        message: 'internal error',
        requestId: rid,
      }),
    )
  }

  return decorate(ctx, request, outcome.value)
})

/** The single upgrade path — one handshake, one 401/404 semantic, every runtime. */
export const handleUpgrade = operation(function* (request: EdgeRequest) {
  const ctx = yield* GatewayRef.expect()
  const { path, query } = queryOf(request.url)

  if (ctx.state.paused) {
    const rejection: Edge.Upgrade = { kind: 'reject', status: 503 }

    return rejection
  }

  const match = findRoute(ctx.socketRouter, 'WS', path, { params: true })

  if (!match) {
    const rejection: Edge.Upgrade = { kind: 'reject', status: 404 }

    return rejection
  }

  const route = match.data
  const meta = promoteToken(request.headers, query)

  if (route.authorize) {
    const allowed = yield* attempt(() =>
      (route.authorize as NonNullable<typeof route.authorize>)({ ...request, headers: meta }),
    )

    if (isFailure(allowed) || !allowed.value) {
      const rejection: Edge.Upgrade = { kind: 'reject', status: 401 }

      return rejection
    }
  }

  const handlers: Edge.SocketHandlers = {
    open: operation(function* (socket: Edge.Socket) {
      const handle = registerSocket({
        registry: ctx.sockets,
        gatewayId: ctx.gatewayId,
        edge: socket,
        meta,
        params: match.params ?? {},
      })

      let lease: Lease | undefined
      let watch

      if (ctx.idle) {
        const config = ctx.idle
        const armed = createLease({ ttlMs: config.ttlMs })

        lease = armed
        // detached: an idle-loop failure must never touch the gateway scope
        watch = ctx.scope.run(() => idleWatch(socket, armed, config), { detached: true })
      }

      ctx.bindings.set(socket.id, { route, handle, lease, watch })

      if (route.open) {
        const opened = yield* attempt(() => (route.open as NonNullable<typeof route.open>)(handle))

        if (isFailure(opened)) {
          yield* ctx.log.warn('socket open handler failed', {
            socket: socket.id,
            error: String(opened.error),
          })
        }
      }
    }),

    message: operation(function* (socket: Edge.Socket, data: string | Uint8Array) {
      const binding = ctx.bindings.get(socket.id)

      if (!binding) {
        return
      }

      binding.lease?.renew()

      const handled = yield* attempt(() => binding.route.message(binding.handle, data))

      if (isFailure(handled)) {
        yield* ctx.log.warn('socket message handler failed', {
          socket: socket.id,
          error: String(handled.error),
        })
      }
    }),

    pong: operation(function* (socket: Edge.Socket) {
      ctx.bindings.get(socket.id)?.lease?.renew()
    }),

    close: operation(function* (socket: Edge.Socket, code: number, reason: string) {
      const binding = ctx.bindings.get(socket.id)

      ctx.bindings.delete(socket.id)
      removeSocket(ctx.sockets, socket.id)

      if (binding?.watch) {
        yield* attempt(() => (binding.watch as NonNullable<typeof binding.watch>).halt())
      }

      if (binding?.route.close) {
        const closed = yield* attempt(() =>
          (binding.route.close as NonNullable<typeof binding.route.close>)(
            binding.handle,
            code,
            reason,
          ),
        )

        if (isFailure(closed)) {
          yield* ctx.log.warn('socket close handler failed', {
            socket: socket.id,
            error: String(closed.error),
          })
        }
      }
    }),
  }

  const acceptance: Edge.Upgrade = { kind: 'accept', handlers }

  return acceptance
})

/**
 * Per-socket liveness loop: pings on the interval (browsers pong automatically → adapters renew
 * the lease) and closes half-open/dead peers when the lease expires — the reap cascades through
 * the adapter's close event into binding + watch-task cleanup.
 */
const idleWatch = operation(function* (
  socket: Edge.Socket,
  lease: Lease,
  config: { readonly ttlMs: number; readonly pingMs: number },
) {
  const interval = config.pingMs > 0 ? config.pingMs : Math.max(Math.floor(config.ttlMs / 4), 10)

  while (true) {
    yield* sleep(interval)

    if (lease.expired()) {
      socket.close(4000, 'idle timeout')

      return
    }

    if (config.pingMs > 0) {
      socket.ping?.()
    }
  }
})
