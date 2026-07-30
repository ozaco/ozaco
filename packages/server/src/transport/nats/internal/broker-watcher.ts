import type { BrokerDef, Service } from 'server:core'
import { Broker } from 'server:core'
import {
  attempt,
  forEachSubscriptionEvent,
  sleep,
  spawn,
  suspend,
  until,
  useContext,
} from 'std:effect'
import { useBufferedEvent } from 'std:event'
import { Logger } from 'std:logger'
import { asFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { RECLAIM_INTERVAL_MS, RECLAIM_LOG_EVERY, streamNames } from '../const'
import { NatsErrors } from '../errors'

import { consume } from './consume'
import { useNatsContext } from './context'
import { handleDispatch } from './handlers'
import { ensureRpcConsumer } from './provision'
import { isUnsafeToken, rpcDurable, rpcServicePrefix, rpcSubject } from './subjects'

/** Bind one address end to end: durable ensured, consumer bound, dispatch loop consuming. The
 * consume lives in the CALLER's scope — the registration watcher for a first-try bind, the reclaim
 * task for a claimed one — so whoever started it also owns tearing it down. */
// oxlint-disable-next-line max-params
const bindAddress = function* (service: Service, key: string, subject: string, durable: string) {
  const nats = yield* useNatsContext()

  yield* ensureRpcConsumer(nats.jsm, nats.prefix, durable, subject)
  const consumer = yield* until(
    nats.js.consumers.get(streamNames(nats.prefix).rpc, durable),
    `nats:rpc-consumer ${durable}`,
  )
  const messages = yield* until(consumer.consume(), `nats:rpc-consume ${durable}`)

  nats.consumers.set(subject, messages)
  yield* consume(messages, handleDispatch(service, key))
}

/**
 * Claim a conflicted address in the background — quiet, slow, forever.
 *
 * `ensureRpcConsumer` already armed expiry on whatever blocks the address, so the normal outcome is
 * a claim within ~one threshold of the blocker's owner leaving: a surged rolling deploy heals when
 * the old replica exits, a durable abandoned by an older naming scheme heals on the first tick
 * after the server retires it. The one blocker that never goes idle is a LIVE foreign owner (two
 * apps sharing a prefix) — that keeps failing, and the periodic error is the correct noise.
 *
 * Parking forever after a claim is deliberate: the consume started by `bindAddress` lives in THIS
 * task's scope, so `unsubscribeService`/teardown halting the task is what ends the subscription.
 */
// oxlint-disable-next-line max-params
const reclaimAddress = function* (service: Service, key: string, subject: string, durable: string) {
  for (let tick = 1; ; tick++) {
    yield* sleep(RECLAIM_INTERVAL_MS)

    const nats = yield* useNatsContext()
    if (nats.consumers.has(subject)) {
      return // bound elsewhere meanwhile (a re-registration won the race)
    }

    const ready = yield* attempt(() => bindAddress(service, key, subject, durable))
    if (isSuccess(ready)) {
      if ((yield* Logger.context.get()) !== undefined) {
        yield* Logger.actions.info(
          `nats: claimed "${service.name}.${key}" after ${(tick * RECLAIM_INTERVAL_MS) / 1000}s — the blocking consumer is gone`,
        )
      }
      return yield* suspend()
    }

    if (tick % RECLAIM_LOG_EVERY === 0 && (yield* Logger.context.get()) !== undefined) {
      yield* Logger.actions.error(
        `nats: still NOT serving "${service.name}.${key}" after ${(tick * RECLAIM_INTERVAL_MS) / 1000}s: ${ready.message || String(ready.error)}`,
      )
    }
  }
}

const subscribeService = function* (service: Service) {
  const nats = yield* useNatsContext()

  for (const [key] of yield* service.actions._list()) {
    // Checked at REGISTRATION, because by dispatch time the consumer already exists. A service
    // literally named `>` would otherwise subscribe to the entire cluster.
    if (isUnsafeToken(service.name) || isUnsafeToken(key)) {
      if ((yield* Logger.context.get()) !== undefined) {
        yield* Logger.actions.warn(
          'nats:unsafe-address',
          `refusing to serve "${service.name}.${key}" — the address contains a subject wildcard`,
        )
      }
      continue
    }

    const subject = rpcSubject(nats.prefix, service.name, key)
    if (nats.consumers.has(subject)) {
      continue
    }

    /**
     * One DURABLE per address, shared by every replica: the work-queue hands each call to exactly
     * one of them, which is what the old per-connection queue group approximated — except this one
     * also answers `hosts()` truthfully, because the consumer's existence is inspectable.
     *
     * Attempted PER ADDRESS, and a failure is REPORTED, not thrown: this generator runs inside the
     * spawned registration watcher, where an escaping failure kills the watcher itself — the pod
     * then looks booted while none of its later services ever subscribe and every call parked on
     * the work queue silently ages out. One bad address (a consumer conflict from a surged rolling
     * deploy, a config drift) must cost that address, loudly, and nothing else.
     */
    const durable = rpcDurable(nats.prefix, service.name, key)
    const ready = yield* attempt(() => bindAddress(service, key, subject, durable))

    if (!isSuccess(ready)) {
      if ((yield* Logger.context.get()) !== undefined) {
        yield* Logger.actions.error(
          `nats: NOT serving "${service.name}.${key}": ${ready.message || String(ready.error)}`,
        )
      }
      // A consumer conflict is transient by construction now — expiry is armed on the blockers, so
      // the address heals the moment the server retires them. Keep claiming in the background.
      if (ready.error === NatsErrors.ConsumerConflict && !nats.reclaims.has(subject)) {
        const task = yield* spawn(() => reclaimAddress(service, key, subject, durable))
        nats.reclaims.set(subject, task)
      }
      continue
    }
  }
}

const unsubscribeService = function* (target: Service | string) {
  const nats = yield* useNatsContext()
  const serviceName = typeof target === 'string' ? (target.split('@')[0] ?? target) : target.name

  const prefix = rpcServicePrefix(nats.prefix, serviceName)

  // Stop CONSUMING; never delete the durable. Another replica may be bound to it right now, and
  // an address's durable outliving its last local subscriber is what lets a replacement pod pick
  // up where this one left off. Stopped BEFORE the reclaim tasks are halted: halting a task whose
  // consume is parked inside `into(<live iterator>)` wedges the unwind — the stop releases it.
  const stopConsumers = () => {
    for (const [subject, messages] of nats.consumers) {
      if (!subject.startsWith(prefix)) {
        continue
      }
      nats.consumers.delete(subject)
      try {
        messages.stop()
      } catch {
        /* already stopped */
      }
    }
  }
  stopConsumers()

  // A pending background claim must die with its service — left alone it would eventually bind
  // and consume for a service the broker no longer runs.
  for (const [subject, task] of nats.reclaims) {
    if (!subject.startsWith(prefix)) {
      continue
    }
    nats.reclaims.delete(subject)
    yield* attempt(() => task.halt())
  }

  // a reclaim that bound between the two sweeps left a fresh live consumer — stop those too
  stopConsumers()
}

export const brokerWathcer = function* () {
  let brokerCtx: BrokerDef.Context

  try {
    brokerCtx = yield* useContext(Broker)
  } catch (error) {
    const failure = asFailure(error)
    ;(failure as AnyType).message = 'install transport after broker'

    return yield* failure
  }

  const onRegister = yield* useBufferedEvent(brokerCtx.bus, 'service.registered')
  const onUnregister = yield* useBufferedEvent(brokerCtx.bus, 'service.unregistered')

  yield* spawn(() => forEachSubscriptionEvent(onRegister, ([service]) => subscribeService(service)))
  yield* spawn(() =>
    forEachSubscriptionEvent(onUnregister, ([target]) => unsubscribeService(target)),
  )
}
