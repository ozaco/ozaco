import { operation, until, withHost } from 'std:effect'
import { IO } from 'std:io'
import { defineNamespace } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { ActionContext, ActionFile, ActionRequest, ActionResponse } from 'server:service'
import { ACTION_CONTEXT } from 'server:service'

import { REST_TRANSFORMER, TransformerTags } from '../../const'
import type { Helpers } from '../../types/helpers'
import type {
  RestFileMatcher,
  RestTransformerActions,
  RestTransformerContext,
} from '../../types/transformer'

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
const RAW_BINARY = 'application/octet-stream'
const FORM_DATA = 'multipart/form-data'
const FORM_URLENCODED = 'application/x-www-form-urlencoded'
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

const matchFileKey = (matcher: RestFileMatcher | undefined, key: string): boolean => {
  if (!matcher) {
    return false
  }
  if (Array.isArray(matcher)) {
    return matcher.includes(key)
  }
  if (matcher instanceof RegExp) {
    return matcher.test(key)
  }
  return matcher(key)
}

const appendField = (target: Record<string, unknown>, key: string, value: unknown): void => {
  if (key in target) {
    const prev = target[key]
    target[key] = Array.isArray(prev) ? [...prev, value] : [prev, value]
  } else {
    target[key] = value
  }
}

const appendFile = (target: Record<string, ActionFile[]>, key: string, file: ActionFile): void => {
  if (!target[key]) {
    target[key] = []
  }
  target[key].push(file)
}

const blobToFile = (blob: Blob, fallbackName: string): ActionFile => {
  const maybeFile = blob as Blob & { name?: string; lastModified?: number }
  return {
    name: typeof maybeFile.name === 'string' ? maybeFile.name : fallbackName,
    type: blob.type || 'application/octet-stream',
    size: blob.size,
    lastModified: typeof maybeFile.lastModified === 'number' ? maybeFile.lastModified : undefined,
    stream: IO.actions.fromReadable(blob.stream().getReader()),
  }
}

const stringToFile = (key: string, value: string): ActionFile => {
  const blob = new Blob([value])
  return {
    name: key,
    type: 'text/plain',
    size: blob.size,
    stream: IO.actions.fromReadable(blob.stream().getReader()),
  }
}

export const Rest: Helpers.DefaultRestTransformer = RestDef.build({
  toInternal: operation(function* (req: AnyType, res: unknown, meta: AnyType) {
    return yield* withHost({
      *bun() {
        const url = new URL(req.url)
        const headers = Object.fromEntries(req.headers.entries())
        const fileMatcher = meta.settings?.files as RestFileMatcher | undefined

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
          } else if (contentType.includes(RAW_BINARY)) {
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

  // oxlint-disable-next-line require-yield
  settings: operation(function* (options) {
    return {
      // oxlint-disable-next-line oxc/no-rest-spread-properties
      ...options,
      method: options.method ?? 'GET',
      path: options.path ?? '/',

      transformer: Rest,
    }
  }, TransformerTags.settings),
})
