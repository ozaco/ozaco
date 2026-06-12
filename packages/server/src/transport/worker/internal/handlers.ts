import type { Service, TransportDef } from 'server:core'
import { Broker, CoreErrors, isStreamResult } from 'server:core'
import type { Stream } from 'std:effect'
import { attempt, ensure, operation, useContext } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail, isSuccess } from 'std:result'

import { invokeAction } from '../../shared/invoke'
import type { WorkerDef } from '../types'

import { pumpStream } from './pump'
import { captureInputStreams } from './subscribe'
import { decodeValue, encodeValue, wireFailure, wireStream, wireSuccess } from './wire'

const resolveService = (
  services: Map<string, Service>,
  serviceName: string,
): Service | undefined => {
  const exact = services.get(serviceName)
  if (exact) {
    return exact
  }
  for (const svc of services.values()) {
    if (svc.name === serviceName) {
      return svc
    }
  }
  return undefined
}

const handleEvent = (kind: 'event.emit' | 'event.broadcast') =>
  operation(function* (ctx: WorkerDef.Context, rawReq: unknown) {
    const broker = yield* useContext(Broker)
    const req = yield* decodeValue(ctx.wire, rawReq)
    broker.bus.emit(kind, req as TransportDef.EventRequest)
  })

export const handleDispatch = (
  ctx: WorkerDef.Context,
  endpoint: WorkerDef.Endpoint,
  env: WorkerDef.DispatchEnvelope,
) =>
  operation(function* () {
    const broker = yield* useContext(Broker)

    let responded = false
    const respond = (wire: WorkerDef.Wire) => {
      if (responded) {
        return
      }
      responded = true
      endpoint.post({ kind: 'reply', cid: env.cid, wire })
    }

    yield* ensure(function* () {
      ctx.handlers.delete(env.cid)
      respond(wireFailure(asFailure(fail('cancelled', 'handler cancelled'))))
    })

    const service = resolveService(broker.services, env.serviceName)
    if (!service) {
      respond(
        wireFailure(asFailure(fail(CoreErrors.NotFound, `service "${env.serviceName}" not found`))),
      )
      return
    }

    const streams = yield* captureInputStreams(ctx, endpoint, env.inputStreams ?? [])

    const params =
      env.params === undefined ? [] : ((yield* decodeValue(endpoint.wire, env.params)) as unknown[])
    const rawReq =
      env.rawReq === undefined ? undefined : yield* decodeValue(endpoint.wire, env.rawReq)

    const outcome: Result<unknown, unknown> = yield* attempt(
      invokeAction({
        service,
        actionKey: env.actionKey,
        params,
        streams,
        rawReq,
        traceContext: env.traceContext,
      }),
    )

    if (!isSuccess(outcome)) {
      respond(wireFailure(outcome))
      return
    }

    if (isStreamResult(outcome.value)) {
      respond(wireStream())
      yield* pumpStream(endpoint, env.outputStream, outcome.value as Stream<unknown, unknown>)
      return
    }

    respond(wireSuccess(yield* encodeValue(endpoint.wire, outcome.value)))
  })

export const handleEmit = handleEvent('event.emit')
export const handleBroadcast = handleEvent('event.broadcast')
