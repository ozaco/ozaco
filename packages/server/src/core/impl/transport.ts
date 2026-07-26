import { ensure, operation, scoped, useContext } from 'std:effect'
import type { Result } from 'std:result'
import { fail, just } from 'std:result'

import { CoreErrors } from '../const'
import { Broker, Transport } from '../definitions'
import { resolveService } from '../internal/helpers'
import { invokeLocal } from '../internal/invoke'
import type { TransportDef } from '../types/transport'
import { tagOf } from '../utils/is'

const getSelf = (): TransportDef => InternalTransport

export const InternalTransport = Transport.implement({
  name: 'server/internal-transport',
  version: '0.0.0',
  *setup(options: TransportDef.Options = {}) {
    const name = options.name ?? 'server/internal-transport'
    const priority = options.priority ?? 0
    const next =
      /**
       * ONLY "this process does not host that address" moves on to the next carrier.
       *
       * Anything the ACTION produced — including its own 404 — is the answer, and conveying it
       * onward would run the body a second time somewhere else. Keying this on `NotFound` meant an
       * application and the router were spelling two different facts the same way.
       */
      options.next ??
      ((failure: Result.Failure<unknown>) => tagOf(failure.error) === CoreErrors.NotRegistered)

    const context: TransportDef.Context = {
      name,
      priority,
      next,
    }

    yield* Transport.actions.register(getSelf(), context)
    yield* ensure(function* () {
      yield* Transport.actions.unregister(getSelf())
    })

    return context
  },
}).build({
  /**
   * A definitive answer, because this carrier and the claim table are the same process.
   *
   * `just(false)` is safe to return HERE precisely because there is no partial view to be wrong
   * about — which is what makes it different from a wire carrier with no discovery.
   */
  hosts: operation(function* (service: string, path: string) {
    const broker = yield* useContext(Broker)
    const resolved = resolveService(broker.services, service)

    if (!resolved) {
      return just(false)
    }

    return just(yield* resolved.service.actions._has(path))
  }),

  dispatch: operation(function* (req: TransportDef.DispatchRequest) {
    const broker = yield* useContext(Broker)
    const resolved = resolveService(broker.services, req.service)

    if (!resolved) {
      return yield* fail(
        CoreErrors.NotRegistered,
        `service "${req.service}" not registered on broker "${broker.name}" (internal-transport has no remote fallback)`,
      )
    }

    // One invoker, shared with every other carrier. Two copies of this is how the not-found guard
    // came to be dead in one of them and the reply draft missing from the other.
    return yield* scoped(() => invokeLocal(resolved.service, req, req.contexts))
  }),

  // the request passes through WHOLE — it is built with conditional spreads, so absent fields are
  // genuinely absent, and stripping it here was how `traceContext` silently died in-process
  emit: operation(function* (req: TransportDef.EventRequest) {
    const broker = yield* useContext(Broker)

    broker.bus.emit('event.emit', req)
    // the local bus IS a full delivery — this carrier only ever runs when no wire claimed the emit
    return 'handled' as const
  }),

  broadcast: operation(function* (req: TransportDef.EventRequest) {
    const broker = yield* useContext(Broker)

    broker.bus.emit('event.broadcast', req)
  }),
})
