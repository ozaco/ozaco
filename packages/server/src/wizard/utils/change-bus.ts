import type { BusEvent, ChangeBus } from 'db:realtime'
import { DB } from 'db:realtime'
import { Broker } from 'server:core'
import { createSignal, operation, useContext } from 'std:effect'

/** Broker event name carrying a committed DB write across nodes. */
const CHANGE_EVENT = 'ozaco:db:change'

/**
 * Build a {@link ChangeBus} backed by the server Broker's event bus. `publish` broadcasts a committed
 * write to every node over whatever transports are installed — in-process by default, or NATS / worker
 * threads once their transport plugin is registered, with no bespoke transport to write. Every
 * broadcast (this node's own echo included) surfaces on the broker bus as an `event.broadcast`; the
 * DB-change ones are forwarded onto `events`, and the DB bridge drops this node's echoes by `origin`.
 */
export const changeBus = operation(function* () {
  const broker = yield* useContext(Broker)
  const events = createSignal<BusEvent>()
  yield* Broker.actions.on('event.broadcast', info => {
    if (info.name === CHANGE_EVENT) {
      events.send(info.payload as BusEvent)
    }
  })
  const bus: ChangeBus = {
    origin: broker.nodeId,
    publish: event => Broker.actions.broadcast(CHANGE_EVENT, event),
    events,
  }
  return bus
})

/**
 * Attach a Broker-backed {@link ChangeBus} to the installed realtime DB so reactive watches fan out
 * across nodes — automatically and idempotently. No-op when there is no realtime DB, no Broker, or a
 * bus is already attached. Called during resource realtime mount, so multi-node reactivity needs zero
 * app wiring: install a transport (e.g. NATS) and it just works; single-node stays purely in-memory.
 */
export const ensureChangeBus = operation(function* () {
  if ((yield* DB.context.get()) === undefined) {
    return
  }
  if ((yield* Broker.context.get()) === undefined) {
    return
  }
  if (yield* DB.actions.hasBus()) {
    return
  }
  const bus = yield* changeBus()
  yield* DB.actions.connectBus(bus)
})
