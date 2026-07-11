import type { GatewayDef } from 'server:core'
import { CoreErrors, Gateway, isService } from 'server:core'
import { operation, useContext } from 'std:effect'
import { asFailure, auto, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { dispatchAction } from '../shared/dispatch'
import { resolveRouteAction } from '../shared/util'
import { buildRequest, buildResponse, sendResult } from '../shared/ws'

export const onCloseAction = operation(function* (ws: AnyType, code: number, reason: string) {
  const setting = ws?.data?.entry?.setting as GatewayDef.WsSetting | undefined
  if (setting?.onClose) {
    yield* setting.onClose(ws, code, reason)
  }

  ws?.data?.controller?.abort()
})

export const onMessageAction = operation(function* (ws: AnyType, message: unknown) {
  const entry = ws?.data?.entry as GatewayDef.RegisteredRoute | undefined
  if (!entry) {
    return
  }

  const [req, body] = yield* buildRequest(ws, message)
  const res = buildResponse()

  const signal: AbortSignal | undefined = ws?.data?.controller?.signal
  const action = resolveRouteAction(entry)

  try {
    const ret = yield* dispatchAction(
      { req, res, rawReq: ws, rawRes: ws, signal },
      action,
      body,
      isService(entry.target),
    )
    yield* sendResult(ws, res, auto(ret))
  } catch (error) {
    yield* sendResult(ws, res, asFailure(error))
  }
})

export const onOpenAction = operation(function* (ws: AnyType) {
  const setting = ws?.data?.entry?.setting as GatewayDef.WsSetting | undefined
  if (setting?.onOpen) {
    yield* setting.onOpen(ws)
  }
})

export const upgradeAction = operation(function* (req: AnyType, runtime: AnyType) {
  if (String(req.headers.get('upgrade')).toLowerCase() !== 'websocket') {
    return false
  }

  const url = new URL(req.url)

  let routeData: [symbol, unknown?] | null = null
  try {
    routeData = yield* Gateway.actions.find('WS', url.pathname)
  } catch {
    routeData = null
  }

  if (!routeData) {
    return yield* fail(CoreErrors.NotFound, `no handler for ${req.method}:${url.pathname}`)
  }

  const [sym, params] = routeData
  const ctx = yield* useContext(Gateway.context)
  const entry = ctx.handlers.get(sym)

  if (!entry) {
    return yield* fail(CoreErrors.NotFound, `no handler for ${req.method}:${url.pathname}`)
  }

  const server = runtime as AnyType
  const headers = Object.fromEntries(req.headers.entries())

  const upgraded = server.upgrade(req, {
    data: {
      url: req.url,
      headers,
      params,
      entry,
      controller: new AbortController(),
    },
  })

  if (upgraded) {
    return true
  }

  return yield* fail(CoreErrors.BrokerInternal, 'cannot upgrade')
})
