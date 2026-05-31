import { operation, until } from 'std:effect'
import type { FetchInit } from 'std:fetch'
import { fetch as httpFetch } from 'std:fetch'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { ClientDef } from './types'

const PARAM = /:([A-Za-z0-9_]+)/gu

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

interface BuiltRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

const buildRequest = (baseUrl: string, route: ClientDef.Route, input: unknown): BuiltRequest => {
  const headers: Record<string, string> = {}
  const method = route.method.toUpperCase()
  const writes = method !== 'GET' && method !== 'HEAD'

  // Fill `:param` segments from the input object; remaining fields become body/query.
  const consumed = new Set<string>()
  const path = route.path.replace(PARAM, (_match, name: string) => {
    consumed.add(name)
    return encodeURIComponent(String(isPlainObject(input) ? input[name] : input))
  })

  let url = baseUrl.replace(/\/$/u, '') + path
  let body: string | undefined

  const payload = isPlainObject(input)
    ? Object.fromEntries(Object.entries(input).filter(([key]) => !consumed.has(key)))
    : input

  if (writes) {
    const present = isPlainObject(payload) ? Object.keys(payload).length > 0 : payload !== undefined
    if (present) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(payload)
    }
  } else if (isPlainObject(payload)) {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined) {
        query.set(key, typeof value === 'string' ? value : JSON.stringify(value))
      }
    }
    const search = query.toString()
    if (search) {
      url += (url.includes('?') ? '&' : '?') + search
    }
  }

  return { url, method, headers, body }
}

/**
 * Build a typed client from an emitted route `Manifest`. `TServices` is the app's `services`
 * object *type* (`typeof services`), supplied by the generated binding — full input/output
 * inference with no runtime coupling to the backend. Each method is an `operation` that dispatches
 * through `std:fetch` (so it composes with the effect runtime — cancellation via the scope's abort
 * signal — and never throws): non-2xx becomes the decoded `fail(error, message)`, transport faults
 * surface as `std:fetch`'s typed `FetchError` (`'network'`/`'abort'`/`'parse'`). Override the
 * underlying fetch (tests, SSR) via `std:fetch`'s `fetchImpl` context.
 */
const createClient = <TServices>(
  manifest: ClientDef.Manifest,
  options: ClientDef.Options,
): ClientDef.Client<TServices> => {
  const call = operation(function* (service: string, action: string, input: unknown) {
    const route = manifest[service]?.[action]
    if (!route) {
      return yield* fail('client/no-route', `no route emitted for ${service}.${action}`)
    }

    const built = buildRequest(options.baseUrl, route, input)
    const headers = new Headers(built.headers)
    const extra =
      typeof options.headers === 'function'
        ? yield* until(Promise.resolve(options.headers()))
        : options.headers
    if (extra) {
      for (const [key, value] of new Headers(extra)) {
        headers.set(key, value)
      }
    }

    const init: FetchInit = { method: built.method, headers }
    if (built.body !== undefined) {
      init.body = built.body
    }

    const response = yield* httpFetch(built.url, init)
    const text = yield* response.text()
    const data = text ? safeJson(text) : undefined

    if (!response.ok) {
      const code = (data as AnyType)?.error ?? `http/${response.status}`
      const message = (data as AnyType)?.message ?? response.statusText
      return yield* fail(code, message)
    }

    return data
  })

  const serviceProxy = (service: string): AnyType =>
    new Proxy(
      {},
      {
        get: (_target, action: PropertyKey) => (input: unknown) =>
          call(service, String(action), input),
      },
    )

  return new Proxy(
    {},
    {
      get: (_target, service: PropertyKey) => serviceProxy(String(service)),
    },
  ) as ClientDef.Client<TServices>
}

export type { ClientDef } from './types'
export { createClient }
