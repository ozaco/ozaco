import type { ActionRequest, ActionResponse, GatewayDef, ResponseSink } from 'server:core'
import { CoreErrors, Gateway, isService, ResponseSinkContext } from 'server:core'
import { operation, useContext } from 'std:effect'
import { IO } from 'std:io'
import { asFailure, auto, fail, succeed } from 'std:result'

import { dispatchAction } from './dispatch'
import { resolveRouteAction } from './util'

/**
 * The platform-agnostic REST request path. It calls the hookable transformer actions through the
 * protocol (`Gateway.actions.toInternal` / `fromInternal`) — NOT internal functions — so plugin
 * hooks (e.g. cors `Gateway.before({ fromInternal })`) fire. Owns its own try/catch so it always
 * resolves to a Response (failures become an error Response via fromInternal).
 *
 * `deliver` is invoked exactly once with the final Response. For a normal action it fires once the
 * value has been transformed; for a STREAMING action (the action returned a byte Stream) it fires as
 * soon as the headers are known — while the body keeps draining inside the action's still-open scope —
 * so the platform handler can send the response and begin streaming the body. Crucially the streaming
 * Response is built through the SAME `fromInternal` transformer as a normal one, so cors and every
 * other response hook apply to streamed responses too (no bypass).
 */
export const dispatchRequest = operation(function* (
  request: Request,
  rawRes: unknown,
  deliver: (response: Response) => void,
) {
  let actionReq: ActionRequest | null = null
  let actionRes: ActionResponse | null = null
  let delivered = false

  const ctx = yield* useContext(Gateway.context)

  const send = (response: Response) => {
    if (!delivered) {
      delivered = true
      deliver(response)
    }
  }

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
    const req = internal[0]
    const res = internal[1]
    const body = internal[2]
    actionReq = req
    actionRes = res

    const action = resolveRouteAction(entry)

    // When the action returns a Stream, InternalTransport calls this — inside the action's still-open
    // scope — to build the streaming Response through fromInternal (cors etc. apply), deliver it
    // immediately, then drain the body (paced by the consumer via backpressure).
    const sink: ResponseSink = {
      *respond(stream) {
        const { readable, pump } = yield* IO.actions.toReadable(stream)
        const response = (yield* Gateway.actions.fromInternal(
          req,
          res,
          succeed(readable),
          meta,
        )) as Response
        send(response)
        yield* pump
      },
    }

    const ret = yield* ResponseSinkContext.with(sink, () =>
      dispatchAction(
        { req, res, rawReq: request, rawRes, signal: request.signal },
        action,
        body,
        isService(entry.target),
      ),
    )

    // streaming already built + delivered + drained via the sink; otherwise transform the value
    if (delivered) {
      return undefined
    }

    const response = (yield* Gateway.actions.fromInternal(req, res, auto(ret), meta)) as Response
    send(response)
    return response
  } catch (error) {
    const failure = asFailure(error)
    const simplifiedFailure = ctx.simplify ? yield* ctx.simplify(failure) : failure

    const response = (yield* Gateway.actions.fromInternal(
      actionReq,
      actionRes,
      simplifiedFailure,
      null,
    )) as Response
    send(response)
    return response
  }
})
