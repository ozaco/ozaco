// oxlint-disable import/exports-last
import type { Flow, Operation } from 'std:effect'
import { attempt, ensure, until } from 'std:effect'
import { IO } from 'std:io'
import type { Result } from 'std:result'
import { appendCauses, asFailure, fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { DEFAULT_TIMEOUT_MS, HEADERS } from '../const'
import { ClientErrors } from '../errors'
import type { ClientDef } from '../types/client'
import type { Helpers } from '../types/helpers'
import { failureOf } from '../utils/failure'

import { decodeBody } from './decode'
import { heldReadable } from './future'
import {
  carrierOf,
  echoedContext,
  endCall,
  endDetached,
  endOfStream,
  fallbackOf,
  markResponse,
  openCall,
  recordedBy,
  traceIdOf,
  watchedFlow,
  withCarrier,
} from './trace'

/** A PLAIN object (streams, blobs, class instances are not). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

/** What a query string says back: strings the server would coerce are JSON-quoted to survive. */
const queryValue = (value: unknown): string => {
  if (typeof value === 'string') {
    const looksCoerced =
      value === 'true' ||
      value === 'false' ||
      value === 'null' ||
      /^-?\d+(\.\d+)?$/u.test(value) ||
      value.startsWith('{') ||
      value.startsWith('[') ||
      value.startsWith('"')

    return looksCoerced ? JSON.stringify(value) : value
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  return JSON.stringify(value)
}

/** Path params (`:id`) are read from the input and removed from what travels in body/query. */
const resolvePath = (
  path: string,
  input: unknown,
): { path: string; rest: unknown; failure: string | null } => {
  const record = isRecord(input) ? new Map(Object.entries(input)) : null
  let failure: string | null = null

  const resolved = path.replaceAll(/:([A-Za-z_][\w]*)/gu, (_match, name: string) => {
    const value = record?.get(name)

    if (value === undefined) {
      failure = `path param "${name}" is missing from the input`

      return ''
    }

    record!.delete(name)

    return encodeURIComponent(String(value))
  })

  return { path: resolved, rest: record ? Object.fromEntries(record) : input, failure }
}

/**
 * A rejected platform fetch as the client's answer: a transport fault IS the `client.network`
 * failure (`ClientErrors` classifies it — the platform code or message its message, the platform
 * error its `raw`; `operation` names the fetch in its causes, after `until`'s own); anything else
 * the fetch rejected with (a custom `fetch`'s own failure, e.g. `std:fetch.network`) is nested
 * under a `client.network` naming the operation. Never `until`'s `std:result.unknown` fold.
 */
export const networkFailure = (error: unknown, operation: string): Result.Failure<unknown> => {
  const fault = asFailure(error, ClientErrors)

  return fault.error === ClientErrors.Network
    ? appendCauses(fault, operation)
    : fail(ClientErrors.Network, operation, fault)
}

/** The `authorization` header value of this client's token, if any (a value or a resolver). */
export const authorization = (options: ClientDef.Options): string | undefined => {
  const token = typeof options.token === 'function' ? options.token() : options.token

  return token ? `Bearer ${token}` : undefined
}

/** A branded stream or a plain ReadableStream is sent as the body. */
const isReadable = (value: unknown): value is ReadableStream =>
  typeof ReadableStream !== 'undefined' && value instanceof ReadableStream

/** A stream input as a fetch body: streams as-is, blobs/bytes/strings buffered. */
const toBody = (value: unknown): BodyInit | null => {
  if (isReadable(value) || value instanceof Blob || typeof value === 'string') {
    return value
  }

  if (value instanceof Uint8Array) {
    return new Blob([value as BlobPart])
  }

  return null
}

const isParts = (
  value: unknown,
): value is { fields?: unknown; streams?: Record<string, unknown> } =>
  isRecord(value) && 'streams' in value && isRecord(value.streams)

/** Multipart: the fields first (so the server resolves them before the first file), then files. */
const formOf = (parts: { fields?: unknown; streams?: Record<string, unknown> }): FormData => {
  const form = new FormData()

  if (isRecord(parts.fields)) {
    for (const [key, value] of Object.entries(parts.fields)) {
      form.append(key, typeof value === 'string' ? value : JSON.stringify(value))
    }
  }

  for (const [name, value] of Object.entries(parts.streams ?? {})) {
    if (value instanceof Blob) {
      form.append(name, value, name)
    } else if (value instanceof Uint8Array || typeof value === 'string') {
      form.append(name, new Blob([value as AnyType]), name)
    } else if (isReadable(value)) {
      // FormData cannot carry a stream: buffer it (a true streamed upload goes through `stream`)
      form.append(name, value as AnyType, name)
    }
  }

  return form
}

function* prepare(
  { ctx, action, input, options }: Helpers.CallInput,
  requestId: string,
): Operation<Helpers.Prepared> {
  const { path, rest, failure } = resolvePath(action.route.path, input)

  if (failure) {
    return yield* fail(ClientErrors.Configuration, failure)
  }

  const url = new URL(path, ctx.options.url)
  const method = action.route.method.toUpperCase()

  const headers: Record<string, string> = {
    accept: '*/*',
    ...ctx.options.headers,
    ...options?.headers,
    [HEADERS.requestId]: requestId,
  }
  const bearer = authorization(ctx.options)

  if (bearer && !headers.authorization) {
    headers.authorization = bearer
  }

  let body: BodyInit | null = null
  let duplex: 'half' | undefined

  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
    if (isRecord(rest)) {
      for (const [key, value] of Object.entries(rest)) {
        if (value === undefined) {
          continue
        }

        if (Array.isArray(value)) {
          for (const item of value) {
            url.searchParams.append(key, queryValue(item))
          }
        } else {
          url.searchParams.append(key, queryValue(value))
        }
      }
    }
  } else if (action.input.plane === 'stream' || isReadable(rest)) {
    const sendable = toBody(rest)

    if (sendable === null) {
      return yield* fail(ClientErrors.Configuration, `${action.id} expects a stream body`)
    }

    headers['content-type'] = action.input.contentType ?? 'application/octet-stream'
    body = sendable

    if (isReadable(sendable)) {
      duplex = 'half'
    }
  } else if (action.input.plane === 'parts' || isParts(rest)) {
    if (!isParts(rest)) {
      return yield* fail(ClientErrors.Configuration, `${action.id} expects { fields, streams }`)
    }

    body = formOf(rest)
  } else if (rest !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(rest)
  }

  const init: RequestInit = { method, headers, body }

  if (duplex) {
    ;(init as AnyType).duplex = duplex
  }

  return { url: url.toString(), init }
}

/** A streamed reply's brand: its values come as a Flow (`decodeBody`). */
const isFlowBrand = (brand: string | null): boolean => brand === 'ndjson' || brand === 'sse'

/**
 * The exchange itself: deadline + scope cancellation, the reply's ids (`x-request-id`,
 * `traceresponse` → `$lastTraceId`), decoded by brand, failures rebuilt from the wire. `traced`
 * is the call's CLIENT span (or `null`): it gets the response status, and a failure the server
 * recorded in the call's trace is marked recorded there (the caller's spans then only carry its
 * status).
 */
function* exchange(
  call: Helpers.CallInput,
  target: Helpers.Prepared & { readonly requestId: string },
  traced: Helpers.CallSpan | null,
): Operation<{ readonly value: unknown; readonly meta: ClientDef.Meta }> {
  const { ctx, action, options } = call
  const { url, init, requestId } = target
  const controller = new AbortController()
  const timeoutMs = options?.timeoutMs ?? ctx.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(ClientErrors.Timeout), timeoutMs)
  let settled = false

  yield* ensure(() => {
    clearTimeout(timer)

    if (!settled) {
      controller.abort(ClientErrors.Closed)
    }
  })

  const doFetch = ctx.options.fetch ?? fetch
  let response: Response

  try {
    response = yield* until(doFetch(url, { ...init, signal: controller.signal }))
  } catch (error) {
    settled = true
    clearTimeout(timer)

    if (controller.signal.aborted && controller.signal.reason === ClientErrors.Timeout) {
      return yield* fail(ClientErrors.Timeout, `${action.id} exceeded ${timeoutMs}ms`)
    }

    return yield* networkFailure(error, action.id)
  }

  const echoed = response.headers.get(HEADERS.requestId) ?? requestId
  const trace = yield* echoedContext(response)

  if (traced) {
    yield* markResponse(traced, response)
  }

  ctx.lastRequestId = echoed
  ctx.lastTraceId = traceIdOf(traced, trace)

  const meta: ClientDef.Meta = {
    requestId: echoed,
    status: response.status,
    brand: response.headers.get(HEADERS.brand),
    traceId: ctx.lastTraceId,
  }

  // a failure is what the server SAYS is one: the `oz-error` header rides every failure reply,
  // including those an action maps to a 2xx (`errors: { 'rpc.invalid-params': 200 }`)
  if (response.status >= 400 || response.headers.get(HEADERS.error) !== null) {
    settled = true
    clearTimeout(timer)

    return yield* failureOf(response, echoed, {
      remote: {
        service: action.service,
        operation: action.id,
        recordedIn: recordedBy(traced, trace),
      },
    })
  }

  const value = yield* decodeBody(response)

  // a streamed body lives past this call: the deadline no longer applies, the scope still cancels
  settled = true
  clearTimeout(timer)

  if (
    isReadable(value) ||
    (typeof value === 'object' && value !== null && Symbol.iterator in value)
  ) {
    settled = false
  }

  return { value, meta }
}

/**
 * One HTTP call: prepared by the manifest's route, then exchanged. When tracing is enabled where
 * the call runs it is ONE CLIENT span `{METHOD} {route}` (scope `@ozaco/client`) whose context
 * rides the request (`traceparent` + `tracestate` `ozaco=1`); it ends once the reply is decoded,
 * or — for a streamed reply — with the stream (its end, its failure, or cancelled when abandoned);
 * a reply never consumed ends it, when the calling scope closes, at the time its headers arrived.
 * Tracing off: no span, the caller's ambient context (a pass-through one) is carried as it is.
 */
export function* request(
  call: Helpers.CallInput,
): Operation<{ readonly value: unknown; readonly meta: ClientDef.Meta }> {
  const { options, action } = call
  const requestId = options?.requestId ?? (yield* IO.actions.uuid())
  const prepared = yield* prepare(call, requestId)
  const traced = yield* openCall(
    prepared.init.method ?? action.route.method,
    action.route.path,
    new URL(prepared.url),
  )
  const headers = withCarrier(
    prepared.init.headers as Record<string, string>,
    yield* carrierOf(traced),
  )
  const target = { ...prepared, init: { ...prepared.init, headers }, requestId }

  if (!traced) {
    return yield* exchange(call, target, null)
  }

  yield* ensure(fallbackOf(traced))

  let ended = false

  try {
    const outcome = yield* attempt(() => exchange(call, target, traced))

    ended = true

    if (isFailure(outcome)) {
      yield* endCall(traced, { failure: outcome })

      return yield* outcome
    }

    const { value, meta } = outcome.value

    if (isFlowBrand(meta.brand) && typeof value === 'object' && value !== null) {
      return { value: watchedFlow(traced, value as Flow<unknown, void>), meta }
    }

    if (isReadable(value)) {
      const stream = heldReadable(value as ReadableStream<Uint8Array>, {
        start: () => {
          traced.consuming = true
        },
        settle: settled => endDetached(traced, endOfStream(settled)),
      })

      return { value: stream, meta }
    }

    yield* endCall(traced)

    return outcome.value
  } finally {
    if (!ended) {
      yield* endCall(traced, { cancelled: true })
    }
  }
}
