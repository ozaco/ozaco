import type { ServerDef } from 'server:core'
import { HEADERS, Server, ServerErrors } from 'server:core'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'

import pkg from '../../../package.json'

import { allowed } from './internal'
import type { CorsDef } from './types'

/**
 * CORS: decorates every response (errors included) with the allow headers and answers
 * preflights for unrouted OPTIONS — through the edge's `decorate`/`preflight` seams, wired at
 * `listen`. Requires an edge.
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
        options?.headers ?? ['content-type', 'authorization', HEADERS.requestId, 'idempotency-key']
      ).join(', '),
      exposeHeaders: (
        options?.exposeHeaders ?? [HEADERS.requestId, HEADERS.brand, HEADERS.error]
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
          yield* edge.actions.decorate(function* (request, response) {
            const origin = allowed(config, request.headers.get('origin'))
            if (origin === null) {
              return response
            }
            const out = new Response(response.body, response)
            out.headers.set('access-control-allow-origin', origin)
            out.headers.set('access-control-expose-headers', config.exposeHeaders)
            if (config.credentials) {
              out.headers.set('access-control-allow-credentials', 'true')
            }
            if (origin !== '*') {
              out.headers.append('vary', 'origin')
            }
            return out
          })
          yield* edge.actions.preflight(function* (request) {
            const origin = allowed(config, request.headers.get('origin'))
            if (origin === null || !request.headers.get('access-control-request-method')) {
              return null
            }
            return new Response(null, {
              status: 204,
              headers: {
                'access-control-allow-origin': origin,
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
