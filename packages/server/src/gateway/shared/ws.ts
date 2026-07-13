import type { ActionRequest, ActionResponse } from 'server:core'
import { Gateway } from 'server:core'
import { attempt, operation } from 'std:effect'
import { isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import { JSON_CONTENT } from './const'

// the `ws` action is the per-route WebSocket settings constructor (was Ws.actions.settings)
export const wsSettingsAction = operation(function* (options: AnyType) {
  return {
    ...options,
    path: options.path ?? '/',
    method: 'WS',

    transformer: Gateway,
  }
})

export const parseWsPayload = operation(function* (payload: unknown) {
  if (payload === null || payload === undefined) {
    return null
  }
  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // a non-JSON payload that merely starts with `{`/`[` degrades to the raw string (matches the
      // previous try/catch), so `attempt` swallows the decode failure instead of propagating it
      const parsed = yield* attempt(JsonCodec.actions.parse(payload))
      return isSuccess(parsed) ? parsed.value : payload
    }
    return payload
  }
  return payload
})

export const encodeWsBody = operation(function* (body: unknown) {
  if (body === undefined || body === null) {
    return null
  }
  if (typeof body === 'string') {
    return body
  }
  if (body instanceof ArrayBuffer) {
    return body
  }
  if (ArrayBuffer.isView(body)) {
    return body
  }
  return yield* JsonCodec.actions.stringify(body)
})

/**
 * Extract a bearer token from a WS connection — from the `authorization` header (captured at upgrade)
 * OR a `?token=` / `?access_token=` query param. Browsers cannot set custom headers on the WS
 * handshake, so the query-param form is the browser-friendly convention. Use it in a `listen` handler
 * (e.g. `open`) to authenticate; per-message-RPC routes get it for free (see `buildRequest`).
 */
export const wsBearer = (data: {
  url?: string
  headers?: Record<string, string>
}): string | undefined => {
  const header = data.headers?.authorization
  if (header) {
    return header.startsWith('Bearer ') ? header.slice(7) : header
  }
  try {
    const url = new URL(data.url ?? 'ws://localhost/')
    return url.searchParams.get('token') ?? url.searchParams.get('access_token') ?? undefined
  } catch {
    return undefined
  }
}

export const buildRequest = operation(function* (ws: AnyType, payload: unknown) {
  const data = (ws?.data ?? {}) as {
    url?: string
    headers?: Record<string, string>
    params?: Record<string, unknown>
  }
  const url = new URL(data.url ?? 'ws://localhost/')

  // clone so we never mutate the shared ws.data.headers; promote a `?token=` query param into the
  // `authorization` meta when no header is present, so `useAuth` works for browser WS clients too.
  const headers = { ...data.headers }
  if (!headers.authorization) {
    const token = url.searchParams.get('token') ?? url.searchParams.get('access_token')
    if (token) {
      headers.authorization = `Bearer ${token}`
    }
  }

  const parsedBody = yield* parseWsPayload(payload)

  const body = {
    ...data.params,
    ...(parsedBody as Record<string, unknown> | null),
  }

  const req: ActionRequest = {
    type: 'ws',
    method: 'WS',
    url,
    meta: headers,
    files: {},
  }

  return [req, body] as [ActionRequest, unknown]
})

export const buildResponse = (): ActionResponse => ({
  status: null,
  body: undefined,
  files: {},
  meta: { 'content-type': JSON_CONTENT },
})

export const sendResult = operation(function* (
  ws: AnyType,
  res: ActionResponse | null,
  result: AnyType,
) {
  const sink = ws as { send?: (data: AnyType) => void } | null
  if (!sink?.send) {
    return
  }

  if (isFailure(result)) {
    if (result.error instanceof Error) {
      ;(result as AnyType).error = String(result.error)
    }
    sink.send(yield* JsonCodec.actions.stringify(result))
    return
  }

  const body = isSuccess(result) ? (result.value ?? res?.body) : res?.body
  const encoded = yield* encodeWsBody(body)
  if (encoded === null) {
    return
  }
  sink.send(encoded)
})
