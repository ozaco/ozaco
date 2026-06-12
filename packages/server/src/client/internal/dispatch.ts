import { Codec, CodecErrors } from 'std:codec'
import { operation, until } from 'std:effect'
import type { FetchDef } from 'std:fetch'
import { fetch as httpFetch } from 'std:fetch'
import { fail } from 'std:result'

import type { ClientDef } from '../types'

import { buildRequest } from './build-request'

export interface DispatchReq {
  serviceName: string
  actionKey: string
  params?: unknown[]
}

/**
 * The client broker's dispatch core: turn a resolved call into a direct HTTP request via the route
 * `Manifest`, encode the body with the registered `Codec`, and surface a non-2xx as
 * `fail(error, message)` so the policy onion (retry/circuit-breaker/…) reacts to it as a normal
 * failure. No `Transport` indirection — this is the std:fetch leaf. Cancellation is automatic:
 * `std:fetch` forwards the scope's abort signal, so a timeout-policy halt aborts the in-flight
 * request.
 *
 * The 2xx response is consumed entirely through `std:fetch` (which decodes via the same registered
 * codec the broker installed): `raw` → the undecoded byte stream, `stream` → the codec-decoded value
 * stream, `body` (default) → the whole decoded body.
 */
export const httpDispatch = operation(function* (
  req: DispatchReq,
  ctx: ClientDef.Context,
  mode: ClientDef.DispatchMode = 'body',
) {
  const route = ctx.manifest[req.serviceName]?.[req.actionKey]
  if (!route) {
    return yield* fail(
      CodecErrors.NoCodec,
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

  const init: FetchDef.Init = { method: built.method, headers }
  if (built.body !== undefined) {
    headers.set('content-type', 'application/json')
    init.body = (yield* Codec.actions.encode(built.body)) as BodyInit
  }

  const response = yield* httpFetch(built.url, init)

  // a non-2xx is a failure regardless of mode — decode the (small) error body for its { error,
  // message } so the policy onion reacts to it the same way it does on a body() call.
  if (!response.ok) {
    const data = yield* response.body<{ error?: string; message?: string }>()
    return yield* fail(
      data?.error ?? `http/${response.status}`,
      data?.message ?? response.statusText,
    )
  }

  if (mode === 'raw') {
    return yield* response.raw()
  }
  if (mode === 'stream') {
    return yield* response.stream()
  }

  return yield* response.body()
})
