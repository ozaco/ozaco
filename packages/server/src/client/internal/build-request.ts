import type { ClientDef } from '../types'

const PARAM = /:([A-Za-z0-9_]+)/gu

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export interface BuiltRequest {
  url: string
  method: string
  /** The remaining payload to encode as the request body (via the codec), or `undefined`. */
  body: unknown
}

/**
 * Map a single action input onto a manifest `Route`: fill `:param` path segments from the input
 * object, then route the remaining fields to the JSON body (write methods) or the query string
 * (GET/HEAD). Method and path come only from the manifest — never inferred here.
 */
export const buildRequest = (
  baseUrl: string,
  route: ClientDef.Route,
  input: unknown,
): BuiltRequest => {
  const method = route.method.toUpperCase()
  const writes = method !== 'GET' && method !== 'HEAD'

  const consumed = new Set<string>()
  const path = route.path.replace(PARAM, (_match, name: string) => {
    consumed.add(name)
    return encodeURIComponent(String(isPlainObject(input) ? input[name] : input))
  })

  let url = baseUrl.replace(/\/$/u, '') + path
  let body: unknown

  const payload = isPlainObject(input)
    ? Object.fromEntries(Object.entries(input).filter(([key]) => !consumed.has(key)))
    : input

  if (writes) {
    const present = isPlainObject(payload) ? Object.keys(payload).length > 0 : payload !== undefined
    if (present) {
      body = payload
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

  return { url, method, body }
}
