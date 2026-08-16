import { decodeEnvelope, encodeEnvelope } from 'server:core'
import type { TransportEvent } from 'server:core'
import { attempt, box, ensure, flow, operation, until } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { AckPolicy, DeliverPolicy, ReplayPolicy } from '@nats-io/jetstream'

import { NatsErrors } from '../errors'
import type { Nats } from '../types'

import { causesOf } from './failure'
import { eventsDurableOf } from './subjects'

/**
 * Publishes an emit/broadcast as an `event` envelope. DELIVERY GUARANTEE: `emit` is ALWAYS core
 * pub/sub (at-most-once — invalidation-style signals; offline nodes miss them). Broadcasts too,
 * UNLESS `events.durable` is on — then a broadcast rides `js.publish` into the `<P>_EVENT` stream
 * (PubAck-checked; msgID deliberately unset, broadcasts are never deduped) and offline queue
 * groups catch up through their durable consumer.
 */
export const publishEvent = operation(function* (ctx: Nats.Context, event: TransportEvent) {
  const encoded = yield* encodeEnvelope({
    k: 'event',
    name: event.name,
    payload: event.payload,
    trace: event.trace,
    scope: event.scope,
    origin: event.origin,
  })

  if (ctx.events.durable && event.scope === 'broadcast') {
    const persisted = yield* attempt(() =>
      until(ctx.js.publish(ctx.subjects.event(event.name), encoded)),
    )

    if (isFailure(persisted)) {
      yield* ctx.log.error('durable broadcast publish failed', {
        event: event.name,
        causes: causesOf(persisted),
      })

      return
    }

    yield* ctx.log.debug('durable broadcast persisted', { event: event.name })

    return
  }

  const published = yield* box(function* () {
    ctx.nc.publish(ctx.subjects.event(event.name), encoded)
  })

  if (isFailure(published)) {
    yield* ctx.log.warn('event publish failed', {
      event: event.name,
      causes: causesOf(published),
    })

    return
  }

  yield* ctx.log.debug('event published', { event: event.name, scope: event.scope })
})

/**
 * The inbound event fanout: one core subscription on `<p>.v1.event.>` delivers remote events into
 * the local broker bus. Own echoes are dropped by origin nodeId (the internal carrier already
 * emitted locally).
 */
export const eventPump = operation(function* (ctx: Nats.Context) {
  const sub = ctx.nc.subscribe(ctx.subjects.eventWild)

  yield* ensure(function* () {
    yield* box(function* () {
      sub.unsubscribe()
    })
  })

  const feed = yield* flow(sub)

  while (true) {
    const item = yield* feed.next()

    if (item.done) {
      return
    }

    const decoded = yield* box(() => decodeEnvelope(item.value.data))

    if (isFailure(decoded)) {
      yield* ctx.log.warn('undecodable event envelope dropped', { causes: causesOf(decoded) })

      continue
    }

    const envelope = decoded.value

    if (envelope.k !== 'event' || envelope.origin === ctx.broker.nodeId) {
      continue
    }

    // durable mode: broadcasts arrive through the durable group consumer — a JetStream publish
    // still fans out to core subscribers, so skipping here prevents double delivery
    if (ctx.events.durable && envelope.scope === 'broadcast') {
      continue
    }

    yield* ctx.log.debug('remote event delivered', {
      event: envelope.name,
      origin: envelope.origin,
    })

    ctx.broker.bus.emit(envelope.name, envelope.payload, envelope.trace)
  }
})

/**
 * Ensures this queue group's durable BROADCAST consumer on the `<P>_EVENT` stream. Called from
 * setup so a broken events configuration fails the install loudly. `DeliverPolicy.New`: the group
 * starts from "now" on FIRST creation, then resumes from its ack floor forever after —
 * restart-safe, missed broadcasts replay on the next attach.
 */
export const ensureEventConsumer = operation(function* (ctx: Nats.Context) {
  const durable = eventsDurableOf(ctx.queueGroup)
  const created = yield* attempt(() =>
    until(
      ctx.jsm.consumers.add(ctx.streams.event, {
        durable_name: durable,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.New,
        replay_policy: ReplayPolicy.Instant,
      }),
    ),
  )

  if (isFailure(created)) {
    return yield* fail(
      NatsErrors.Consume,
      `the durable event consumer "${durable}" could not be ensured`,
      ...causesOf(created),
    )
  }
})

/**
 * Durable BROADCAST delivery for this node's queue group. AT-LEAST-ONCE within the group: one
 * member consumes each broadcast, the ack lands AFTER bus delivery, and redeliveries are possible
 * — bus handlers MUST tolerate seeing an event twice. `emit`-scoped envelopes also land in the
 * stream (same subjects) and are acked + skipped: the core sub already delivered them; own
 * broadcasts are acked + dropped by origin nodeId like everywhere else.
 */
export const durableEventPump = operation(function* (ctx: Nats.Context) {
  const durable = eventsDurableOf(ctx.queueGroup)
  const consumer = yield* until(ctx.js.consumers.get(ctx.streams.event, durable))
  const messages = yield* until(consumer.consume())

  yield* ensure(() => {
    messages.stop()
  })

  yield* ctx.log.debug('durable event consumer live', { durable })

  const feed = yield* flow(messages)

  while (true) {
    const item = yield* feed.next()

    if (item.done) {
      return
    }

    const msg = item.value
    const decoded = yield* box(() => decodeEnvelope(msg.data))

    if (isFailure(decoded)) {
      msg.ack()
      yield* ctx.log.warn('undecodable durable event dropped', { causes: causesOf(decoded) })

      continue
    }

    const envelope = decoded.value

    if (
      envelope.k !== 'event' ||
      envelope.scope !== 'broadcast' ||
      envelope.origin === ctx.broker.nodeId
    ) {
      msg.ack()

      continue
    }

    ctx.broker.bus.emit(envelope.name, envelope.payload, envelope.trace)

    // acked AFTER delivery: a crash in between redelivers — at-least-once, never silent loss
    msg.ack()

    yield* ctx.log.debug('durable broadcast delivered', {
      event: envelope.name,
      origin: envelope.origin,
    })
  }
})

/** Bridges `nc.status()` into the instance logger (disconnect/reconnect/ldm/error visibility). */
export const statusPump = operation(function* (ctx: Nats.Context) {
  const feed = yield* flow(ctx.nc.status())

  while (true) {
    const item = yield* feed.next()

    if (item.done) {
      return
    }

    const status = item.value

    switch (status.type) {
      case 'disconnect': {
        yield* ctx.log.warn('nats disconnected', { server: status.server })

        break
      }
      case 'reconnect': {
        yield* ctx.log.info('nats reconnected', { server: status.server })

        break
      }
      case 'reconnecting': {
        yield* ctx.log.warn('nats reconnecting', {})

        break
      }
      case 'ldm': {
        yield* ctx.log.warn('nats server entered lame duck mode', { server: status.server })

        break
      }
      case 'error': {
        yield* ctx.log.error('nats connection error', {
          error: String(status.error),
          tag: NatsErrors.Connect,
        })

        break
      }
      case 'close': {
        yield* ctx.log.info('nats connection closed', {})

        return
      }
      default: {
        yield* ctx.log.debug('nats status', { type: status.type })
      }
    }
  }
})
