import { operation, useContext } from 'std:effect'
import { asFailure, auto, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { ActionContext } from 'server:core'
import { ACTION_CONTEXT, Router, WsTransformer } from 'server:core'

import { buildRequest, buildResponse, sendResult } from '../internal/ws'
import { resolveActionHandler } from '../utils/resolve'

export const WsImpl = WsTransformer.implement({
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

  const req = yield* buildRequest(ws, message)
  const res = buildResponse(ws)

  try {
    const ctx: ActionContext<unknown> = {
      _t: ACTION_CONTEXT,
      type: 'ws',
      from: entry.key ?? '',
      body: req.body,
      files: req.files,
      meta: req.meta,
      req,
      res,
    }

    const actionResult = yield* resolveActionHandler(entry.target, entry.key)(ctx)

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

    transformer: WsTransformer,
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
