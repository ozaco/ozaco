import { operation, until, withHost } from 'std:effect'
import { IO } from 'std:io'
import { defineNamespace } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { ActionContext, ActionRequest, ActionResponse } from 'server:service'
import { ACTION_CONTEXT } from 'server:service'

import { REST_TRANSFORMER, TransformerTags } from '../../const'
import type { Helpers } from '../../types/helpers'
import type { RestTransformerActions, RestTransformerContext } from '../../types/transformer'

// oxlint-disable-next-line import/exports-last
export const RestTransformer = defineNamespace<
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
  *setup() {
    return {}
  },
})

const JSON_CONTENT = 'application/json'
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

export const Rest: Helpers.DefaultRestTransformer = RestDef.build({
  toInternal: operation(function* (req: AnyType, res: unknown, meta: AnyType) {
    return yield* withHost({
      *bun() {
        const url = new URL(req.url)
        const headers = Object.fromEntries(req.headers.entries())

        let parsedBody: unknown = null
        let rawBody: ActionRequest['rawBody'] = null
        if (BODY_METHODS.has(req.method.toUpperCase())) {
          const contentType = req.headers.get('content-type') ?? ''
          if (contentType.includes(JSON_CONTENT)) {
            rawBody = IO.actions.fromReadable(req.body)
            parsedBody = yield* until(req.json())
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
            files: {},
            body,

            raw: req,
            rawBody,
          } satisfies ActionRequest,
          {
            body: null,
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
  }, TransformerTags.toInternal),

  toContext: operation(function* (req, res, meta: AnyType) {
    return yield* withHost({
      // oxlint-disable-next-line require-yield
      *bun() {
        return {
          _t: ACTION_CONTEXT,
          type: 'http' as const,
          from: meta.entry,
          body: req.body,
          request: req,
          res,
          files: req.files,
          meta: req.meta,
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
  }, TransformerTags.toContext),

  fromInternal: operation(function* (_req, res, ret) {
    return yield* withHost({
      // oxlint-disable-next-line require-yield
      *bun() {
        const headers = new Headers(res?.meta)
        if (!headers.has('content-type')) {
          headers.set('content-type', JSON_CONTENT)
        }

        if (!ret) {
          return Response.json(res?.body, { headers })
        }
        if (isFailure(ret)) {
          if (ret.error instanceof Error) {
            ;(ret as AnyType).error = String(ret.error)
          }

          return Response.json(ret, { headers, status: 500 })
        }

        return Response.json(ret.value, { headers })
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
  }, TransformerTags.fromInternal),
})
