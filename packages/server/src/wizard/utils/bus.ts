import { Db, DbAdapter } from 'db:core'
import type { BusEvent, ChangeBus } from 'db:core'
import { Broker } from 'server:core'
import { createId } from 'server:utils'
import { createSignal, ensure, operation } from 'std:effect'

import { DB_CHANGE_EVENT } from '../const'

/**
 * Bridge the db change hub across nodes over the broker: a `ChangeBus` whose `publish` is
 * `Broker.broadcast('$db.change', batch)` and whose `events` flow is fed by `Broker.on`. Events
 * are INVALIDATIONS (db bus contract) — receiving nodes re-read from the shared database, so a
 * lost message can only delay a wake-up, never serve stale data; own echoes are dropped by origin.
 *
 * Wired automatically by `installWizard` (option `bus`, default true). No-ops (returns `false`)
 * when the broker or db is not installed, when the adapter has a native `live` feed (every node
 * already hears the backend directly), or when a bus is already attached.
 */
export const bridgeChangeBus = operation(function* () {
  const broker = yield* Broker.context.get()
  const db = yield* Db.context.get()
  const info = yield* DbAdapter.context.get()

  if (!broker || !db || !info || info.capabilities.live) {
    return false
  }

  if (yield* Db.actions.hasBus()) {
    return false
  }

  const origin = yield* createId('node')
  const stream = createSignal<BusEvent, never>()
  const unsubscribe = yield* Broker.actions.on(DB_CHANGE_EVENT, payload => {
    if (Array.isArray(payload)) {
      for (const event of payload) {
        stream.send(event as BusEvent)
      }
    }
  })

  yield* ensure(() => {
    unsubscribe()
  })

  const bus: ChangeBus = {
    origin,
    publish: operation(function* (events: readonly BusEvent[]) {
      yield* Broker.actions.broadcast(DB_CHANGE_EVENT, events)
    }),
    events: stream,
  }

  return yield* Db.actions.connectBus(bus)
})
