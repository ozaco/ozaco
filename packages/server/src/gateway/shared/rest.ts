import type { ActionFile, ActionRequest, ActionResponse, GatewayDef } from 'server:core'
import { CoreErrors, Gateway, statusFor } from 'server:core'
import { Codec } from 'std:codec'
import { operation, until, useContext } from 'std:effect'
import { fail, isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import { BODY_METHODS, FORM_DATA, FORM_URLENCODED, JSON_CONTENT } from './const'
import { appendField, appendFile, blobToFile, matchFileKey, stringToFile } from './form-data'

// the `rest` action is the per-route REST settings constructor (was Rest.actions.settings)
export const restSettingsAction = operation(function* (options: AnyType) {
  return {
    ...options,
    method: options.method ?? 'GET',
    path: options.path ?? '/',

    transformer: Gateway,
  }
})

export const toInternalAction = operation(function* (req: AnyType, _res: unknown, meta: AnyType) {
  const ctx = yield* useContext(Gateway.context)
  const maxBytes = ctx.maxBodyBytes

  const url = new URL(req.url)
  const headers = Object.fromEntries(req.headers.entries())
  const fileMatcher = meta.setting?.files as GatewayDef.RestOptions['files']
  const files: Record<string, ActionFile[]> = {}

  let parsedBody: unknown = null

  if (BODY_METHODS.has(String(req.method).toUpperCase())) {
    const contentType = req.headers.get('content-type') ?? ''

    if (maxBytes !== undefined) {
      const declared = req.headers.get('content-length')
      if (declared && Number(declared) > maxBytes) {
        return yield* fail(
          CoreErrors.PayloadTooLarge,
          `body exceeds ${maxBytes} bytes (Content-Length: ${declared})`,
        )
      }
    }

    if (contentType.includes(JSON_CONTENT)) {
      // route JSON through the registered codec (JsonCodec) so HTTP bodies and the broker's transport
      // wire share one serializer (bad JSON → CodecErrors.Decode)
      const buffer = new Uint8Array(yield* until(req.arrayBuffer()))
      if (maxBytes !== undefined && buffer.byteLength > maxBytes) {
        return yield* fail(CoreErrors.PayloadTooLarge, `body exceeds ${maxBytes} bytes`)
      }
      parsedBody = buffer.byteLength === 0 ? null : yield* JsonCodec.actions.decode(buffer)
    } else if (contentType.includes(FORM_DATA) || contentType.includes(FORM_URLENCODED)) {
      const form: FormData = yield* until(req.formData())
      const fields: Record<string, unknown> = {}

      for (const [key, value] of form.entries()) {
        const isBlob = typeof value !== 'string'
        const isMatched = matchFileKey(fileMatcher, key)

        if (isBlob) {
          appendFile(files, key, blobToFile(value as Blob, key))
        } else if (isMatched) {
          appendFile(files, key, stringToFile(key, value))
        } else {
          appendField(fields, key, value)
        }
      }
      parsedBody = fields
    }
  }

  const queryParams = Object.fromEntries(url.searchParams.entries())
  const pathParams = meta.params as Record<string, unknown> | undefined

  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)

  const hasParamsOrQuery =
    (pathParams !== undefined && Object.keys(pathParams).length > 0) ||
    Object.keys(queryParams).length > 0

  let body: unknown
  if (isPlainObject(parsedBody)) {
    body = { ...pathParams, ...queryParams, ...parsedBody }
  } else if (parsedBody === null || parsedBody === undefined) {
    body = { ...pathParams, ...queryParams }
  } else {
    body = hasParamsOrQuery ? { ...pathParams, ...queryParams } : parsedBody
  }

  return [
    {
      type: 'http' as const,
      method: req.method,
      url,
      meta: headers,
      files,
    },
    {
      status: null,
      body: undefined,
      files: {},
      meta: {},
    },
    body,
  ] as [ActionRequest, ActionResponse, unknown]
})

// oxlint-disable-next-line max-params
export const fromInternalAction = operation(function* (
  _req: ActionRequest | null,
  res: ActionResponse | null,
  actionResponse: AnyType,
  meta: AnyType,
) {
  const ctx = yield* useContext(Gateway.context)
  const actionStatusMap = meta?.setting?.statusMap as Record<string, number> | undefined

  const headers = new Headers(res?.meta)
  if (!headers.has('content-type')) {
    headers.set('content-type', JSON_CONTENT)
  }

  const isJSON = headers.get('content-type') === JSON_CONTENT

  if (isFailure(actionResponse)) {
    if (actionResponse.error instanceof Error) {
      ;(actionResponse as AnyType).error = String(actionResponse.error)
    }

    const status = res?.status ?? statusFor(actionResponse.error, ctx.statusMap, actionStatusMap)
    const encoded = (yield* Codec.actions.encode(actionResponse)) as BodyInit
    return new Response(encoded, { headers, status })
  }

  const body = isSuccess(actionResponse) ? (actionResponse.value ?? res?.body) : res?.body
  const status = res?.status ?? (body === undefined ? 204 : 200)

  if (body === undefined) {
    return new Response(undefined, { status, headers })
  }

  // a streaming body (the gateway converts an action's byte Stream into a ReadableStream) goes out
  // verbatim — never through the codec — so it streams to the client instead of being buffered/encoded
  if (body instanceof ReadableStream) {
    return new Response(body, { status, headers })
  }

  // JSON responses go back out through the same codec; other content-types pass through verbatim
  if (isJSON) {
    const encoded = (yield* Codec.actions.encode(body)) as BodyInit
    return new Response(encoded, { headers, status })
  }
  return new Response(body as AnyType, { headers, status })
})
