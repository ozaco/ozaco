import type { Future, Operation } from 'std:effect'
import { attempt, each, operation, spawn } from 'std:effect'
import { fetch } from 'std:fetch'
import type { FetchDef } from 'std:fetch'
import { fail, isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'
import { connect } from 'std:ws'

import { JsonCodec } from 'std:codec/impl/json'

import type { ApiShape, Client, ClientOptions } from './types'
import { toFormData } from './utils/form-data'

const JSON_HEADERS = { 'content-type': 'application/json' }

/** Methods whose args ride the query string — the server reads no body on these. */
const QUERY_METHODS = new Set(['GET', 'HEAD', 'DELETE'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** The bearer token, resolved per call so a getter always reflects the current session. */
const bearerOf = (options: ClientOptions): string | undefined =>
  typeof options.token === 'function' ? options.token() : options.token

/** The fn's declared `[METHOD, path]` route (codegen's `apiMeta`), else the bare-action default —
 * the only route shape the server serves for a fn that declared no `rest` of its own. */
const routeFor = (
  options: ClientOptions,
  namespace: string,
  fn: string,
): readonly [string, string] =>
  options.meta?.[namespace]?.fns?.[fn] ?? ['POST', `/${namespace}/${fn}`]

/** Fill `{param}` path segments from the args; consumed params leave the remainder for query/body. */
const fillPath = (template: string, args: unknown): { path: string; rest: unknown } => {
  if (!template.includes('{') || !isRecord(args)) {
    return { path: template, rest: args }
  }
  const consumed = new Set<string>()
  const path = template.replaceAll(/\{([^}]+)\}/gu, (whole, name: string) => {
    if (!(name in args)) {
      return whole
    }
    consumed.add(name)
    return encodeURIComponent(String(args[name]))
  })
  const rest = Object.fromEntries(Object.entries(args).filter(([key]) => !consumed.has(key)))
  return { path, rest }
}

const toQuery = (rest: unknown): string => {
  if (!isRecord(rest)) {
    return ''
  }
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) {
      continue
    }
    params.set(key, isRecord(value) || Array.isArray(value) ? JSON.stringify(value) : String(value))
  }
  return params.toString()
}

interface CallSpec {
  readonly options: ClientOptions
  readonly namespace: string
  readonly fn: string
  readonly args: unknown
}

/** Dispatch one call over the fn's declared REST route — method + path params + query-or-body args —
 * through the effect-native `std:fetch` (never global fetch); the args are server-validated. */
const call = operation(function* (spec: CallSpec) {
  const { options, namespace, fn, args } = spec
  const [method, template] = routeFor(options, namespace, fn)
  if (method === 'SSE') {
    return yield* fail('stream-only', `${namespace}.${fn} is a stream — use .subscribe(...)`)
  }
  const { path, rest } = fillPath(template, args)

  const headers: Record<string, string> = {}
  const token = bearerOf(options)
  if (token) {
    headers.authorization = `Bearer ${token}`
  }

  let url = `${options.url}${path}`
  let init: FetchDef.Init
  if (QUERY_METHODS.has(method)) {
    const query = toQuery(rest)
    if (query) {
      url += `?${query}`
    }
    init = { method, headers }
  } else {
    const form = toFormData(rest)
    init = form
      ? { method, headers, body: form }
      : {
          method,
          headers: { ...headers, ...JSON_HEADERS },
          body: yield* JsonCodec.actions.stringify(rest ?? {}),
        }
  }

  const response = yield* fetch(url, init)
  const text = yield* response.text()
  let parsed: AnyType = null
  if (text) {
    const decoded = yield* attempt(JsonCodec.actions.parse(text))
    parsed = isSuccess(decoded) ? decoded.value : null
  }
  if (!response.ok) {
    return yield* fail(
      parsed?.error ?? 'request-failed',
      parsed?.message ?? `${method} ${url} -> ${response.status}`,
    )
  }
  return parsed
})

// realtime is per-resource: each namespace serves its own `/<ns>/_realtime`, over EITHER WebSocket
// or SSE — the resource decides (`realtime: 'websocket' | 'sse'`). The client learns the transport
// from codegen's `apiMeta` (the `x-ozaco-realtime` OpenAPI annotation), passed as `options.meta`, so
// there is no runtime detection. A namespace missing from `meta` falls back to a one-time cached
// WS-then-SSE probe (a non-WS route fails the handshake fast, so `connect` rejects → SSE). The caller
// never picks a transport.
type Transport = 'ws' | 'sse'

/** Per-client shared state: the options plus the per-namespace transport cache. */
interface ClientCtx {
  readonly options: ClientOptions
  readonly cache: Map<string, Transport>
}

const wsUrlFor = (options: ClientOptions, namespace: string): string => {
  const base = `${(options.realtimeUrl ?? options.url).replace(/^http/u, 'ws')}/${namespace}/_realtime`
  const token = bearerOf(options)
  // a browser cannot set WS handshake headers — the server promotes `?token=` into `authorization`
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

const sseUrlFor = (spec: WatchSpec): string => {
  const params = new URLSearchParams({ fn: spec.fn, args: JSON.stringify(spec.args ?? {}) })
  const token = bearerOf(spec.options)
  if (token) {
    // `EventSource`/fetch-SSE cannot set headers either — same promotion, scoped to `sse` routes
    params.set('token', token)
  }
  return `${spec.options.realtimeUrl ?? spec.options.url}/${spec.namespace}/_realtime?${params.toString()}`
}

/** A dedicated `stream()` SSE route (`['SSE', path]` in the manifest): path params ride the path,
 * the remaining args ride `?args=` — mirroring the server's `targetFromQuery`. */
const sseStreamUrlFor = (spec: WatchSpec, template: string): string => {
  const { path, rest } = fillPath(template, spec.args)
  const params = new URLSearchParams({ args: JSON.stringify(rest ?? {}) })
  const token = bearerOf(spec.options)
  if (token) {
    params.set('token', token)
  }
  return `${spec.options.realtimeUrl ?? spec.options.url}${path}?${params.toString()}`
}

interface WatchSpec {
  readonly options: ClientOptions
  readonly namespace: string
  readonly fn: string
  readonly args: unknown
  readonly onNext: (result: AnyType) => void
  readonly onError: ((error: unknown) => void) | undefined
  readonly cache: Map<string, Transport>
}

/** Watch over `std:ws`. Frames are codec-decoded lazily on pull inside the drain pump so the effect
 * scope (and its codec) is in play. The pump is `spawn`ed so pushes keep arriving after this resolves;
 * the returned stopper closes the socket. */
const watchOverWs = operation(function* (conn: AnyType, spec: WatchSpec) {
  const { namespace, fn, args, onNext, onError } = spec
  const id = `${namespace}.${fn}:${Date.now()}:${Math.round(Math.random() * 1e9)}`

  yield* spawn(function* () {
    for (const raw of yield* each(conn.messages)) {
      const message = raw as AnyType
      if (message?.id === id) {
        onNext(message.result)
      }
      yield* each.next()
    }
  })

  if (onError) {
    yield* spawn(function* () {
      const outcome = yield* attempt(conn.closed)
      if (isFailure(outcome)) {
        onError(outcome.error)
      }
    })
  }

  yield* conn.send({ event: 'watch', id, fn, args: args ?? {} })
  return (): Operation<void> => conn.close()
})

/** Watch over SSE via `std:fetch(...).raw()` — parse `data:` frames and forward each payload. A
 * `_realtime` channel wraps every frame as `{ id?, result }`; a dedicated stream route emits the
 * raw value — `raw` picks the unwrapping. The reader is `spawn`ed; the stopper halts it, which
 * aborts the in-flight request (scope-tied abort). */
const watchOverSse = operation(function* (spec: WatchSpec, url: string, raw: boolean) {
  const { onNext, onError } = spec
  const stream = yield* fetch(url).raw()

  const task = yield* spawn(function* () {
    const outcome = yield* attempt(function* () {
      const subscription = yield* stream
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const step = yield* subscription.next()
        if (step.done) {
          break
        }
        buffer += decoder.decode(step.value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.split('\n').find(entry => entry.startsWith('data:'))
          if (line) {
            const decoded = yield* attempt(
              JsonCodec.actions.parse(line.slice('data:'.length).trim()),
            )
            if (isSuccess(decoded)) {
              onNext(raw ? decoded.value : (decoded.value as AnyType).result)
            }
          }
        }
      }
    })
    if (isFailure(outcome) && onError) {
      onError(outcome.error)
    }
  })

  return (): Operation<void> => task.halt()
})

/** The transport declared for a namespace in `options.meta` (from codegen's `apiMeta`), if any. */
const declaredTransport = (spec: WatchSpec): Transport | undefined => {
  const declared = spec.options.meta?.[spec.namespace]?.realtime
  return declared === 'sse' ? 'sse' : declared === 'websocket' ? 'ws' : undefined
}

/** Resolve the namespace's realtime transport — from `meta` (preferred) or the cache — then open the
 * subscription. Only when neither is known do we probe (WS first, SSE on handshake failure). */
const watch = operation(function* (spec: WatchSpec) {
  // a dedicated `stream()` route bypasses `_realtime` entirely — one fn, one direct SSE feed
  const declared = spec.options.meta?.[spec.namespace]?.fns?.[spec.fn]
  if (declared?.[0] === 'SSE') {
    return yield* watchOverSse(spec, sseStreamUrlFor(spec, declared[1]), true)
  }
  const known = spec.cache.get(spec.namespace) ?? declaredTransport(spec)
  if (known === 'sse') {
    spec.cache.set(spec.namespace, 'sse')
    return yield* watchOverSse(spec, sseUrlFor(spec), false)
  }
  if (known === 'ws') {
    spec.cache.set(spec.namespace, 'ws')
    return yield* watchOverWs(yield* connect(wsUrlFor(spec.options, spec.namespace)), spec)
  }
  // No declaration and nothing cached → probe once and remember the result.
  const attempted = yield* attempt(connect(wsUrlFor(spec.options, spec.namespace)))
  if (isSuccess(attempted)) {
    spec.cache.set(spec.namespace, 'ws')
    return yield* watchOverWs(attempted.value, spec)
  }
  spec.cache.set(spec.namespace, 'sse')
  return yield* watchOverSse(spec, sseUrlFor(spec), false)
})

const makeFn = (ctx: ClientCtx, namespace: string, fn: string): AnyType => {
  const { options, cache } = ctx
  const invoke = (args: unknown): Future<AnyType> => call({ options, namespace, fn, args })
  invoke.watch = (
    args: unknown,
    onNext: AnyType,
    onError?: AnyType,
  ): Future<() => Operation<void>> =>
    watch({ options, namespace, fn, args, onNext, onError, cache })
  // `stream` functions expose `.subscribe(...)`; same channel + auto-detected transport as watch.
  invoke.subscribe = invoke.watch
  return invoke
}

const makeNamespace = (ctx: ClientCtx, namespace: string): AnyType =>
  new Proxy({} as AnyType, {
    get: (_target, fn: string) => makeFn(ctx, namespace, fn),
  })

/**
 * Build a concrete, typed client for a wizard backend. Each namespace exposes its functions as refs:
 * call a `query`/`mutation` with its args (an awaitable {@link Future}), and `.watch(...)` / `.subscribe(...)`
 * for live results — the realtime transport (WebSocket or SSE) is auto-detected per namespace and
 * cached, so the caller never picks one. The `<Api>` type comes from `@ozaco/client/codegen` (`ozaco pull`).
 */
export const createClient = <TApi extends ApiShape>(options: ClientOptions): Client<TApi> => {
  const ctx: ClientCtx = { options, cache: new Map<string, Transport>() }
  return new Proxy({} as AnyType, {
    get: (_target, namespace: string) => makeNamespace(ctx, namespace),
  }) as Client<TApi>
}
