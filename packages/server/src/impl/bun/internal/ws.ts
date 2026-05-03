import type { ActionRequest, ActionResponse } from 'server:core'
import { operation } from 'std:effect'
import { isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { JSON_CONTENT } from '../const'

export const parseWsPayload = (payload: unknown): unknown => {
  if (payload === null || payload === undefined) {
    return null
  }
  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(payload)
      } catch {
        return payload
      }
    }
    return payload
  }
  return payload
}

export const encodeWsBody = (body: unknown): string | ArrayBufferView | ArrayBuffer | null => {
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
    return body as ArrayBufferView
  }
  return JSON.stringify(body)
}

// oxlint-disable-next-line require-yield
export const buildRequest = operation(function* (ws: AnyType, payload: unknown, from: string) {
  const data = (ws?.data ?? {}) as {
    url?: string
    headers?: Record<string, string>
    params?: Record<string, unknown>
  }
  const url = new URL(data.url ?? 'ws://localhost/')
  const headers = data.headers ?? {}
  const parsedBody = parseWsPayload(payload)

  const body = {
    // oxlint-disable-next-line oxc/no-rest-spread-properties, unicorn/no-useless-fallback-in-spread
    ...(data.params ?? {}),
    // oxlint-disable-next-line oxc/no-rest-spread-properties, unicorn/no-useless-fallback-in-spread
    ...((parsedBody as Record<string, unknown>) ?? {}),
  }

  const req: ActionRequest = {
    type: 'ws',
    from,
    method: 'WS',
    url,
    meta: headers,
    files: {},
    rawBody: null,
  }

  return [req, body] as [ActionRequest, unknown]
})

export const buildResponse = (): ActionResponse => ({
  status: null,
  body: undefined,
  files: {},
  meta: { 'content-type': JSON_CONTENT },
})

// oxlint-disable-next-line require-yield
export const sendResult = operation(function* (
  ws: AnyType,
  res: ActionResponse | null,
  result: AnyType,
) {
  const sink = ws as { send?: (data: AnyType) => void } | null
  if (!sink?.send) {
    return null
  }

  if (isFailure(result)) {
    if (result.error instanceof Error) {
      ;(result as AnyType).error = String(result.error)
    }
    const payload = JSON.stringify(result)
    sink.send(payload)
    return payload
  }

  const body = isSuccess(result) ? (result.value ?? res?.body) : res?.body
  const encoded = encodeWsBody(body)
  if (encoded === null) {
    return null
  }
  sink.send(encoded)
  return encoded
})
