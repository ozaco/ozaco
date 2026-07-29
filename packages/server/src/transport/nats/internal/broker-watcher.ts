import type { BrokerDef, Service } from 'server:core'
import { Broker } from 'server:core'
import { attempt, forEachSubscriptionEvent, spawn, until, useContext } from 'std:effect'
import { useBufferedEvent } from 'std:event'
import { Logger } from 'std:logger'
import { asFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { streamNames } from '../const'

import { consume } from './consume'
import { useNatsContext } from './context'
import { handleDispatch } from './handlers'
import { ensureRpcConsumer } from './provision'
import { isUnsafeToken, rpcDurable, rpcServicePrefix, rpcSubject } from './subjects'

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
    const ready = yield* attempt(function* () {
      yield* ensureRpcConsumer(nats.jsm, nats.prefix, durable, subject)
      const consumer = yield* until(
        nats.js.consumers.get(streamNames(nats.prefix).rpc, durable),
        `nats:rpc-consumer ${durable}`,
      )
      return yield* until(consumer.consume(), `nats:rpc-consume ${durable}`)
    })

    if (!isSuccess(ready)) {
      if ((yield* Logger.context.get()) !== undefined) {
        yield* Logger.actions.error(
          `nats: NOT serving "${service.name}.${key}": ${ready.message || String(ready.error)}`,
        )
      }
      continue
    }

    const messages = ready.value

    nats.consumers.set(subject, messages)

    yield* consume(messages, handleDispatch(service, key))
  }
}

const unsubscribeService = function* (target: Service | string) {
  const nats = yield* useNatsContext()
  const serviceName = typeof target === 'string' ? (target.split('@')[0] ?? target) : target.name

  const prefix = rpcServicePrefix(nats.prefix, serviceName)

  // Stop CONSUMING; never delete the durable. Another replica may be bound to it right now, and
  // an address's durable outliving its last local subscriber is what lets a replacement pod pick
  // up where this one left off.
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
