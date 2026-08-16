import { actionId, requestId } from 'server:utils'
import { operation } from 'std:effect'

import type { Trace, TraceOrigin } from '../types/trace'

/** Renders the lane as `gw>todos>ai` — the `laneId` recorded on every metrics row. */
export const laneOf = (trace: Trace): string => trace.lane.map(hop => hop.service).join('>')

/** The machine-readable cause appended to every failure that crosses an action boundary. */
export const breadcrumb = (trace: Trace, action: string): string =>
  `action:${action}(${trace.actionId}) svc:${trace.serviceId} req:${trace.requestId} lane:${laneOf(trace)}`

export interface HopInput {
  readonly service: string
  readonly action: string
  readonly transport: string
}

/** Root of a call tree — used when there is no ambient trace (direct broker calls, edges). */
export const rootTrace = operation(function* (input: {
  readonly origin: TraceOrigin
  readonly serviceId: string
  readonly requestId?: string | undefined
}) {
  const trace: Trace = {
    requestId: input.requestId ?? (yield* requestId()),
    origin: input.origin,
    serviceId: input.serviceId,
    actionId: yield* actionId(),
    lane: [],
  }

  return trace
})

/** One more hop: fresh actionId, parent link, lane extended with the target. */
export const childTrace = operation(function* (parent: Trace, hop: HopInput) {
  const nextActionId = yield* actionId()

  const trace: Trace = {
    requestId: parent.requestId,
    origin: parent.origin,
    serviceId: parent.serviceId,
    actionId: nextActionId,
    parentActionId: parent.actionId,
    lane: [
      ...parent.lane,
      {
        service: hop.service,
        action: hop.action,
        actionId: nextActionId,
        transport: hop.transport,
        ts: Date.now(),
      },
    ],
  }

  return trace
})

/** Owner side: stamp the handling instance before the handler runs. */
export const withServiceId = (trace: Trace, serviceId: string): Trace => ({
  ...trace,
  serviceId,
})
