import { attempt, operation, until } from 'std:effect'
import { fail, isSuccess } from 'std:result'

import type { ConsumerInfo, JetStreamManager, StreamConfig } from 'nats'
import { AckPolicy, DiscardPolicy, RetentionPolicy, StorageType } from 'nats'

import {
  EVENT_MAX_AGE_NS,
  LANE_MAX_AGE_NS,
  RPC_INACTIVE_THRESHOLD_NS,
  RPC_MAX_AGE_NS,
  RPC_MAX_DELIVER,
  streamNames,
} from '../const'
import { NatsErrors } from '../errors'

import { eventPrefix, lanePrefix, rpcPrefix } from './subjects'

/** Does a consumer filter (which may hold `*`/`>`, or be absent = everything) cover `subject`? */
const covers = (pattern: string, subject: string): boolean => {
  const patternTokens = pattern.split('.')
  const subjectTokens = subject.split('.')
  for (const [index, token] of patternTokens.entries()) {
    if (token === '>') {
      return true
    }
    if (index >= subjectTokens.length || (token !== '*' && token !== subjectTokens[index])) {
      return false
    }
  }
  return patternTokens.length === subjectTokens.length
}

const overlapsAddress = (info: ConsumerInfo, subject: string): boolean => {
  const config = info.config as { filter_subject?: string; filter_subjects?: string[] }
  const filters = config.filter_subjects ?? (config.filter_subject ? [config.filter_subject] : [])
  return filters.length === 0 || filters.some(pattern => covers(pattern, subject))
}

const listConsumers = async (jsm: JetStreamManager, stream: string): Promise<ConsumerInfo[]> => {
  const out: ConsumerInfo[] = []
  for await (const info of jsm.consumers.list(stream)) {
    out.push(info)
  }
  return out
}

/**
 * Create the three streams, idempotently.
 *
 * `add` on an existing stream with the same config is a no-op, and with a DIFFERENT config it is an
 * error — which is the behaviour worth having: two nodes racing to create the same stream both
 * succeed, while a node built against a changed wire refuses to start rather than half-speaking the
 * new one. That is also why the stream name carries the subject prefix: two apps on one server get
 * two sets of streams instead of quietly sharing subjects.
 *
 * `replicas` is the one deliberate exception: an existing stream whose replica count differs from
 * the requested one is UPDATED in place. Scaling R1 streams to R3 after the server grew into a
 * cluster is an operational act, not a wire change — refusing to start would leave no path from
 * one to the other.
 */
export const provision = operation(function* (
  jsm: JetStreamManager,
  prefix: string,
  replicas?: number,
) {
  const names = streamNames(prefix)
  const replication = replicas === undefined ? {} : { num_replicas: replicas }

  const attempts: [string, Partial<StreamConfig>][] = [
    [
      names.rpc,
      {
        subjects: [`${rpcPrefix(prefix)}>`],
        // work-queue: a message leaves the stream once a consumer acks it, so exactly one owner
        // takes each call even when a whole replica set is subscribed
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.Memory,
        discard: DiscardPolicy.Old,
        max_age: RPC_MAX_AGE_NS,
        ...replication,
      },
    ],
    [
      names.lane,
      {
        subjects: [`${lanePrefix(prefix)}>`],
        // limits, NOT work-queue: a lane has exactly one reader, and it must be able to start
        // reading after the writer began. That replay is the whole reason this is JetStream.
        retention: RetentionPolicy.Limits,
        storage: StorageType.Memory,
        discard: DiscardPolicy.Old,
        max_age: LANE_MAX_AGE_NS,
        ...replication,
      },
    ],
    [
      names.event,
      {
        subjects: [`${eventPrefix(prefix)}>`],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        discard: DiscardPolicy.Old,
        max_age: EVENT_MAX_AGE_NS,
        ...replication,
      },
    ],
  ]

  for (const [name, config] of attempts) {
    // An existing stream answers `stream name already in use`; anything else is a real fault.
    yield* until(
      jsm.streams.add({ name, ...config }).catch(async (error: unknown) => {
        const message = String((error as { message?: string })?.message ?? error)
        if (!message.includes('already in use') && !message.includes('already exists')) {
          throw error
        }
        if (replicas === undefined) {
          return undefined
        }
        // the stream exists — when its live replica count is not the requested one, scale it
        const info = await jsm.streams.info(name)
        if (info.config.num_replicas === replicas) {
          return undefined
        }
        return jsm.streams.update(name, { ...info.config, num_replicas: replicas })
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
 *
 * Every RPC durable carries {@link RPC_INACTIVE_THRESHOLD_NS}: a bound replica's pull loop is
 * permanent interest, so a live consumer is never touched — but the durable of a release that is
 * fully gone retires on its own instead of blocking the address forever and answering `hosts()`
 * for nobody. A durable from before this existed is converged by the `update` on the exists path.
 */
// oxlint-disable-next-line max-params
export const ensureRpcConsumer = operation(function* (
  jsm: JetStreamManager,
  prefix: string,
  durable: string,
  filter: string,
) {
  const stream = streamNames(prefix).rpc
  const created = yield* attempt(
    until(
      jsm.consumers
        .add(stream, {
          durable_name: durable,
          filter_subject: filter,
          ack_policy: AckPolicy.Explicit,
          max_deliver: RPC_MAX_DELIVER,
          ack_wait: RPC_MAX_AGE_NS,
          inactive_threshold: RPC_INACTIVE_THRESHOLD_NS,
        })
        .then(() => 'created' as const)
        .catch((error: unknown) => {
          const message = String((error as { message?: string })?.message ?? error)
          if (message.includes('already in use') || message.includes('already exists')) {
            return 'exists' as const
          }
          throw error
        }),
      `nats:consumer ${durable}`,
    ),
  )
  if (isSuccess(created)) {
    if (created.value === 'exists') {
      // a durable created before expiry existed lives forever — converge it (no-op when current)
      yield* attempt(
        until(
          jsm.consumers.update(stream, durable, {
            inactive_threshold: RPC_INACTIVE_THRESHOLD_NS,
          }),
          `nats:consumer-converge ${durable}`,
        ),
      )
    }
    return
  }
  /**
   * A work-queue stream refuses a second consumer whose filter overlaps an existing one's — a
   * durable left behind by an older release's naming scheme, or another app on the same prefix.
   *
   * Never delete the blocker here: only the SERVER knows whether someone is still bound to it, and
   * deleting a live old replica's consumer mid-drain would hand its unacked calls to this node — a
   * second execution of a body that already ran. Instead ARM expiry on it and report the conflict;
   * a blocker whose owner lives (surged rolling deploy) keeps interest and survives untouched until
   * it exits, one whose owner is gone is retired within the threshold — and the watcher's reclaim
   * loop then claims the address with no human involved.
   */
  const message = String(
    (created.error as { message?: string } | undefined)?.message ?? created.error,
  )
  if (
    message.includes('not unique on workqueue') ||
    message.includes('multiple non-filtered consumers')
  ) {
    yield* attempt(function* () {
      const consumers = yield* until(listConsumers(jsm, stream), `nats:consumer-list ${stream}`)
      for (const blocker of consumers) {
        if (blocker.name === durable || !overlapsAddress(blocker, filter)) {
          continue
        }
        yield* attempt(
          until(
            jsm.consumers.update(stream, blocker.name, {
              inactive_threshold: RPC_INACTIVE_THRESHOLD_NS,
            }),
            `nats:consumer-arm ${blocker.name}`,
          ),
        )
      }
    })
    return yield* fail(
      NatsErrors.ConsumerConflict,
      `work-queue consumer conflict on "${filter}": the RPC stream already has a consumer covering this subject that is not this release's durable "${durable}". Expiry is armed on the blocker — once its owner is gone for ${RPC_INACTIVE_THRESHOLD_NS / 1_000_000_000}s the server retires it and this node claims the address automatically. A conflict that persists means the blocker is live: typically two apps sharing the prefix "${prefix}".`,
    )
  }
  return yield* created
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
