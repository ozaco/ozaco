import type { CorsDef } from './types'

/** Methods a browser never preflights for (Fetch: CORS-safelisted methods). */
const SAFELISTED_METHODS = new Set(['GET', 'HEAD', 'POST'])

/** A comma-separated header value as its trimmed, non-empty items. */
const listOf = (value: string | null): string[] =>
  (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '')

/** Whether a preflighted method passes (Fetch's CORS-preflight check: exact match, a safelisted
 * method, or `*` when the response is not credentialed). */
const methodPasses = (config: CorsDef.Config, method: string): boolean => {
  const methods = listOf(config.methods)

  return (
    SAFELISTED_METHODS.has(method) ||
    methods.includes(method) ||
    (!config.credentials && methods.includes('*'))
  )
}

/** Whether every preflighted request header passes (case-insensitive; `*` covers all but
 * `authorization` when the response is not credentialed). */
const headersPass = (config: CorsDef.Config, requested: string | null): boolean => {
  const allowedHeaders = new Set(listOf(config.headers).map(name => name.toLowerCase()))
  const wildcard = !config.credentials && allowedHeaders.has('*')

  return listOf(requested).every(name => {
    const lower = name.toLowerCase()

    return allowedHeaders.has(lower) || (wildcard && lower !== 'authorization')
  })
}

/** Whether the request comes from the page's own origin (Fetch Metadata, else the URL): a
 * same-origin request carrying `origin` is no CORS request and never a rejection. */
const sameOrigin = (request: Request, origin: string): boolean => {
  if (request.headers.get('sec-fetch-site') === 'same-origin') {
    return true
  }

  try {
    return new URL(request.url).origin === origin
  } catch {
    return false
  }
}

/** Why the browser will refuse the request, `null` when it will not. */
const reasonOf = (
  config: CorsDef.Config,
  request: Request,
  origin: string | null,
): CorsDef.Reason | null => {
  if (origin === null) {
    return 'origin'
  }

  const method = request.headers.get('access-control-request-method')

  if (request.method !== 'OPTIONS' || !method) {
    return null
  }

  if (!methodPasses(config, method)) {
    return 'method'
  }

  return headersPass(config, request.headers.get('access-control-request-headers'))
    ? null
    : 'headers'
}

/** The span event a refused cross-origin request leaves on the edge span (≤ 20 chars). */
export const REJECT_EVENT = 'cors.reject'

/** The origin to echo for a request, or null when it is not allowed. */
export const allowed = (config: CorsDef.Config, origin: string | null): string | null => {
  if (config.origins === '*') {
    return config.credentials ? origin : '*'
  }

  return origin !== null && config.origins.includes(origin) ? origin : null
}

/**
 * How CORS answers a request: the origin to echo (`null` = not allowed), whether it is a
 * preflight (`OPTIONS` + `access-control-request-method`), whether it is cross-origin at all (an
 * `origin` header that is not the page's own) and — for a request the browser will refuse — why
 * (`origin`, or a preflighted `method` / `headers` the answer does not allow).
 */
export const verdictOf = (config: CorsDef.Config, request: Request): CorsDef.Verdict => {
  const header = request.headers.get('origin')
  const origin = allowed(config, header)

  return {
    origin,
    preflight:
      request.method === 'OPTIONS' && Boolean(request.headers.get('access-control-request-method')),
    cross: header !== null && !sameOrigin(request, header),
    reason: reasonOf(config, request, origin),
  }
}
