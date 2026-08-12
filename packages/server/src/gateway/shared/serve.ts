import type { GatewayDef } from 'server:core'
import { CoreErrors, Gateway, statusFor } from 'server:core'
import type { Operation, Scope } from 'std:effect'
import { operation, until } from 'std:effect'
import { isFailure, isSuccess } from 'std:result'

/**
 * Pause gate shared by both gateways: returns the error `Response` to send when the gateway is paused
 * (or the pause check failed), or `null` to proceed with the request.
 */
export const pauseGate = async (scope: Scope): Promise<Response | null> => {
  const paused = await scope.run(() => Gateway.actions.isPaused())

  if (isFailure(paused)) {
    return Response.json(
      { error: CoreErrors.BrokerInternal, message: 'pause check failed' },
      { status: statusFor(CoreErrors.BrokerInternal) },
    )
  }
  if (isSuccess(paused) && paused.value) {
    return Response.json(
      { error: CoreErrors.BrokerPaused, message: String(paused.value) },
      { status: statusFor(CoreErrors.BrokerPaused) },
    )
  }
  return null
}

/**
 * Run a request's dispatch in the background on the gateway scope, tracked in `ctx.inflight` so
 * `destroy()` can halt it (an active stream must not block shutdown). If the task ends WITHOUT having
 * delivered a response (e.g. it was halted on shutdown before the action returned), deliver a 503 so
 * the platform handler unblocks. Shared verbatim by the Bun and Node gateways.
 */
// oxlint-disable-next-line max-params
export const trackRequest = (
  scope: Scope,
  ctx: GatewayDef.Context,
  deliver: (response: Response) => void,
  body: () => Operation<void>,
): void => {
  const task = scope.run(body)
  ctx.inflight.add(task)
  // oxlint-disable-next-line promise/always-return
  void task.then(() => {
    ctx.inflight.delete(task)
    deliver(new Response(null, { status: 503 }))
  })
}

/**
 * Abort every in-flight request pump so an active stream cannot block shutdown — halting aborts each
 * pump and its upstream fetch, and (via the pump's `ensure`) closes the response stream. Call before
 * stopping the platform server.
 */
export const haltInflight = operation(function* (ctx: GatewayDef.Context) {
  const inflight = [...ctx.inflight]
  ctx.inflight.clear()
  yield* until(Promise.all(inflight.map(task => task.halt())))
})
