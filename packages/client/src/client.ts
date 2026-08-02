import type { Future, Operation, Scope } from 'std:effect'
import { attempt, createScope, operation, sleep } from 'std:effect'
import { fetch } from 'std:fetch'
import type { FetchDef } from 'std:fetch'
import { install } from 'std:plugin'
import { fail, isSuccess } from 'std:result'
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

/**
 * Make sure a codec is in scope before anything touches the wire.
 *
 * The client speaks JSON to a wizard backend, and `std:ws` cannot frame a message at all without a
 * registered codec. A standalone consumer (a browser bundle, a one-file script) has no runtime that
 * installed one, so every write used to fail with `No handler for "stringify" in "std/codec"` — a
 * failure about a plugin the caller never asked for. Install the JSON codec only when it is
 * missing; an existing installation (the server, a runtime that already did it) is left alone.
 */
const ensureCodec = operation(function* () {
  if ((yield* JsonCodec.context.get()) === undefined) {
    yield* install(JsonCodec)
  }
})

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

/**
 * Fill `{param}` path segments from the args; consumed params leave the remainder for query/body.
 *
 * A missing param FAILS here instead of shipping a request that cannot mean what the caller meant:
 * `/notes/{id}` with no `id` either travels as a literal `/notes/{id}` (a guaranteed 404 blamed on
 * the server) or, once the braces are encoded away, as `/notes/` — which the gateway matches as the
 * COLLECTION route, so `get` answers with a whole list page and the caller never learns why.
 */
const fillPath = operation(function* (template: string, args: unknown, where: string) {
  if (!template.includes('{')) {
    return { path: template, rest: args }
  }
  const record = isRecord(args) ? args : {}
  const consumed = new Set<string>()
  const missing: string[] = []
  const path = template.replaceAll(/\{([^}]+)\}/gu, (whole, name: string) => {
    const value = record[name]
    if (value === undefined || value === null || value === '') {
      missing.push(name)
      return whole
    }
    consumed.add(name)
    return encodeURIComponent(String(value))
  })
  if (missing.length > 0) {
    return yield* fail(
      'missing-path-param',
      `${where}: ${missing.join(', ')} required by ${template}`,
    )
  }
  const rest = Object.fromEntries(Object.entries(record).filter(([key]) => !consumed.has(key)))
  return { path, rest }
})

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
  yield* ensureCodec()
  const { path, rest } = yield* fillPath(template, args, `${namespace}.${fn}`)

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

/** Per-client shared state: the options, the per-namespace transport cache, and the scope every live
 * subscription runs on (see {@link createClient}). */
interface ClientCtx {
  readonly options: ClientOptions
  readonly cache: Map<string, Transport>
  readonly scope: Scope
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
const sseStreamUrlFor = operation(function* (spec: WatchSpec, template: string) {
  const { path, rest } = yield* fillPath(template, spec.args, `${spec.namespace}.${spec.fn}`)
  const params = new URLSearchParams({ args: JSON.stringify(rest ?? {}) })
  const token = bearerOf(spec.options)
  if (token) {
    params.set('token', token)
  }
  return `${spec.options.realtimeUrl ?? spec.options.url}${path}?${params.toString()}`
})

interface WatchSpec {
  readonly options: ClientOptions
  readonly namespace: string
  readonly fn: string
  readonly args: unknown
  readonly onNext: (result: AnyType) => void
  readonly onError: ((error: unknown) => void) | undefined
  readonly cache: Map<string, Transport>
}

// ── reconnection ────────────────────────────────────────────────────────────────
// A live channel that dies on the first blip is worse than one that never opened: the page keeps
// showing stale rows and nothing tells anyone. So every attempt below re-opens on a bounded budget —
// 1s → 2s → 4s … capped at 30s, given up after RETRY_LIMIT consecutive failures — and the budget
// resets only once a connection actually delivered a PAYLOAD frame.
//
// "Any bytes arrived" is deliberately NOT the reset condition: every SSE response opens with a
// `: ok` comment (the gateway flushes headers past proxies before the first value), so a backend
// that accepts and immediately closes would reset the budget on every cycle and be hammered once a
// second, forever, without a single error reaching `onError`. A healthy wizard channel answers a
// `watch` with a `sync` frame straight away, so it still earns its reset on the first connection.
const RETRY_BASE_MS = 1000
const RETRY_CAP_MS = 30_000
const RETRY_LIMIT = 6

/** How one connection ended. `retriable: false` marks a refusal that the next attempt would only
 * repeat (a 4xx, a rejected `watch`), so the loop reports it instead of looping against a wall. */
interface Attempt {
  readonly delivered: boolean
  readonly retriable: boolean
  readonly error?: unknown
}

const ok = (delivered: boolean): Attempt => ({ delivered, retriable: true })

/** Drain ONE SSE connection to its end. A `_realtime` channel wraps every frame as `{ id?, result }`;
 * a dedicated stream route emits the raw value — `raw` picks the unwrapping. Decoder and frame
 * buffer are per-connection: a half-decoded UTF-8 sequence or a partial frame from a dropped stream
 * must never be spliced onto the next one. */
const sseAttempt = operation(function* (spec: WatchSpec, url: string, raw: boolean) {
  const response = yield* fetch(url, { headers: { accept: 'text/event-stream' } })
  if (!response.ok) {
    const status = response.status
    return {
      delivered: false,
      retriable: status === 408 || status === 429 || status >= 500,
      error: fail('sse-status', `${url} -> ${status} ${response.statusText}`),
    } satisfies Attempt
  }
  const subscription = yield* yield* response.raw()
  const decoder = new TextDecoder()
  let buffer = ''
  let delivered = false
  for (;;) {
    const step = yield* subscription.next()
    if (step.done) {
      // the server ENDED the stream — indistinguishable from a proxy timing the connection out, so
      // it re-opens on the same budget instead of dying silently
      return ok(delivered)
    }
    buffer += decoder.decode(step.value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find(entry => entry.startsWith('data:'))
      if (!line) {
        continue
      }
      const decoded = yield* attempt(JsonCodec.actions.parse(line.slice('data:'.length).trim()))
      if (isSuccess(decoded)) {
        delivered = true
        spec.onNext(raw ? decoded.value : (decoded.value as AnyType).result)
      }
    }
  }
})

/** Drive ONE WebSocket watch: open, send the `watch` frame, forward every frame carrying our
 * subscription id until the socket closes. A `{ id, error }` frame is the server refusing the watch
 * (access, bad args) — a refusal a reconnect can only repeat. */
const wsAttempt = operation(function* (spec: WatchSpec, url: string) {
  const conn = yield* connect(url)
  // the handshake succeeded, so this namespace IS a WebSocket one — remember it before draining, or
  // a mid-stream drop would look like "WS unsupported" to the probe below
  spec.cache.set(spec.namespace, 'ws')
  const id = `${spec.namespace}.${spec.fn}:${Date.now()}:${Math.round(Math.random() * 1e9)}`
  let delivered = false
  let refused: AnyType

  yield* conn.send({ event: 'watch', id, fn: spec.fn, args: spec.args ?? {} })

  const subscription = yield* conn.messages
  for (;;) {
    const step = yield* subscription.next()
    if (step.done) {
      break
    }
    const message = step.value as AnyType
    if (message?.id !== id) {
      continue
    }
    if (message.error === undefined) {
      delivered = true
      spec.onNext(message.result)
    } else {
      refused = message.error
      break
    }
  }

  if (refused === undefined) {
    return ok(delivered)
  }
  yield* attempt(() => conn.close())
  return {
    delivered,
    retriable: false,
    error: fail('watch-refused', `${spec.namespace}.${spec.fn}: ${String(refused)}`),
  } satisfies Attempt
})

/** The transport declared for a namespace in `options.meta` (from codegen's `apiMeta`), if any. */
const declaredTransport = (spec: WatchSpec): Transport | undefined => {
  const declared = spec.options.meta?.[spec.namespace]?.realtime
  return declared === 'sse' ? 'sse' : declared === 'websocket' ? 'ws' : undefined
}

/** One connection over the namespace's transport — from `meta` (preferred) or the cache. Only when
 * neither is known do we probe: WS first, SSE when the handshake itself fails. */
const openOnce = operation(function* (spec: WatchSpec) {
  const known = spec.cache.get(spec.namespace) ?? declaredTransport(spec)
  if (known === 'sse') {
    spec.cache.set(spec.namespace, 'sse')
    return yield* sseAttempt(spec, sseUrlFor(spec), false)
  }
  if (known === 'ws') {
    return yield* wsAttempt(spec, wsUrlFor(spec.options, spec.namespace))
  }
  const probed = yield* attempt(() => wsAttempt(spec, wsUrlFor(spec.options, spec.namespace)))
  if (isSuccess(probed)) {
    return probed.value
  }
  if (spec.cache.get(spec.namespace) === 'ws') {
    // it IS a WS namespace (the handshake had succeeded once) — this attempt just failed
    return { delivered: false, retriable: true, error: probed } satisfies Attempt
  }
  spec.cache.set(spec.namespace, 'sse')
  return yield* sseAttempt(spec, sseUrlFor(spec), false)
})

/** Keep one subscription alive: open, drain, re-open on the budget above, and report through
 * `onError` only when the channel is genuinely finished (refused, or out of budget). */
const watchLoop = (spec: WatchSpec, open: () => Operation<Attempt>) =>
  operation(function* () {
    yield* ensureCodec()
    let tries = 0
    for (;;) {
      const outcome = yield* attempt(open)
      let failure: unknown
      if (isSuccess(outcome)) {
        if (outcome.value.delivered) {
          tries = 0
        }
        if (!outcome.value.retriable) {
          spec.onError?.(outcome.value.error)
          return
        }
        failure = outcome.value.error
      } else {
        // a network error, a refused handshake, a codec fault — all worth one more attempt
        failure = outcome
      }
      tries += 1
      if (tries > RETRY_LIMIT) {
        spec.onError?.(
          failure ?? fail('watch-closed', `${spec.namespace}.${spec.fn} stopped streaming`),
        )
        return
      }
      yield* sleep(Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (tries - 1)))
    }
  })

/**
 * Start a live subscription and hand back its stopper.
 *
 * The pump runs on the CLIENT's scope, not the caller's. That is what lets a promise-land consumer
 * (`const stop = await client.notes.list.watch(...)`) keep receiving frames at all: awaiting a
 * `Future` runs it in a throwaway task whose scope is destroyed the moment the operation returns,
 * which would halt a pump spawned into it before the first frame ever arrived. The returned stopper
 * halts the pump; it is the only teardown, so a caller that drops it keeps the channel open.
 */
const watch = operation(function* (ctx: ClientCtx, spec: WatchSpec) {
  // a dedicated `stream()` route bypasses `_realtime` entirely — one fn, one direct SSE feed
  const declared = spec.options.meta?.[spec.namespace]?.fns?.[spec.fn]
  const open =
    declared?.[0] === 'SSE'
      ? operation(function* () {
          return yield* sseAttempt(spec, yield* sseStreamUrlFor(spec, declared[1]), true)
        })
      : () => openOnce(spec)

  const task = ctx.scope.run(() => watchLoop(spec, open)())
  return (): Operation<void> => task.halt()
})

const makeFn = (ctx: ClientCtx, namespace: string, fn: string): AnyType => {
  const { options, cache } = ctx
  const invoke = (args: unknown): Future<AnyType> => call({ options, namespace, fn, args })
  invoke.watch = (
    args: unknown,
    onNext: AnyType,
    onError?: AnyType,
  ): Future<() => Operation<void>> =>
    watch(ctx, { options, namespace, fn, args, onNext, onError, cache })
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
 * cached, so the caller never picks one. A dropped channel re-opens itself on a bounded backoff; the
 * stopper each subscription returns is what ends it. The `<Api>` type comes from
 * `@ozaco/client/codegen` (`ozaco pull`).
 *
 * Every subscription runs on a scope this client owns (a child of the global scope), so a live feed
 * outlives the call that started it — including an `await`ed one. The client itself holds no
 * connections: nothing to dispose beyond stopping the subscriptions you started.
 */
export const createClient = <TApi extends ApiShape>(options: ClientOptions): Client<TApi> => {
  const [scope] = createScope()
  const ctx: ClientCtx = { options, cache: new Map<string, Transport>(), scope }
  return new Proxy({} as AnyType, {
    get: (_target, namespace: string) => makeNamespace(ctx, namespace),
  }) as Client<TApi>
}
