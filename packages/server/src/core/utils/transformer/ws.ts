import { operation, useContext, withHost } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import { asFailure, auto, fail, isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import type { ActionContext, ActionRequest, ActionResponse } from 'server:service'
import { ACTION_CONTEXT } from 'server:service'

import { JSON_CONTENT, WS_TRANSFORMER } from '../../const'
import { encodeWsBody, parseWsPayload } from '../../internal/ws'
import type { Helpers } from '../../types/helpers'
import type {
  WsOptions,
  WsTransformerActions,
  WsTransformerContext,
} from '../../types/ws-transformer'
import { Router } from '../router/definition'

// oxlint-disable-next-line import/exports-last
export const WsTransformer = defineProtocol<
  WsTransformerContext,
  unknown,
  [WsOptions?],
  WsTransformerActions
>({
  name: 'ws-transformer',
  version: '0.0.1',
  subtype: WS_TRANSFORMER,

  defaultActions: {
    // oxlint-disable-next-line require-yield
    upgrade: operation(function* () {
      return false
    }),
    onOpen: operation(function* () {}),
    onMessage: operation(function* () {}),
    onClose: operation(function* () {}),
  },
})

type WsEntry = { handler: AnyType; key: string; settings: AnyType }

const buildRequest = (ws: AnyType, payload: unknown, meta: AnyType): ActionRequest => {
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
    ...((meta?.params as Record<string, unknown> | undefined) ?? {}),
    // oxlint-disable-next-line oxc/no-rest-spread-properties, unicorn/no-useless-fallback-in-spread
    ...((parsedBody as Record<string, unknown>) ?? {}),
  }

  return {
    method: 'WS',
    url,
    meta: headers,
    files: {},
    body,
    raw: ws,
    rawBody: null,
  }
}

const buildResponse = (ws: AnyType): ActionResponse => ({
  status: null,
  body: undefined,
  files: {},
  meta: { 'content-type': JSON_CONTENT },
  raw: ws,
})

const sendResult = (ws: AnyType, res: ActionResponse | null, result: AnyType) => {
  const sink = (ws ?? res?.raw ?? null) as { send?: (data: AnyType) => void } | null
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
}

const WsDef = WsTransformer.implement({
  name: 'default-ws-transformer',
  version: '0.0.1',

  // oxlint-disable-next-line require-yield
  *setup(options: WsOptions = {}) {
    return {
      open: options.open ?? null,
      close: options.close ?? null,
    }
  },
})

export const Ws: Helpers.DefaultWsTransformer = WsDef.build({
  upgrade: operation(function* (req, runtime) {
    return yield* withHost({
      *bun() {
        if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
          return false
        }

        const url = new URL(req.url)

        let routeData: [symbol, unknown?] | null = null
        try {
          routeData = yield* Router.actions.find('WS', url.pathname)
        } catch {
          routeData = null
        }

        if (!routeData) {
          return yield* fail('not-found', `no handler for ${req.method}:${url.pathname}`)
        }

        const [sym, params] = routeData
        const routerCtx = yield* useContext(Router.context)
        const entry = routerCtx.handlers.get(sym)
        if (!entry) {
          return yield* fail('not-found', `no handler for ${req.method}:${url.pathname}`)
        }

        const server = runtime as {
          upgrade: (req: Request, opts: { data: AnyType }) => boolean
        }

        const headers = Object.fromEntries(req.headers.entries())

        const upgraded = server.upgrade(req, {
          data: {
            url: req.url,
            headers,
            params,
            entry,
          },
        })

        if (upgraded) {
          return true
        }

        return yield* fail('server-internal', 'cannot upgrade')
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

  onOpen: operation(function* (ws) {
    const ctx = yield* useContext(WsDef.context)
    if (ctx.open) {
      yield* ctx.open(ws)
    }
  }),

  onMessage: operation(function* (ws: AnyType, message) {
    const entry = ws?.data?.entry as WsEntry | null | undefined
    if (!entry) {
      return
    }

    const transformerMeta = {
      entry: entry.key,
      params: ws.data?.params ?? {},
      settings: entry.settings,
    }

    const req = buildRequest(ws, message, transformerMeta)
    const res = buildResponse(ws)

    try {
      const ctx: ActionContext<unknown> = {
        _t: ACTION_CONTEXT,
        type: 'ws',
        from: entry.key,
        body: req.body,
        files: req.files,
        meta: req.meta,
        req,
        res,
      }
      const result = yield* entry.handler(ctx)
      sendResult(ws, res, auto(result))
    } catch (error) {
      sendResult(ws, res, asFailure(error))
    }
  }),

  onClose: operation(function* (ws, code, reason) {
    const ctx = yield* useContext(WsDef.context)
    if (ctx.close) {
      yield* ctx.close(ws, code, reason)
    }
  }),

  // oxlint-disable-next-line require-yield
  settings: operation(function* (options) {
    return {
      // oxlint-disable-next-line oxc/no-rest-spread-properties
      ...options,
      path: options.path ?? '/',
      method: 'WS',

      transformer: Ws,
    }
  }),
})
