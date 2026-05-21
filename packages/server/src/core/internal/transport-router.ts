import { operation, toSorted, useContext } from 'std:effect'
import { asFailure, fail } from 'std:result'

import { CoreErrors } from '../const'
import type { TransportDef } from '../types/transport'
import { getTransports } from '../utils/transport-registry'

export const sortedEntries = operation(function* (entries: TransportDef[]) {
  return yield* toSorted(entries, function* (a, b) {
    const aCtx = yield* useContext(a)
    const bCtx = yield* useContext(b)

    return aCtx.priority - bCtx.priority
  })
})

export const transportDispatch = operation(function* (req: TransportDef.DispatchRequest) {
  const entries = yield* getTransports()

  if (entries.length === 0) {
    return yield* fail(CoreErrors.MissingSettings, 'no transport registered')
  }

  let captured: unknown
  let hasFailed = false

  for (const entry of entries) {
    const entryContext = yield* useContext(entry)

    try {
      return yield* entry.actions.dispatch(req)
    } catch (error) {
      const failure = asFailure(error)

      hasFailed = true
      captured = failure

      if (!entryContext.next) {
        yield* failure
      }
    }
  }

  if (hasFailed) {
    yield* asFailure(captured)
  }

  return yield* fail(CoreErrors.NotFound, 'no transport handled the request')
})

export const transportEmit = operation(function* (req: TransportDef.EventRequest) {
  const entries = yield* getTransports()

  for (const entry of entries) {
    yield* entry.actions.emit(req)
  }
})

export const transportBroadcast = operation(function* (req: TransportDef.EventRequest) {
  const entries = yield* getTransports()

  for (const entry of entries) {
    yield* entry.actions.broadcast(req)
  }
})
