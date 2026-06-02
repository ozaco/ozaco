import { Codec, CoreErrors } from 'server:core'
import { operation, until } from 'std:effect'
import type { FetchInit } from 'std:fetch'
import { fetch as httpFetch } from 'std:fetch'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { ClientDef } from '../types'

import { buildRequest } from './build-request'

export interface DispatchReq {
  serviceName: string
  actionKey: string
  params?: unknown[]
}

/**
 * The client broker's dispatch core: turn a resolved call into a direct HTTP request via the route
 * `Manifest`, encode the body / decode the response with the installed `Codec`, and surface a
 * non-2xx response as `fail(error, message)` so the policy onion (retry/circuit-breaker/…) reacts
 * to it as a normal failure. No `Transport` indirection — this is the std:fetch leaf. Cancellation
 * is automatic: `std:fetch` forwards the scope's abort signal, so a timeout-policy halt aborts the
 * in-flight request.
 */
export const httpDispatch = operation(function* (req: DispatchReq, ctx: ClientDef.Context) {
  const route = ctx.manifest[req.serviceName]?.[req.actionKey]
  if (!route) {
    return yield* fail(
      CoreErrors.NotFound,
      `route "${req.serviceName}.${req.actionKey}" not found in client manifest`,
    )
  }

  const built = buildRequest(ctx.baseUrl, route, req.params?.[0])

  const headers = new Headers()
  const extra =
    typeof ctx.headers === 'function' ? yield* until(Promise.resolve(ctx.headers())) : ctx.headers
  if (extra) {
    for (const [key, value] of new Headers(extra)) {
      headers.set(key, value)
    }
  }

  const init: FetchInit = { method: built.method, headers }
  if (built.body !== undefined) {
    headers.set('content-type', 'application/json')
    init.body = (yield* Codec.actions.encode(built.body)) as BodyInit
  }

  const response = yield* httpFetch(built.url, init)
  const bytes = yield* response.bytes()
  const data = bytes.length > 0 ? yield* Codec.actions.decode(bytes) : undefined

  if (!response.ok) {
    return yield* fail(
      (data as AnyType)?.error ?? `http/${response.status}`,
      (data as AnyType)?.message ?? response.statusText,
    )
  }

  return data
})
