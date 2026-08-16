import { Transport, useBroker } from 'server:core'
import type { TransportActions, TransportEvent } from 'server:core'
import { moduleLogger, runSafe } from 'server:utils'
import { attempt, box, ensure, fork, operation, until, useScope } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import type { ConnectionOptions } from '@nats-io/nats-core'

import { NatsErrors } from './errors'
import { dispatchAction, hostsAction, outcomeAction } from './internal/caller'
import { NatsRef } from './internal/context'
import { causesOf } from './internal/failure'
import { ensureOwner, stopOwner } from './internal/owner'
import { provisionStreams } from './internal/provision'
import {
  durableEventPump,
  ensureEventConsumer,
  eventPump,
  publishEvent,
  statusPump,
} from './internal/pumps'
import { createStreamNames, createSubjects } from './internal/subjects'
import type { Nats, NatsTransportOptions } from './types'
import { natsImpl } from './utils/context'

const DEFAULT_PRIORITY = 10
/** 64 MiB of unacked lane bytes before producers park. */
const DEFAULT_LANE_MAX_BYTES = 67_108_864
const DEFAULT_LANE_FULL_TIMEOUT_MS = 30_000
/** 24h of durable broadcast history. */
const DEFAULT_EVENT_MAX_AGE_MS = 86_400_000

const emitAction = operation(function* (event: TransportEvent) {
  const ctx = yield* NatsRef.expect()

  yield* publishEvent(ctx, event)

  // Optimistic: remote interest is unknowable over pub/sub, so a delivered publish counts as
  // handled — `emit` stops at this carrier instead of falling through to lower-priority ones.
  return 'handled' as const
})

const broadcastAction = operation(function* (event: TransportEvent) {
  const ctx = yield* NatsRef.expect()

  yield* publishEvent(ctx, event)
})

const transportActions: TransportActions = {
  hosts: hostsAction,
  dispatch: dispatchAction,
  emit: emitAction,
  broadcast: broadcastAction,
}

/** Whitebox lane counters (park/retry activity) — a snapshot for tests and ops probes. */
const diagnosticsAction = operation(function* () {
  const ctx = yield* NatsRef.expect()

  return {
    laneRetries: ctx.diagnostics.laneRetries,
    laneFailures: [...ctx.diagnostics.laneFailures] as readonly string[],
  }
})

const nameOf = (payload: unknown): string | undefined => {
  const name = (payload as { name?: unknown } | undefined)?.name

  return typeof name === 'string' ? name : undefined
}

const NatsTransportImpl = Transport.implement<Nats.Context, [options?: NatsTransportOptions]>({
  name: 'nats-transport',
  version: '0.1.0',
  description: 'The NATS carrier: JetStream RPC workqueue, reply/cancel inboxes, lanes, outcomes',

  *setup(options = {}) {
    const scope = yield* useScope()
    const log = yield* moduleLogger('server:transport/nats')
    const brokerCtx = yield* attempt(() => useBroker())

    if (isFailure(brokerCtx)) {
      return yield* fail(
        NatsErrors.Configuration,
        'the NATS transport needs a running broker — install DefaultBroker first',
        ...causesOf(brokerCtx),
      )
    }

    const broker = brokerCtx.value
    const impl = yield* natsImpl.expect()

    // FULL ConnectionOptions passthrough; `servers` is pure sugar merged on top.
    const connection: ConnectionOptions =
      options.servers === undefined
        ? { ...options.connection }
        : {
            ...options.connection,
            servers: typeof options.servers === 'string' ? options.servers : [...options.servers],
          }

    const connected = yield* attempt(() => until(impl.connect(connection)))

    if (isFailure(connected)) {
      return yield* fail(
        NatsErrors.Connect,
        `could not connect to NATS (${String(connection.servers ?? '127.0.0.1:4222')})`,
        'transport:nats connect',
        ...causesOf(connected),
      )
    }

    const nc = connected.value

    // registered FIRST so it runs LAST at teardown — after unregister and every pump wound down
    yield* ensure(function* () {
      yield* box(() => until(nc.drain()))

      if (!nc.isClosed()) {
        yield* box(() => until(nc.close()))
      }
    })

    const manager = yield* attempt(() => until(jetstreamManager(nc)))

    if (isFailure(manager)) {
      return yield* fail(
        NatsErrors.Jetstream,
        'the NATS server does not have JetStream enabled — start it with `-js` (this transport needs it for the RPC/LANE/OUTCOME streams)',
        ...causesOf(manager),
      )
    }

    const name = options.name ?? 'nats'
    const prefix = options.subjectPrefix ?? 'ozaco'
    const subjects = createSubjects(prefix)
    const streams = createStreamNames(prefix)
    const jetstreamOptions = {
      replicas: options.jetstream?.replicas ?? 1,
      rpcMaxAgeMs: options.jetstream?.rpcMaxAgeMs ?? 60_000,
      laneMaxAgeMs: options.jetstream?.laneMaxAgeMs ?? 300_000,
      laneMaxBytes: options.jetstream?.laneMaxBytes ?? DEFAULT_LANE_MAX_BYTES,
      laneFullTimeoutMs: options.jetstream?.laneFullTimeoutMs ?? DEFAULT_LANE_FULL_TIMEOUT_MS,
      outcomeTtlMs: options.jetstream?.outcomeTtlMs ?? 600_000,
      storage: options.jetstream?.storage ?? 'memory',
    } as const
    const eventsOptions = {
      durable: options.events?.durable ?? false,
      maxAgeMs: options.events?.maxAgeMs ?? DEFAULT_EVENT_MAX_AGE_MS,
      storage: options.events?.storage ?? 'file',
    } as const

    yield* provisionStreams({
      jsm: manager.value,
      streams,
      subjects,
      options: jetstreamOptions,
      events: eventsOptions,
    })

    const ctx: Nats.Context = {
      name,
      priority: options.priority ?? DEFAULT_PRIORITY,
      prefix,
      queueGroup: options.queueGroup ?? 'default',
      scope,
      log: log.child({ transport: name }),
      broker,
      nc,
      js: jetstream(nc),
      jsm: manager.value,
      subjects,
      streams,
      jetstream: jetstreamOptions,
      events: eventsOptions,
      diagnostics: { laneRetries: 0, laneFailures: [] },
      hostsCache: new Map(),
      owners: new Map(),
    }

    yield* NatsRef.set(ctx)

    yield* fork(() => box(() => statusPump(ctx)))
    yield* fork(() => box(() => eventPump(ctx)))

    if (ctx.events.durable) {
      // the durable is ensured INLINE so a broken events config fails the install loudly;
      // only the consume loop is a background pump
      yield* ensureEventConsumer(ctx)
      yield* fork(() => box(() => durableEventPump(ctx)))
    }

    // OWNER side: consume for everything already registered, then follow the registry live
    for (const service of ctx.broker.registry.keys()) {
      yield* ensureOwner(ctx, service)
    }

    const offRegistered = ctx.broker.bus.on('service.registered', payload => {
      const service = nameOf(payload)

      if (service) {
        void runSafe(ctx.scope, () => ensureOwner(ctx, service))
      }
    })
    const offUnregistered = ctx.broker.bus.on('service.unregistered', payload => {
      const service = nameOf(payload)

      if (service) {
        stopOwner(ctx, service)
      }
    })

    yield* ensure(() => {
      offRegistered()
      offUnregistered()
    })

    // routing table entry LAST — dispatches only route here once everything above is live
    yield* Transport.actions.register({
      name,
      priority: ctx.priority,
      actions: transportActions,
    })
    yield* ensure(() => Transport.actions.unregister(name))

    yield* ctx.log.info('nats transport ready', {
      transport: name,
      prefix,
      queueGroup: ctx.queueGroup,
      nodeId: broker.nodeId,
      server: nc.getServer(),
    })

    return ctx
  },
})

/**
 * The NATS carrier for the broker: dispatches ride a JetStream workqueue (one shared durable per
 * service = cluster-wide load balancing), replies/acks/cancels ride per-cid core inboxes, stream
 * replies ride the LANE stream, and undeliverable/cancelled outcomes land in the OUTCOME stream —
 * queryable via `NatsTransport.actions.outcome(cid)`. Events are core pub/sub (at-most-once).
 * All timing lives in the broker's fulfillment wrapper; this carrier never installs timeouts.
 */
export const NatsTransport = NatsTransportImpl.build({
  ...transportActions,
  outcome: outcomeAction,
  diagnostics: diagnosticsAction,
})
