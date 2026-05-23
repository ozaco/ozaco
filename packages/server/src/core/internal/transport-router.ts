import { filter, operation, some, toSorted, useContext } from 'std:effect'
import { Logger } from 'std:logger'
import { asFailure, fail } from 'std:result'

import { CoreErrors } from '../const'
import type { TransportDef } from '../types/transport'

import { TransportRegistryContext } from './context'

export const sortedEntries = operation(function* (entries: TransportDef[]) {
  return yield* toSorted(entries, function* (a, b) {
    const aCtx = yield* useContext(a)
    const bCtx = yield* useContext(b)

    return aCtx.priority - bCtx.priority
  })
})

export const transportDispatch = operation(function* (req: TransportDef.DispatchRequest) {
  const entries = yield* transportGetTransportsHandler()

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

      const hasNext = entryContext.next(failure)

      yield* Logger.actions.debug('skipping', entry.name, `${hasNext}`)

      if (!hasNext) {
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
  const entries = yield* transportGetTransportsHandler()

  for (const entry of entries) {
    yield* entry.actions.emit(req)
  }
})

export const transportBroadcast = operation(function* (req: TransportDef.EventRequest) {
  const entries = yield* transportGetTransportsHandler()

  for (const entry of entries) {
    yield* entry.actions.broadcast(req)
  }
})

export const transportRegisterHandler: TransportDef.Handlers['register'] = operation(
  function* (transport, transportCtx) {
    const existing = (yield* TransportRegistryContext.get()) ?? []

    if (
      yield* some(existing, function* (target) {
        const targetCtx = yield* useContext(target)

        return targetCtx.name === transportCtx.name
      })
    ) {
      return yield* fail(
        'unexpected',
        `Logger transport ${transportCtx.name} is already registered`,
      )
    }

    yield* TransportRegistryContext.set([...existing, transport])
  },
)

export const transportUnregisterHandler: TransportDef.Handlers['unregister'] = operation(
  function* (transport) {
    const existing = yield* transportGetTransportsHandler()
    const transportCtx = yield* useContext(transport)

    yield* TransportRegistryContext.set(
      yield* filter(existing, function* (target) {
        const targetCtx = yield* useContext(target)

        return targetCtx.name === transportCtx.name
      }),
    )
  },
)

export const transportGetTransportsHandler: TransportDef.Handlers['getTransports'] = operation(
  function* () {
    return yield* sortedEntries((yield* TransportRegistryContext.get()) ?? [])
  },
)
