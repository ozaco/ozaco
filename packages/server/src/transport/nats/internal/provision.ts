import { attempt, operation, until } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { DiscardPolicy, RetentionPolicy, StorageType } from '@nats-io/jetstream'
import type { JetStreamManager, StreamConfig, StreamUpdateConfig } from '@nats-io/jetstream'
import { nanos } from '@nats-io/nats-core'

import { NatsErrors } from '../errors'
import type { Nats } from '../types'

import { causesOf } from './failure'

type StreamSpec = Partial<StreamConfig> & { name: string }

/** The msgID dedupe window (capped so memory streams stay small on long max ages). */
const DEDUPE_CAP_MS = 120_000

/** Create-or-update: `add` wins on first boot and on identical config; drift falls to `update`. */
const ensureStream = operation(function* (jsm: JetStreamManager, spec: StreamSpec) {
  const added = yield* attempt(() => until(jsm.streams.add(spec)))

  if (!isFailure(added)) {
    return
  }

  const updated = yield* attempt(() =>
    until(jsm.streams.update(spec.name, spec as Partial<StreamUpdateConfig>)),
  )

  if (isFailure(updated)) {
    return yield* fail(
      NatsErrors.Jetstream,
      `stream "${spec.name}" could not be provisioned`,
      ...causesOf(added),
      ...causesOf(updated),
    )
  }
})

export interface ProvisionInput {
  readonly jsm: JetStreamManager
  readonly streams: Nats.StreamNames
  readonly subjects: Nats.Subjects
  readonly options: Nats.JetStreamResolved
  readonly events: Nats.EventsResolved
}

/**
 * Provisions the carrier streams idempotently: RPC/LANE/OUTCOME always, `<P>_EVENT` only with
 * `events.durable` — otherwise events ride core NATS pub/sub (at-most-once, invalidation
 * semantics) with no stream at all.
 */
export const provisionStreams = operation(function* ({
  jsm,
  streams,
  subjects,
  options,
  events,
}: ProvisionInput) {
  const storage = options.storage === 'file' ? StorageType.File : StorageType.Memory
  const num_replicas = Math.max(1, options.replicas)

  // RPC: a workqueue — a dispatch survives until exactly one owner instance consumes it. The
  // duplicate window turns `msgID: idempotencyKey` into the cross-broker double-execution guard.
  yield* ensureStream(jsm, {
    name: streams.rpc,
    subjects: [subjects.rpcWild],
    retention: RetentionPolicy.Workqueue,
    storage,
    num_replicas,
    max_age: nanos(options.rpcMaxAgeMs),
    duplicate_window: nanos(Math.min(options.rpcMaxAgeMs, DEDUPE_CAP_MS)),
  })

  // LANE: a WORKQUEUE with `discard: new` — frames survive until the single per-lane reader acks
  // them (late attach loses nothing; ack = delete = space freed), and once unacked bytes reach
  // `laneMaxBytes` the stream REJECTS publishes (err 10077 "maximum bytes exceeded", probed on
  // nats-server 2.14.5) so `publishLaneFrame` parks: end-to-end backpressure. `max_age` stays the
  // abandoned-lane sweeper for frames nobody ever acked.
  yield* ensureStream(jsm, {
    name: streams.lane,
    subjects: [subjects.laneWild],
    retention: RetentionPolicy.Workqueue,
    discard: DiscardPolicy.New,
    storage,
    num_replicas,
    max_age: nanos(options.laneMaxAgeMs),
    max_bytes: options.laneMaxBytes,
  })

  // OUTCOME: last-write-wins per cid, TTL'd — the owner-side truth behind `outcome(cid)`.
  yield* ensureStream(jsm, {
    name: streams.outcome,
    subjects: [subjects.outcomeWild],
    retention: RetentionPolicy.Limits,
    storage,
    num_replicas,
    max_age: nanos(options.outcomeTtlMs),
    max_msgs_per_subject: 1,
    duplicate_window: nanos(Math.min(options.outcomeTtlMs, DEDUPE_CAP_MS)),
  })

  // EVENT (opt-in): durable broadcasts. Limits retention — every queue group's durable consumer
  // reads the same history; `max_age` bounds how far back a late-attaching group catches up.
  if (events.durable) {
    yield* ensureStream(jsm, {
      name: streams.event,
      subjects: [subjects.eventWild],
      retention: RetentionPolicy.Limits,
      storage: events.storage === 'memory' ? StorageType.Memory : StorageType.File,
      num_replicas,
      max_age: nanos(events.maxAgeMs),
    })
  }
})
