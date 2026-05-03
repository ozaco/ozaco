import {
  ActionRawRequestContext,
  ActionRawResponseContext,
  ActionRequestContext,
  ActionResponseContext,
  Router,
  Ws,
} from 'server:core'
import { operation, useContext } from 'std:effect'
import { asFailure, auto, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { buildRequest, buildResponse, sendResult } from '../internal/ws'
import { resolveActionHandler } from '../utils/resolve'

export const WsImpl = Ws.implement({
  name: 'default-ws-transformer',
  version: '0.0.1',

  // oxlint-disable-next-line require-yield
  *setup(options = {}) {
    return options
  },
})

export const onCloseAction = operation(function* (ws, code, reason) {
  const ctx = yield* useContext(WsImpl.context)
  if (ctx.close) {
    yield* ctx.close(ws, code, reason)
  }
})

export const onMessageAction = operation(function* (ws: AnyType, message) {
  const entry = ws?.data?.entry
  if (!entry) {
    return
  }

  const [req, body] = yield* buildRequest(ws, message, entry.key ?? '')
  const res = buildResponse()

  try {
    const handler = resolveActionHandler(entry.target, entry.key)

    const actionResult = yield* ActionRequestContext.with(req, function* () {
      return yield* ActionResponseContext.with(res, function* () {
        return yield* ActionRawRequestContext.with(ws, function* () {
          return yield* ActionRawResponseContext.with(ws, function* () {
            return yield* handler(body)
          })
        })
      })
    })

    sendResult(ws, res, auto(actionResult))
  } catch (error) {
    sendResult(ws, res, asFailure(error))
  }
})

export const onOpenAction = operation(function* (ws) {
  const ctx = yield* useContext(WsImpl.context)
  if (ctx.open) {
    yield* ctx.open(ws)
  }
})

// oxlint-disable-next-line require-yield
export const settingsAction = operation(function* (options) {
  return {
    // oxlint-disable-next-line oxc/no-rest-spread-properties
    ...options,
    path: options.path ?? '/',
    method: 'WS',

    transformer: Ws,
  }
})

export const upgradeAction = operation(function* (req, runtime) {
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

  const server = runtime as Bun.Server<unknown>
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
})
