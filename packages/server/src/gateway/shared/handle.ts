import type { ActionRequest, ActionResponse, GatewayDef } from 'server:core'
import { CoreErrors, Gateway, isService } from 'server:core'
import { operation, useContext } from 'std:effect'
import { asFailure, auto, fail } from 'std:result'

import { dispatchAction } from './dispatch'
import { resolveRouteAction } from './util'

/**
 * The platform-agnostic REST request path. It calls the hookable transformer actions through the
 * protocol (`Gateway.actions.toInternal` / `fromInternal`) — NOT internal functions — so plugin
 * hooks (e.g. cors `Gateway.before({ fromInternal })`) fire. Owns its own try/catch so it always
 * resolves to a Response (failures become an error Response via fromInternal).
 */
export const dispatchRequest = operation(function* (request: Request, rawRes: unknown) {
  let actionReq: ActionRequest | null = null
  let actionRes: ActionResponse | null = null

  const ctx = yield* useContext(Gateway.context)

  try {
    const url = new URL(request.url)
    const [sym, params] = yield* Gateway.actions.find(request.method, url.pathname)

    const entry = ctx.handlers.get(sym)
    if (!entry) {
      return yield* fail(CoreErrors.NotFound, `no handler for ${request.method}:${url.pathname}`)
    }

    const meta: GatewayDef.TransformerMeta = {
      sym: entry.sym,
      prefix: entry.prefix,
      target: entry.target,
      setting: entry.setting,
      params: (params ?? {}) as Record<string, unknown>,
    }
    if (entry.key !== undefined) {
      meta.key = entry.key
    }

    const internal = yield* Gateway.actions.toInternal(request, null, meta)
    actionReq = internal[0]
    actionRes = internal[1]
    const body = internal[2]

    const action = resolveRouteAction(entry)

    const ret = yield* dispatchAction(
      { req: actionReq, res: actionRes, rawReq: request, rawRes, signal: request.signal },
      action,
      body,
      isService(entry.target),
    )

    return (yield* Gateway.actions.fromInternal(actionReq, actionRes, auto(ret), meta)) as Response
  } catch (error) {
    const failure = asFailure(error)
    const simplifiedFailure = ctx.simplify ? yield* ctx.simplify(failure) : failure

    return (yield* Gateway.actions.fromInternal(
      actionReq,
      actionRes,
      simplifiedFailure,
      null,
    )) as Response
  }
})
