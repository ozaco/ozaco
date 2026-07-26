import type { Response, Service, Source, TransportDef } from 'server:core'
import { Broker, CoreErrors, DataType, producesLane } from 'server:core'
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
    const contexts = (
      env.contexts === undefined ? undefined : yield* decodeValue(endpoint.wire, env.contexts)
    ) as TransportDef.DispatchContexts | undefined

    const outcome: Result<unknown, unknown> = yield* attempt(
      invokeAction({
        service,
        actionKey: env.actionKey,
        params,
        streams,
        ...(env.origin === undefined ? {} : { origin: env.origin }),
        ...(env.meta === undefined ? {} : { meta: env.meta }),
        ...(env.wire === undefined ? {} : { wire: env.wire }),
        contexts,
      }),
    )

    if (!isSuccess(outcome)) {
      respond(wireFailure(outcome))
      return
    }

    // The DECLARATION decides, not the value — see the note on the nats carrier.
    const response = outcome.value as Response

    if (producesLane(yield* service.actions._get(env.actionKey))) {
      const lane = response.sources.find(source => source.type === DataType.stream) as
        | Source.Lane
        | undefined
      respond(wireStream(response))
      yield* pumpStream(endpoint, env.outputStream, lane?.stream as Stream<unknown, unknown>)
      return
    }

    const body = response.sources.find(source => source.type === DataType.normal) as
      | Source.Normal
      | undefined
    respond(wireSuccess(yield* encodeValue(endpoint.wire, body?.value), response))
  })

export const handleEmit = handleEvent('event.emit')
export const handleBroadcast = handleEvent('event.broadcast')
