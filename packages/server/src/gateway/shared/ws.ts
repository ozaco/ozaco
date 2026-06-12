import type { ActionRequest, ActionResponse } from 'server:core'
import { Gateway } from 'server:core'
import { operation } from 'std:effect'
import { isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

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
    return body
  }
  return JSON.stringify(body)
}

export const buildRequest = (ws: AnyType, payload: unknown): [ActionRequest, unknown] => {
  const data = (ws?.data ?? {}) as {
    url?: string
    headers?: Record<string, string>
    params?: Record<string, unknown>
  }
  const url = new URL(data.url ?? 'ws://localhost/')
  const headers = data.headers ?? {}
  const parsedBody = parseWsPayload(payload)

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

  return [req, body]
}

export const buildResponse = (): ActionResponse => ({
  status: null,
  body: undefined,
  files: {},
  meta: { 'content-type': JSON_CONTENT },
})

export const sendResult = (ws: AnyType, res: ActionResponse | null, result: AnyType): void => {
  const sink = ws as { send?: (data: AnyType) => void } | null
  if (!sink?.send) {
    return
  }

  if (isFailure(result)) {
    if (result.error instanceof Error) {
      ;(result as AnyType).error = String(result.error)
    }
    sink.send(JSON.stringify(result))
    return
  }

  const body = isSuccess(result) ? (result.value ?? res?.body) : res?.body
  const encoded = encodeWsBody(body)
  if (encoded === null) {
    return
  }
  sink.send(encoded)
}
