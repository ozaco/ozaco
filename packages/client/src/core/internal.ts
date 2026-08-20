// oxlint-disable import/exports-last
import { CodecErrors } from 'std:codec'
import { attempt, operation } from 'std:effect'
import type { Future, Operation, Scope, Task } from 'std:effect'
import { Fetch } from 'std:fetch'
import { fail, isFailure, isSuccess } from 'std:result'
import type { Result } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { ClientErrors } from './errors'
import type {
  CallAddress,
  ClientState,
  ManifestDoc,
  ManifestFunctionDoc,
  RequestFile,
} from './types'

/** Methods whose remaining args travel as a query string instead of a JSON body. */
const QUERY_METHODS = new Set(['GET', 'HEAD', 'DELETE'])

/** Where the docs plugin is mounted by default (`Docs.actions.mount()`). */
export const DEFAULT_DOCS_PATH = '/docs'

let watchCounter = 0

/** Generate a unique watch id (unique per process — the server scopes ids per socket anyway). */
export const nextWatchId = (): string => {
  watchCounter += 1

  return `w_${watchCounter.toString(36)}_${Date.now().toString(36)}`
}

/**
 * Bridge a Task/Future into plain async land as a VALUE promise. The std contract resolves a
 * Result and never rejects (halts arrive as `fail('halted')`) — this unwraps it: resolve the
 * value, throw the Failure object.
 */
export const taskValue = async <T>(task: Task<T> | Future<T>): Promise<T> => {
  const outcome = (await task) as Result<T>

  if (isFailure(outcome)) {
    throw outcome
  }

  return outcome.value
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Very loose manifest shape check — enough to trust addressing, not a schema validation. */
export const looksLikeManifest = (value: unknown): value is ManifestDoc =>
  isRecord(value) && value['ozaco'] === '1.0' && isRecord(value['services'])

export const resolveToken = (state: ClientState): string | undefined => {
  const token = state.options.token

  return typeof token === 'function' ? token() : token
}

const trimSlash = (base: string): string => (base.endsWith('/') ? base.slice(0, -1) : base)

export const joinUrl = (base: string, path: string): string =>
  `${trimSlash(base)}${path.startsWith('/') ? path : `/${path}`}`

/** `http(s)://…` → `ws(s)://…` for the realtime socket. */
export const toWsUrl = (base: string): string => {
  if (base.startsWith('https://')) {
    return `wss://${base.slice(8)}`
  }

  if (base.startsWith('http://')) {
    return `ws://${base.slice(7)}`
  }

  return base
}

/** Scalars go verbatim, objects/arrays as JSON (the wizard `filter` query param contract). */
const queryValue = operation(function* (value: unknown) {
  return typeof value === 'object' && value !== null
    ? yield* JsonCodec.actions.stringify(value)
    : String(value)
})

export const buildQuery = operation(function* (params: Record<string, unknown>) {
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.append(key, yield* queryValue(value))
    }
  }

  return search.toString()
})

/**
 * Resolve the manifest once: an explicit `options.manifest` wins (an invalid one fails
 * `client.manifest` — passing a document is a claim, not a hint); otherwise
 * `GET <url>/docs/manifest` is tried and ANY failure (no docs mounted, invalid body) settles the
 * state to `null`, activating the default `POST /<resource>/<fn>` addressing.
 */
export const resolveManifest = operation(function* (state: ClientState) {
  if (state.manifest !== undefined) {
    return state.manifest
  }

  const provided = state.options.manifest

  if (provided !== undefined) {
    if (!looksLikeManifest(provided)) {
      return yield* fail(ClientErrors.Manifest, 'options.manifest is not an OZACO MANIFEST v1')
    }

    state.manifest = provided

    return state.manifest
  }

  const docsPath = state.options.docsPath ?? DEFAULT_DOCS_PATH
  const fetched = yield* attempt(function* () {
    const response = yield* Fetch.actions.get(joinUrl(state.options.url, `${docsPath}/manifest`))

    if (!response.ok) {
      return null
    }

    return yield* response.json()
  })

  const document = isSuccess(fetched) ? fetched.value : null

  state.manifest = looksLikeManifest(document) ? document : null

  return state.manifest
})

const joinPrefix = (prefix: string, path: string): string => {
  const cleanPrefix = prefix === '/' ? '' : trimSlash(prefix)

  return `${cleanPrefix}${path.startsWith('/') ? path : `/${path}`}`
}

const functionDoc = (
  state: ClientState,
  address: { readonly resource: string; readonly fn: string },
): ManifestFunctionDoc | undefined =>
  state.manifest?.services[address.resource]?.functions[address.fn]

/** Manifest route first; a known service falls back to `POST <prefix>/<fn>`; else the default. */
export const addressOf = (
  state: ClientState,
  address: { readonly resource: string; readonly fn: string },
): CallAddress => {
  const doc = functionDoc(state, address)

  if (doc?.route) {
    return { method: doc.route.method.toUpperCase(), path: doc.route.path }
  }

  const service = state.manifest?.services[address.resource]

  if (service) {
    return { method: 'POST', path: joinPrefix(service.prefix, `/${address.fn}`) }
  }

  return { method: 'POST', path: `/${address.resource}/${address.fn}` }
}

/** Manifest realtime path first, then `<prefix>/_realtime`, then `/<resource>/_realtime`. */
export const realtimePathOf = (state: ClientState, resource: string): string => {
  const service = state.manifest?.services[resource]

  if (service?.realtime) {
    return service.realtime.path
  }

  if (service) {
    return joinPrefix(service.prefix, '/_realtime')
  }

  return `/${resource}/_realtime`
}

const isQueryMethod = (method: string): boolean => QUERY_METHODS.has(method)

/** A multipart field value: strings verbatim, everything else as JSON. */
const fieldValue = operation(function* (value: unknown) {
  return typeof value === 'string' ? value : yield* JsonCodec.actions.stringify(value)
})

export interface PrepareInput {
  readonly args: unknown
  /** Any attachment forces `multipart/form-data`. */
  readonly files?: readonly RequestFile[] | undefined
  /** Merged OVER the session headers and the bearer token. */
  readonly headers?: Record<string, string> | undefined
}

/**
 * Fill `:name` path params from args (consumed), then frame the rest: attachments force multipart
 * (fields FIRST, files after — the edge folds leading fields into the action params), GET/HEAD/
 * DELETE take a query string, everything else a JSON body.
 */
export const prepareRequest = operation(function* (
  state: ClientState,
  address: CallAddress,
  input: PrepareInput,
) {
  const { args, files = [] } = input
  const source: Record<string, unknown> = isRecord(args) ? args : {}
  const consumed = new Set<string>()

  const path = address.path
    .split('/')
    .map(segment => {
      if (!segment.startsWith(':')) {
        return segment
      }

      const name = segment.slice(1)
      const value = source[name]

      consumed.add(name)

      if (value === undefined) {
        throw fail(ClientErrors.Request, `missing path param "${name}" for ${address.path}`)
      }

      return encodeURIComponent(String(value))
    })
    .join('/')

  const payload = Object.fromEntries(Object.entries(source).filter(([key]) => !consumed.has(key)))

  const headers: Record<string, string> = { ...state.options.headers }
  const token = resolveToken(state)

  if (token !== undefined && token !== '') {
    headers['authorization'] = `Bearer ${token}`
  }

  Object.assign(headers, input.headers)

  let url = joinUrl(state.options.url, path)

  if (files.length > 0) {
    // fields FIRST — the edge treats every field before the first file as an action param, and
    // the browser sets the multipart content-type (with its boundary) itself
    const form = new FormData()

    for (const [key, value] of Object.entries(payload)) {
      form.append(key, yield* fieldValue(value))
    }

    for (const attachment of files) {
      const filename = attachment.filename ?? (attachment.file as File).name

      form.append(attachment.field, attachment.file, filename)
    }

    Reflect.deleteProperty(headers, 'content-type')

    return { url, method: address.method, headers, body: form, bodyKind: 'multipart' } as const
  }

  if (isQueryMethod(address.method)) {
    const query = yield* buildQuery(payload)

    if (query !== '') {
      url = `${url}?${query}`
    }

    return { url, method: address.method, headers, body: undefined, bodyKind: 'none' } as const
  }

  if (args === undefined) {
    return { url, method: address.method, headers, body: undefined, bodyKind: 'none' } as const
  }

  headers['content-type'] = 'application/json'

  const body = yield* JsonCodec.actions.stringify(isRecord(args) ? payload : args)

  return { url, method: address.method, headers, body, bodyKind: 'json' } as const
})

/**
 * Map a non-2xx response to a raised Failure: the server's `{ error, message, requestId }` body
 * keeps its ORIGINAL tag, with `requestId:`/`status:` breadcrumbs appended; unparseable bodies
 * fall back to `client.request`.
 */
export const failFromResponse = operation(function* (input: {
  readonly status: number
  readonly text: () => Operation<string>
}) {
  const read = yield* attempt(input.text)
  const raw = isSuccess(read) ? read.value : ''
  const parsed = yield* attempt(() => JsonCodec.actions.parse<unknown>(raw))

  if (isFailure(parsed) && parsed.error !== CodecErrors.Parse) {
    // only a genuinely unparseable body falls back — a missing JsonCodec install must surface
    // as itself instead of masquerading as a plain `client.request`
    return yield* parsed
  }

  const body = isSuccess(parsed) && isRecord(parsed.value) ? parsed.value : {}

  const tag = typeof body['error'] === 'string' ? body['error'] : ClientErrors.Request
  const message =
    typeof body['message'] === 'string' ? body['message'] : `request failed (${input.status})`
  const causes = [`status:${input.status}`]

  if (typeof body['requestId'] === 'string') {
    causes.unshift(`requestId:${body['requestId']}`)
  }

  return yield* fail(tag, message, ...causes)
})

/**
 * Run an operation as a DETACHED task on `scope` (its failure settles the future only, never the
 * scope) and unwrap into a plain promise: resolve the value, reject with the Failure. The async
 * bridge every `connectClient` facade method uses.
 */
export const runOnScope = <T>(scope: Scope, op: () => Operation<T>): Promise<T> =>
  taskValue(scope.run(op, { detached: true }))
