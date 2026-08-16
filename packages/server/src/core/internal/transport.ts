import { ensure, operation } from 'std:effect'
import { fail, just } from 'std:result'

import { Transport } from '../definition'
import { CoreErrors } from '../errors'
import type {
  TransportActions,
  TransportDispatch,
  TransportEvent,
  TransportOptions,
} from '../types/transport'
import { invokeLocal } from '../utils/invoke'

import { BrokerRef } from './context'

const internalActions: TransportActions = {
  hosts: operation(function* (service: string) {
    const broker = yield* BrokerRef.expect()

    return just(broker.registry.has(service))
  }),

  dispatch: operation(function* ({ request, acked, signal, sources }: TransportDispatch) {
    const broker = yield* BrokerRef.expect()
    const entry = broker.registry.get(request.service)

    if (!entry) {
      return yield* fail(
        CoreErrors.NoRoute,
        `service "${request.service}" is not registered on this node`,
        `transport:internal dispatch cid:${request.cid}`,
      )
    }

    return yield* invokeLocal({ entry, request, acked, signal, sources })
  }),

  emit: operation(function* (event: TransportEvent) {
    const broker = yield* BrokerRef.expect()

    if (broker.bus.listenerCount(event.name) === 0) {
      return 'skipped' as const
    }

    broker.bus.emit(event.name, event.payload, event.trace)

    return 'handled' as const
  }),

  broadcast: operation(function* (event: TransportEvent) {
    const broker = yield* BrokerRef.expect()

    broker.bus.emit(event.name, event.payload, event.trace)
  }),
}

/**
 * The in-process carrier: dispatches straight into `invokeLocal`, delivers events on the broker's
 * local bus. Ack fires the moment the handler starts, so `TimeoutUnreached` is (by design) nearly
 * impossible locally. Installed automatically by `DefaultBroker`.
 */
export const InternalTransport = Transport.implement<
  { readonly name: string },
  [TransportOptions?]
>({
  name: 'internal-transport',
  version: '0.1.0',
  *setup(options = {}) {
    const name = options.name ?? 'internal'

    yield* Transport.actions.register({
      name,
      priority: options.priority ?? 0,
      actions: internalActions,
    })

    yield* ensure(() => Transport.actions.unregister(name))

    return { name }
  },
}).build(internalActions)
