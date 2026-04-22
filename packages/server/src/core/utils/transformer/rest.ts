import { operation, until, useContext, withHost } from 'std:effect'
import { IO } from 'std:io'
import { defineProtocol } from 'std:plugin'
import { fail, isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import type { ActionContext, ActionFile, ActionRequest, ActionResponse } from 'server:service'
import { ACTION_CONTEXT } from 'server:service'

import {
  BODY_METHODS,
  FORM_DATA,
  FORM_URLENCODED,
  JSON_CONTENT,
  RAW_BINARY,
  REST_TRANSFORMER,
} from '../../const'
import {
  appendField,
  appendFile,
  blobToFile,
  matchFileKey,
  stringToFile,
} from '../../internal/form-data'
import type { Helpers } from '../../types/helpers'
import type {
  RestTransformerActions,
  RestTransformerContext,
  RestTransformerOptions,
} from '../../types/transformer'
import { statusFor } from '../http-status'

// oxlint-disable-next-line import/exports-last
export const RestTransformer = defineProtocol<
  RestTransformerContext,
  unknown,
  [],
  RestTransformerActions
>({
  name: 'rest-transformer',
  version: '0.0.1',
  subtype: REST_TRANSFORMER,
})

const RestDef = RestTransformer.implement({
  name: 'default-rest-transformer',
  version: '0.0.1',

  // oxlint-disable-next-line require-yield
  *setup(options?: { statusMap?: Record<string, number> }) {
    return { statusMap: options?.statusMap ?? null }
  },
})

export const Rest: Helpers.DefaultRestTransformer = RestDef.build({
  toInternal: operation(function* (req: AnyType, res: unknown, meta: AnyType) {
    return yield* withHost({
      *bun() {
        const url = new URL(req.url)
        const headers = Object.fromEntries(req.headers.entries())
        const fileMatcher = meta.settings?.files as RestTransformerOptions['files']

        let parsedBody: unknown = null
        let rawBody: ActionRequest['rawBody'] = null
        const files: Record<string, ActionFile[]> = {}
        if (BODY_METHODS.has(req.method.toUpperCase())) {
          const contentType = req.headers.get('content-type') ?? ''
          if (contentType.includes(JSON_CONTENT)) {
            parsedBody = yield* until(req.json())
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
            method: req.method,
            url,

            meta: headers,
            files,
            body,

            raw: req,
            rawBody,
          } satisfies ActionRequest,
          {
            status: null,
            body: undefined,
            files: {},
            meta: {},

            raw: null,
          } satisfies ActionResponse,
        ]
      },
      *node() {
        return yield* fail('unexpected-runtime')
      },
      *deno() {
        return yield* fail('unexpected-runtime')
      },
      *browser() {
        return yield* fail('unexpected-runtime')
      },
    })
  }),

  toContext: operation(function* (req, res, meta: AnyType) {
    return yield* withHost({
      // oxlint-disable-next-line require-yield
      *bun() {
        return {
          _t: ACTION_CONTEXT,

          type: 'http' as const,
          from: meta.entry,

          body: req.body,
          files: req.files,
          meta: req.meta,

          req,
          res,
        } satisfies ActionContext<unknown>
      },
      *node() {
        return yield* fail('unexpected-runtime')
      },
      *deno() {
        return yield* fail('unexpected-runtime')
      },
      *browser() {
        return yield* fail('unexpected-runtime')
      },
    })
  }),

  // oxlint-disable-next-line max-params
  fromInternal: operation(function* (_req, res, actionResponse, meta: AnyType) {
    const ctx = yield* useContext(RestDef.context)
    const actionStatusMap = meta?.settings?.statusMap as Record<string, number> | undefined

    return yield* withHost({
      // oxlint-disable-next-line require-yield
      *bun() {
        const headers = new Headers(res?.meta)
        if (!headers.has('content-type')) {
          headers.set('content-type', JSON_CONTENT)
        }

        const isJSON = headers.get('content-type') === JSON_CONTENT

        if (isFailure(actionResponse)) {
          if (actionResponse.error instanceof Error) {
            ;(actionResponse as AnyType).error = String(actionResponse.error)
          }

          const status =
            res?.status ?? statusFor(actionResponse.error, ctx.statusMap, actionStatusMap)
          return Response.json(actionResponse, { headers, status })
        }

        const body = isSuccess(actionResponse) ? (actionResponse.value ?? res?.body) : res?.body
        const status = res?.status ?? (body === undefined ? 204 : 200)

        if (body === undefined) {
          return new Response(undefined, { status })
        }

        return isJSON
          ? Response.json(body, { headers, status })
          : new Response(body as AnyType, { headers, status })
      },
      *node() {
        return yield* fail('unexpected-runtime')
      },
      *deno() {
        return yield* fail('unexpected-runtime')
      },
      *browser() {
        return yield* fail('unexpected-runtime')
      },
    })
  }),

  // oxlint-disable-next-line require-yield
  settings: operation(function* (options) {
    return {
      // oxlint-disable-next-line oxc/no-rest-spread-properties
      ...options,
      method: options.method ?? 'GET',
      path: options.path ?? '/',

      transformer: Rest,
    }
  }),
})
