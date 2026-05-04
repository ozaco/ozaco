import type { ActionFile, ActionRequest, ActionResponse, Helpers } from 'server:core'
import { Rest, ServerErrorCode, statusFor } from 'server:core'
import { operation, until, useContext } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { BODY_METHODS, FORM_DATA, FORM_URLENCODED, JSON_CONTENT, RAW_BINARY } from '../const'
import {
  appendField,
  appendFile,
  blobToFile,
  matchFileKey,
  stringToFile,
} from '../internal/form-data'

export const RestImpl = Rest.implement({
  name: 'default-rest-transformer',
  version: '0.0.1',

  *setup(options = {}) {
    return options
  },
})

export const settingsAction = operation(function* (options) {
  return {
    // oxlint-disable-next-line oxc/no-rest-spread-properties
    ...options,
    method: options.method ?? 'GET',
    path: options.path ?? '/',

    transformer: Rest,
  }
})

export const toInternalAction = operation(function* (req: AnyType, _res: unknown, meta: AnyType) {
  const ctx = yield* useContext(RestImpl.context)
  const maxBytes = ctx.maxBodyBytes

  const url = new URL(req.url)
  const headers = Object.fromEntries(req.headers.entries())
  const fileMatcher = meta.setting?.files as Helpers.RestTransformerOptions['files']
  const files: Record<string, ActionFile[]> = {}

  let parsedBody: unknown = null
  let rawBody: ActionRequest['rawBody'] = null

  if (BODY_METHODS.has(req.method.toUpperCase())) {
    const contentType = req.headers.get('content-type') ?? ''

    // Up-front Content-Length guard (cheap; doesn't catch chunked uploads but limits obvious cases)
    if (maxBytes !== undefined) {
      const declared = req.headers.get('content-length')
      if (declared && Number(declared) > maxBytes) {
        return yield* fail(
          ServerErrorCode.PayloadTooLarge,
          `body exceeds ${maxBytes} bytes (Content-Length: ${declared})`,
        )
      }
    }

    if (contentType.includes(JSON_CONTENT)) {
      const text: string = yield* until(req.text())
      if (maxBytes !== undefined && text.length > maxBytes) {
        return yield* fail(ServerErrorCode.PayloadTooLarge, `body exceeds ${maxBytes} bytes`)
      }
      try {
        parsedBody = text.length === 0 ? null : JSON.parse(text)
      } catch (error) {
        return yield* fail(ServerErrorCode.Validation, `invalid JSON: ${String(error)}`)
      }
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
    } else if (contentType.includes(RAW_BINARY) && req.body) {
      rawBody = IO.actions.fromReadable(req.body.getReader())
    }
  }

  const queryParams = Object.fromEntries(url.searchParams.entries())
  const body = {
    // oxlint-disable-next-line oxc/no-rest-spread-properties, unicorn/no-useless-fallback-in-spread
    ...(meta.params ?? {}),
    // oxlint-disable-next-line oxc/no-rest-spread-properties
    ...queryParams,
    // oxlint-disable-next-line oxc/no-rest-spread-properties, unicorn/no-useless-fallback-in-spread
    ...((parsedBody as Record<string, unknown>) ?? {}),
  }

  return [
    {
      type: 'http' as const,
      from: (meta?.key ?? '') as string,

      method: req.method,
      url,

      meta: headers,
      files,
      rawBody,
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
export const fromInternalAction = operation(function* (_req, res, actionResponse, meta: AnyType) {
  const ctx = yield* useContext(RestImpl.context)
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
    return Response.json(actionResponse, { headers, status })
  }

  const body = isSuccess(actionResponse) ? (actionResponse.value ?? res?.body) : res?.body
  const status = res?.status ?? (body === undefined ? 204 : 200)

  if (body === undefined) {
    return new Response(undefined, { status, headers })
  }

  return isJSON
    ? Response.json(body, { headers, status })
    : new Response(body as AnyType, { headers, status })
})
