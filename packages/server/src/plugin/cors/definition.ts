import type { EdgeRequest, EdgeResponse, Meta } from 'server:core'
import { Gateway } from 'server:core'
import { operation } from 'std:effect'
import { definePlugin } from 'std:plugin'

import type { CorsConfig, CorsOptions } from './types'

const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
const DEFAULT_HEADERS = ['content-type', 'authorization', 'x-request-id'] as const
const DEFAULT_EXPOSE_HEADERS = ['x-request-id'] as const
const DEFAULT_MAX_AGE_SECONDS = 600

/**
 * The origin value to answer with: echo the request origin when it's allowlisted; a `'*'` config
 * answers the literal `*` — unless credentials are on, which always echo the specific origin.
 * `undefined` means "not allowed": no CORS headers at all.
 */
const allowedOrigin = (config: CorsConfig, origin: string | undefined): string | undefined => {
  if (!origin) {
    return undefined
  }

  if (config.origins === '*') {
    return config.credentials ? origin : '*'
  }

  return config.origins.includes(origin) ? origin : undefined
}

const baseHeaders = (config: CorsConfig, allowed: string): Meta => {
  const headers: Meta = { 'access-control-allow-origin': allowed }

  if (allowed !== '*') {
    // the response depends on the request origin — caches must key on it
    headers['vary'] = 'origin'
  }

  if (config.credentials) {
    headers['access-control-allow-credentials'] = 'true'
  }

  return headers
}

/** The headers decorated onto EVERY response for an allowed origin. */
const corsHeaders = (config: CorsConfig, origin: string | undefined): Meta | undefined => {
  const allowed = allowedOrigin(config, origin)

  if (allowed === undefined) {
    return undefined
  }

  return { ...baseHeaders(config, allowed), 'access-control-expose-headers': config.exposeHeaders }
}

/** The preflight response headers for an allowed origin. */
const preflightHeaders = (config: CorsConfig, origin: string | undefined): Meta | undefined => {
  const allowed = allowedOrigin(config, origin)

  if (allowed === undefined) {
    return undefined
  }

  return {
    ...baseHeaders(config, allowed),
    'access-control-allow-methods': config.methods,
    'access-control-allow-headers': config.headers,
    'access-control-max-age': String(config.maxAgeSeconds),
  }
}

/**
 * The CORS plugin. Install AFTER `DefaultGateway` (it registers into the running engine):
 * `install(Cors, { origins: ['https://app.example'], credentials: true })`. Allowed origins get
 * the `access-control-*` headers decorated onto every edge response, and unrouted `OPTIONS`
 * requests are answered 204 through the gateway's preflight hook; disallowed origins get neither.
 */
export const Cors = definePlugin<CorsConfig, [options?: CorsOptions]>({
  name: 'server/plugin-cors',
  version: '0.1.0',
  description: 'CORS response decorator + unrouted-OPTIONS preflight handler for the gateway',

  *setup(options = {}) {
    const config: CorsConfig = {
      origins: options.origins ?? '*',
      methods: (options.methods ?? DEFAULT_METHODS).join(', '),
      headers: (options.headers ?? DEFAULT_HEADERS).join(', '),
      exposeHeaders: (options.exposeHeaders ?? DEFAULT_EXPOSE_HEADERS).join(', '),
      credentials: options.credentials ?? false,
      maxAgeSeconds: options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS,
    }

    yield* Gateway.actions.decorate((request, response) => {
      const extra = corsHeaders(config, request.headers['origin'])

      return extra ? { ...response, headers: { ...response.headers, ...extra } } : response
    })

    yield* Gateway.actions.preflight(
      operation(function* (request: EdgeRequest) {
        const headers = preflightHeaders(config, request.headers['origin'])

        if (!headers) {
          return undefined
        }

        const response: EdgeResponse = { status: 204, headers }

        return response
      }),
    )

    return config
  },
}).build()
