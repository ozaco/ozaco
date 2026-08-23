// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { ensure, until } from 'std:effect'
import { IO } from 'std:io'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DEFAULT_TIMEOUT_MS, HEADERS } from '../const'
import { ClientErrors } from '../errors'
import type { ClientDef } from '../types/client'
import type { ManifestDef } from '../types/manifest'

import { decodeBody, failureOf } from './decode'

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

const authorization = (options: ClientDef.Options): string | undefined => {
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

interface Prepared {
  readonly url: string
  readonly init: RequestInit
}

/** One call's ingredients. */
export interface CallInput {
  readonly ctx: ClientDef.Context
  readonly action: ManifestDef.Action
  readonly input: unknown
  readonly options?: ClientDef.CallOptions | undefined
}

function* prepare(
  { ctx, action, input, options }: CallInput,
  requestId: string,
): Operation<Prepared> {
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

/** One HTTP call: prepared by the manifest's route, deadline + scope cancellation, decoded by
 * brand, failures rebuilt from the wire. */
export function* request(
  call: CallInput,
): Operation<{ readonly value: unknown; readonly meta: ClientDef.Meta }> {
  const { ctx, action, options } = call
  const requestId = options?.requestId ?? (yield* IO.actions.uuid())
  const { url, init } = yield* prepare(call, requestId)
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

    return yield* fail(ClientErrors.Network, `${action.id}: ${String(error)}`)
  }
  const echoed = response.headers.get(HEADERS.requestId) ?? requestId
  ctx.lastRequestId = echoed

  const meta: ClientDef.Meta = {
    requestId: echoed,
    status: response.status,
    brand: response.headers.get(HEADERS.brand),
  }

  if (response.status >= 400) {
    settled = true
    clearTimeout(timer)

    return yield* failureOf(response, echoed)
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
