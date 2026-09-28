import type { ServerDef } from 'server:core'
import { HEADERS, Server, ServerErrors } from 'server:core'
import { rewrapResponse } from 'server:internal'
import type { Operation } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'
import { Trace } from 'std:trace'

import pkg from '../../../package.json'

import { REJECT_EVENT, verdictOf } from './internal'
import type { CorsDef } from './types'

/**
 * Say a cross-origin request's verdict on the edge span (the decorators run inside it):
 * `ozaco.cors.preflight`, `ozaco.cors.allowed` and — for a request the browser will refuse — one
 * `cors.reject` event `{ ozaco.cors.reason }`. The request itself is answered as before (a
 * refused origin gets no allow headers; an unanswered preflight is the edge's 404).
 */
function* note(verdict: CorsDef.Verdict): Operation<void> {
  if (!verdict.cross) {
    return
  }

  const span = yield* Trace.actions.current()

  span.setAttributes({
    'ozaco.cors.preflight': verdict.preflight,
    'ozaco.cors.allowed': verdict.reason === null,
  })

  if (verdict.reason !== null) {
    span.addEvent(REJECT_EVENT, { 'ozaco.cors.reason': verdict.reason })
  }
}

/**
 * CORS: decorates every response (errors included) with the allow headers and answers
 * preflights for unrouted OPTIONS — through the edge's `decorate`/`preflight` seams, wired at
 * `listen`. Requires an edge. W3C trace context is allowed in (`traceparent`, `tracestate`) and
 * `x-request-id` / `traceresponse` are exposed by default; each cross-origin request's verdict
 * lands on its edge span (see `note`).
 */
export const Cors = definePlugin<ServerDef.PluginContext, [options?: CorsDef.Options]>({
  name: 'server-cors',
  version: pkg.version,
  description: 'Cross-origin resource sharing over the edge',

  *setup(options) {
    const kernel = yield* Server.context.get()

    if (!kernel) {
      return yield* fail(ServerErrors.Configuration, 'Cors must be installed by createServer')
    }

    const config: CorsDef.Config = {
      origins: options?.origins ?? '*',
      methods: (options?.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).join(
        ', ',
      ),
      headers: (
        options?.headers ?? [
          'content-type',
          'authorization',
          HEADERS.requestId,
          'idempotency-key',
          HEADERS.traceparent,
          HEADERS.tracestate,
        ]
      ).join(', '),
      exposeHeaders: (
        options?.exposeHeaders ?? [
          HEADERS.requestId,
          HEADERS.brand,
          HEADERS.error,
          HEADERS.traceresponse,
        ]
      ).join(', '),
      credentials: options?.credentials ?? false,
      maxAgeSeconds: options?.maxAgeSeconds ?? 600,
    }

    return {
      hooks: {
        name: 'cors',
        *start() {
          const edge = kernel.edge

          if (!edge) {
            return
          }

          // every response passes here — a preflight's own 204 too: the ONE place the verdict
          // is said
          yield* edge.actions.decorate(function* (request, response) {
            const verdict = verdictOf(config, request)

            yield* note(verdict)

            if (verdict.origin === null) {
              return response
            }

            const out = rewrapResponse(response)

            out.headers.set('access-control-allow-origin', verdict.origin)
            out.headers.set('access-control-expose-headers', config.exposeHeaders)

            if (config.credentials) {
              out.headers.set('access-control-allow-credentials', 'true')
            }

            if (verdict.origin !== '*') {
              out.headers.append('vary', 'origin')
            }

            return out
          })
          yield* edge.actions.preflight(function* (request) {
            const verdict = verdictOf(config, request)

            if (verdict.origin === null || !verdict.preflight) {
              return null
            }

            return new Response(null, {
              status: 204,
              headers: {
                'access-control-allow-origin': verdict.origin,
                'access-control-allow-methods': config.methods,
                'access-control-allow-headers': config.headers,
                'access-control-max-age': String(config.maxAgeSeconds),
                ...(config.credentials ? { 'access-control-allow-credentials': 'true' } : {}),
              },
            })
          })
        },
      },
    }
  },
}).build()
