import type { BrokerDef, Service } from 'server:core'
import { Broker } from 'server:core'
import { forEachSubscriptionEvent, spawn, useContext } from 'std:effect'
import { useBufferedEvent } from 'std:event'
import { asFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { consume } from './consume'
import { useNatsContext } from './context'
import { handleDispatch } from './handlers'
import { dispatchServicePrefix, dispatchSubject } from './subjects'

const subscribeService = function* (service: Service) {
  const nats = yield* useNatsContext()

  for (const key of service.getKeys()) {
    const subject = dispatchSubject(nats.prefix, service.name, key)
    if (nats.subscriptions.has(subject)) {
      continue
    }

    const sub = nats.queueGroup
      ? nats.connection.subscribe(subject, { queue: nats.queueGroup })
      : nats.connection.subscribe(subject)

    nats.subscriptions.set(subject, sub)

    yield* consume(sub, handleDispatch(service, key))
  }
}

const unsubscribeService = function* (target: Service | string) {
  const nats = yield* useNatsContext()
  const serviceName = typeof target === 'string' ? (target.split('@')[0] ?? target) : target.name

  const prefix = dispatchServicePrefix(nats.prefix, serviceName)

  for (const [subject, sub] of nats.subscriptions) {
    if (!subject.startsWith(prefix)) {
      continue
    }
    nats.subscriptions.delete(subject)
    if (!sub.isClosed()) {
      sub.unsubscribe()
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
