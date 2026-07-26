import { operation, until } from 'std:effect'
import { fail } from 'std:result'

import type { JetStreamManager } from 'nats'
import { AckPolicy, DiscardPolicy, RetentionPolicy, StorageType } from 'nats'

import {
  EVENT_MAX_AGE_NS,
  LANE_MAX_AGE_NS,
  RPC_MAX_AGE_NS,
  RPC_MAX_DELIVER,
  streamNames,
} from '../const'
import { NatsErrors } from '../errors'

import { eventPrefix, lanePrefix, rpcPrefix } from './subjects'

/**
 * Create the three streams, idempotently.
 *
 * `add` on an existing stream with the same config is a no-op, and with a DIFFERENT config it is an
 * error — which is the behaviour worth having: two nodes racing to create the same stream both
 * succeed, while a node built against a changed wire refuses to start rather than half-speaking the
 * new one. That is also why the stream name carries the subject prefix: two apps on one server get
 * two sets of streams instead of quietly sharing subjects.
 */
export const provision = operation(function* (jsm: JetStreamManager, prefix: string) {
  const names = streamNames(prefix)

  const attempts: [string, () => Promise<unknown>][] = [
    [
      names.rpc,
      () =>
        jsm.streams.add({
          name: names.rpc,
          subjects: [`${rpcPrefix(prefix)}>`],
          // work-queue: a message leaves the stream once a consumer acks it, so exactly one owner
          // takes each call even when a whole replica set is subscribed
          retention: RetentionPolicy.Workqueue,
          storage: StorageType.Memory,
          discard: DiscardPolicy.Old,
          max_age: RPC_MAX_AGE_NS,
        }),
    ],
    [
      names.lane,
      () =>
        jsm.streams.add({
          name: names.lane,
          subjects: [`${lanePrefix(prefix)}>`],
          // limits, NOT work-queue: a lane has exactly one reader, and it must be able to start
          // reading after the writer began. That replay is the whole reason this is JetStream.
          retention: RetentionPolicy.Limits,
          storage: StorageType.Memory,
          discard: DiscardPolicy.Old,
          max_age: LANE_MAX_AGE_NS,
        }),
    ],
    [
      names.event,
      () =>
        jsm.streams.add({
          name: names.event,
          subjects: [`${eventPrefix(prefix)}>`],
          retention: RetentionPolicy.Limits,
          storage: StorageType.File,
          discard: DiscardPolicy.Old,
          max_age: EVENT_MAX_AGE_NS,
        }),
    ],
  ]

  for (const [name, add] of attempts) {
    // An existing stream answers `stream name already in use`; anything else is a real fault.
    yield* until(
      add().catch((error: unknown) => {
        const message = String((error as { message?: string })?.message ?? error)
        if (message.includes('already in use') || message.includes('already exists')) {
          return undefined
        }
        throw error
      }),
      `nats:provision ${name}`,
    )
  }

  return names
})

/**
 * The durable consumer one address answers on.
 *
 * Durable and named after the address, so every replica of a service shares ONE consumer and the
 * work-queue hands each call to exactly one of them. `max_deliver: 1` is what makes that at most
 * once rather than at least once — see the note on {@link RPC_MAX_DELIVER}.
 */
// oxlint-disable-next-line max-params
export const ensureRpcConsumer = operation(function* (
  jsm: JetStreamManager,
  prefix: string,
  durable: string,
  filter: string,
) {
  yield* until(
    jsm.consumers
      .add(streamNames(prefix).rpc, {
        durable_name: durable,
        filter_subject: filter,
        ack_policy: AckPolicy.Explicit,
        max_deliver: RPC_MAX_DELIVER,
        ack_wait: RPC_MAX_AGE_NS,
      })
      .catch((error: unknown) => {
        const message = String((error as { message?: string })?.message ?? error)
        if (message.includes('already in use') || message.includes('already exists')) {
          return undefined
        }
        throw error
      }),
    `nats:consumer ${durable}`,
  )
})

/**
 * The durable consumer a GROUP shares for queued events.
 *
 * Every member binds the same durable, so the EVENT stream hands each queued event to exactly one
 * of them — and because the stream is file-backed, a group whose members all restarted picks up
 * what was published while nobody was around.
 */
// oxlint-disable-next-line max-params
export const ensureEventConsumer = operation(function* (
  jsm: JetStreamManager,
  prefix: string,
  durable: string,
  filter: string,
) {
  yield* until(
    jsm.consumers
      .add(streamNames(prefix).event, {
        durable_name: durable,
        filter_subject: filter,
        ack_policy: AckPolicy.Explicit,
      })
      .catch((error: unknown) => {
        const message = String((error as { message?: string })?.message ?? error)
        if (message.includes('already in use') || message.includes('already exists')) {
          return undefined
        }
        throw error
      }),
    `nats:consumer ${durable}`,
  )
})

/**
 * Refuse to start against a server without JetStream, and say so plainly.
 *
 * The alternative — degrading to core NATS — would mean the same code silently offering a weaker
 * delivery guarantee depending on how the broker happens to be configured, which is the class of
 * difference nobody notices until a message goes missing in production.
 */
export const requireJetStream = operation(function* (jsm: JetStreamManager) {
  const ok = yield* until(
    jsm
      .getAccountInfo()
      .then(() => true)
      .catch(() => false),
    'nats:account-info',
  )

  if (!ok) {
    return yield* fail(
      NatsErrors.NoJetstream,
      'this transport needs JetStream; start the server with -js or enable it in the config',
    )
  }
})
