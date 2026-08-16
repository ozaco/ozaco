import { operation } from 'std:effect'
import { fail, isJust } from 'std:result'

import { CoreErrors } from '../errors'
import type { TransportDef, TransportDispatch, TransportEvent } from '../types/transport'

import { TransportRegistryContext } from './context'

export const transportGetHandler = operation(function* () {
  return (yield* TransportRegistryContext.get()) ?? []
})

export const transportRegisterHandler = operation(function* (entry: TransportDef.Entry) {
  const existing = yield* transportGetHandler()

  if (existing.some(candidate => candidate.name === entry.name)) {
    return yield* fail(CoreErrors.Configuration, `transport "${entry.name}" is already registered`)
  }

  const next = [...existing, entry].toSorted((a, b) => a.priority - b.priority)

  yield* TransportRegistryContext.set(next)
})

export const transportUnregisterHandler = operation(function* (name: string) {
  const existing = yield* transportGetHandler()

  yield* TransportRegistryContext.set(existing.filter(candidate => candidate.name !== name))
})

/**
 * hosts()-first routing: `just(true)` dispatches, `just(false)` skips, `nothing()` becomes a
 * fallback candidate tried only when no carrier positively hosts the service.
 */
export const transportDispatchRoot = operation(function* (dispatch: TransportDispatch) {
  const entries = yield* transportGetHandler()
  const { service, action } = dispatch.request

  if (entries.length === 0) {
    return yield* fail(CoreErrors.Unavailable, 'no transport is registered on this broker')
  }

  const fallbacks: TransportDef.Entry[] = []

  for (const entry of entries) {
    const hosted = yield* entry.actions.hosts(service)

    if (isJust(hosted)) {
      if (hosted.value) {
        return yield* entry.actions.dispatch(dispatch)
      }
      continue
    }

    fallbacks.push(entry)
  }

  const fallback = fallbacks[0]

  if (fallback) {
    return yield* fallback.actions.dispatch(dispatch)
  }

  return yield* fail(
    CoreErrors.Unavailable,
    `no transport hosts "${service}.${action}"`,
    `transport: dispatch cid:${dispatch.request.cid}`,
  )
})

/** First carrier reporting `handled` wins; silence is fine (events are fire-and-forget). */
export const transportEmitRoot = operation(function* (event: TransportEvent) {
  const entries = yield* transportGetHandler()

  for (const entry of entries) {
    const result = yield* entry.actions.emit(event)

    if (result === 'handled') {
      return
    }
  }
})

export const transportBroadcastRoot = operation(function* (event: TransportEvent) {
  const entries = yield* transportGetHandler()

  for (const entry of entries) {
    yield* entry.actions.broadcast(event)
  }
})
