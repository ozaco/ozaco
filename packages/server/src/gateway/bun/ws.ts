import { CoreErrors, Gateway } from 'server:core'
import { operation, useContext } from 'std:effect'
import { IO } from 'std:io'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { wsUpgradeRequest } from '../shared/ws'

// Bun-specific WS upgrade: match the route, then hand the socket to Bun with its per-connection `data`
// (incl. a stable `id` for the registry). The lifecycle (onOpen/onMessage/onClose) + real-time actions
// are platform-agnostic and live in ../shared/realtime; Bun's `websocket` callbacks route into them.
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
  const id = yield* IO.actions.uuid()

  // upgrade-time auth: refuse BEFORE the socket exists; the resolved principal rides `ws.data`.
  // Any refusal — `false` or a failing hook (whatever tag it carries) — answers Unauthorized here,
  // so the edge maps it to 401 instead of mistaking it for an unrouted path.
  let principal: unknown
  const authorize = entry.setting.authorize
  if (authorize) {
    try {
      principal = yield* authorize(wsUpgradeRequest({ url: req.url, headers, params }))
    } catch (error) {
      return yield* fail(
        CoreErrors.Unauthorized,
        `upgrade refused for ${url.pathname}`,
        String((error as AnyType)?.message ?? error),
      )
    }
    if (principal === false) {
      return yield* fail(CoreErrors.Unauthorized, `upgrade refused for ${url.pathname}`)
    }
  }

  const upgraded = server.upgrade(req, {
    data: {
      id,
      url: req.url,
      headers,
      params,
      entry,
      ...(principal === undefined ? {} : { principal }),
      controller: new AbortController(),
    },
  })

  if (upgraded) {
    return true
  }

  return yield* fail(CoreErrors.BrokerInternal, 'cannot upgrade')
})
